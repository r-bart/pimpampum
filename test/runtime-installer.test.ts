import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installRuntime,
  prepareOwnedRuntimeRemoval,
  pruneOwnedRuntimeVersions,
} from '../src/runtime/installer.js';
import { resolveRuntimeLayout } from '../src/runtime/layout.js';
import type { RuntimeManifest } from '../src/runtime/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-runtime-installer-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function candidate(root: string, version: string) {
  const sourceDirectory = join(root, `candidate-${version}`);
  const contents = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': `export const version = ${JSON.stringify(version)};\n`,
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'native-addon-arm64',
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(sourceDirectory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: path === 'bin/node' ? 0o755 : 0o644 });
  }
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    pimpampumVersion: version,
    nodeVersion: '24.19.0',
    target: { platform: 'darwin', architecture: 'arm64' },
    unpackedBytes: Object.values(contents).reduce(
      (total, content) => total + Buffer.byteLength(content),
      0,
    ),
    entrypoints: { node: 'bin/node', cli: 'dist/cli.js', mcp: 'dist/mcpStdio.js' },
    files: Object.entries(contents).map(([path, content]) => ({
      path,
      sha256: sha256(content),
      mode: path === 'bin/node' ? 0o755 : 0o644,
      size: Buffer.byteLength(content),
    })),
  };
  return { sourceDirectory, manifest };
}

function installInput(root: string, version: string) {
  return {
    homeDirectory: join(root, 'home'),
    dataDirectory: join(root, 'data'),
    platform: 'darwin' as const,
    architecture: 'arm64' as const,
    ...candidate(root, version),
  };
}

describe('atomic runtime installer', () => {
  it('smokes staging, atomically activates, and writes regular absolute launchers', async () => {
    const root = temporaryDirectory('install');
    const input = installInput(root, '2.0.0');
    const smoke = vi.fn(async (installation: { nodePath: string }) => {
      expect(installation.nodePath).toContain('/Runtime/2.0.0/.pimpampum-stage-');
      expect(existsSync(installation.nodePath)).toBe(true);
    });

    const result = await installRuntime({ ...input, smoke });

    expect(result).toMatchObject({ activated: true, version: '2.0.0', previousVersion: null });
    expect(smoke).toHaveBeenCalledOnce();
    expect(lstatSync(result.mcpLauncherPath).isFile()).toBe(true);
    expect(lstatSync(result.mcpLauncherPath).isSymbolicLink()).toBe(false);
    expect(lstatSync(result.mcpLauncherPath).mode & 0o111).not.toBe(0);
    const launcher = readFileSync(result.mcpLauncherPath, 'utf8');
    expect(launcher).toContain(result.nodePath);
    expect(launcher).toContain('/Runtime/2.0.0/darwin-arm64/dist/mcpStdio.js');
    expect(launcher).not.toMatch(/token|npx|current/iu);
    expect(
      readFileSync(join(input.dataDirectory, 'runtime-install-receipt.json'), 'utf8'),
    ).not.toMatch(/token/iu);
  });

  it('preserves the previous runtime and launcher when staged smoke fails', async () => {
    const root = temporaryDirectory('rollback');
    const first = installInput(root, '1.9.0');
    const installed = await installRuntime({ ...first, smoke: async () => undefined });
    const previousLauncher = readFileSync(installed.mcpLauncherPath, 'utf8');
    const second = installInput(root, '2.0.0');

    await expect(
      installRuntime({
        ...second,
        smoke: async () => {
          throw new Error('staged SQLite failed');
        },
      }),
    ).rejects.toThrow('staged SQLite failed');

    expect(existsSync(installed.nodePath)).toBe(true);
    expect(readFileSync(installed.mcpLauncherPath, 'utf8')).toBe(previousLauncher);
    expect(
      existsSync(join(second.homeDirectory, 'Library/Application Support/Pimpampum/Runtime/2.0.0')),
    ).toBe(false);
  });

  it('is idempotent and self-heals receipt-owned interrupted staging', async () => {
    const root = temporaryDirectory('repeat');
    const input = installInput(root, '2.0.0');
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '2.0.0',
    });
    const interrupted = join(dirname(layout.versionDirectory), '.pimpampum-stage-interrupted');
    mkdirSync(interrupted, { recursive: true });
    writeFileSync(
      join(interrupted, 'staging-owner.json'),
      '{"schemaVersion":1,"owner":"pimpampum-runtime-installer"}\n',
    );
    writeFileSync(join(interrupted, 'partial'), 'partial');

    await installRuntime({ ...input, smoke: async () => undefined });
    const repeatedSmoke = vi.fn(async () => undefined);
    const repeated = await installRuntime({ ...input, smoke: repeatedSmoke });

    expect(existsSync(interrupted)).toBe(false);
    expect(repeated).toMatchObject({
      activated: false,
      version: '2.0.0',
      previousVersion: '2.0.0',
    });
    expect(repeatedSmoke).toHaveBeenCalledOnce();
  });

  it('rejects extra files and symlinks before invoking smoke', async () => {
    const root = temporaryDirectory('hostile');
    const extra = installInput(root, '2.0.0');
    writeFileSync(join(extra.sourceDirectory, 'extra'), 'unexpected');
    const smoke = vi.fn(async () => undefined);
    await expect(installRuntime({ ...extra, smoke })).rejects.toThrow(/unexpected files/iu);
    expect(smoke).not.toHaveBeenCalled();

    const linked = installInput(root, '2.1.0');
    symlinkSync('/tmp', join(linked.sourceDirectory, 'unsafe-link'));
    await expect(installRuntime({ ...linked, smoke })).rejects.toThrow(/symlink/iu);
    expect(smoke).not.toHaveBeenCalled();

    const danglingLauncher = installInput(root, '2.2.0');
    const danglingLayout = resolveRuntimeLayout({
      homeDirectory: danglingLauncher.homeDirectory,
      platform: danglingLauncher.platform,
      architecture: danglingLauncher.architecture,
      version: '2.2.0',
    });
    mkdirSync(dirname(danglingLayout.mcpLauncherPath), { recursive: true });
    symlinkSync(join(root, 'missing-launcher-target'), danglingLayout.mcpLauncherPath);
    await expect(installRuntime({ ...danglingLauncher, smoke })).rejects.toThrow(
      /ownership receipt|symlink/iu,
    );
    expect(lstatSync(danglingLayout.mcpLauncherPath).isSymbolicLink()).toBe(true);
    expect(smoke).not.toHaveBeenCalled();
    rmSync(danglingLayout.mcpLauncherPath, { force: true });

    const forgedStage = installInput(root, '2.3.0');
    const forgedLayout = resolveRuntimeLayout({
      homeDirectory: forgedStage.homeDirectory,
      platform: forgedStage.platform,
      architecture: forgedStage.architecture,
      version: '2.3.0',
    });
    const forgedDirectory = join(dirname(forgedLayout.versionDirectory), '.pimpampum-stage-forged');
    mkdirSync(forgedDirectory, { recursive: true });
    writeFileSync(
      join(forgedDirectory, 'staging-owner.json'),
      '{"schemaVersion":1,"owner":"pimpampum-runtime-installer","extra":true}\n',
    );
    await expect(installRuntime({ ...forgedStage, smoke })).rejects.toThrow(/receipt-owned/iu);
    expect(existsSync(forgedDirectory)).toBe(true);

    const symlinkedData = installInput(root, '2.4.0');
    symlinkedData.dataDirectory = join(root, 'symlinked-data');
    const dataTarget = join(root, 'data-target');
    mkdirSync(dataTarget);
    symlinkSync(dataTarget, symlinkedData.dataDirectory);
    await expect(installRuntime({ ...symlinkedData, smoke })).rejects.toThrow(
      /regular directory/iu,
    );
    expect(lstatSync(symlinkedData.dataDirectory).isSymbolicLink()).toBe(true);

    const danglingDestination = installInput(root, '2.5.0');
    danglingDestination.homeDirectory = join(root, 'destination-home');
    danglingDestination.dataDirectory = join(root, 'destination-data');
    const destinationLayout = resolveRuntimeLayout({
      homeDirectory: danglingDestination.homeDirectory,
      platform: danglingDestination.platform,
      architecture: danglingDestination.architecture,
      version: '2.5.0',
    });
    mkdirSync(dirname(destinationLayout.versionDirectory), { recursive: true });
    symlinkSync(join(root, 'missing-runtime-target'), destinationLayout.versionDirectory);
    await expect(installRuntime({ ...danglingDestination, smoke })).rejects.toThrow(
      /ownership receipt|regular directory/iu,
    );
    expect(lstatSync(destinationLayout.versionDirectory).isSymbolicLink()).toBe(true);
  });

  it('quotes launcher paths and forwards arguments without shell evaluation', async () => {
    const root = temporaryDirectory('launcher-quoting');
    const input = installInput(root, '2.0.0');
    input.homeDirectory = join(root, "home's $(not-a-command) space");

    const result = await installRuntime({ ...input, smoke: async () => undefined });

    expect(() =>
      execFileSync(result.mcpLauncherPath, ['argument with spaces', "quote'"]),
    ).not.toThrow();
    expect(readFileSync(result.mcpLauncherPath, 'utf8')).toContain(`'"'"'`);
    expect(existsSync(join(root, 'not-a-command'))).toBe(false);
  });

  it('prunes only receipt-owned stale versions after the caller commits', async () => {
    const root = temporaryDirectory('prune');
    const first = installInput(root, '1.9.0');
    await installRuntime({ ...first, smoke: async () => undefined });
    const second = installInput(root, '2.0.0');
    await installRuntime({ ...second, smoke: async () => undefined });
    const unowned = join(
      second.homeDirectory,
      'Library/Application Support/Pimpampum/Runtime/user-files',
    );
    mkdirSync(unowned, { recursive: true });
    writeFileSync(join(unowned, 'keep'), 'mine');

    const removed = pruneOwnedRuntimeVersions({
      homeDirectory: second.homeDirectory,
      dataDirectory: second.dataDirectory,
      platform: second.platform,
      architecture: second.architecture,
    });

    expect(removed).toEqual(['1.9.0']);
    expect(
      existsSync(join(first.homeDirectory, 'Library/Application Support/Pimpampum/Runtime/1.9.0')),
    ).toBe(false);
    expect(
      existsSync(join(second.homeDirectory, 'Library/Application Support/Pimpampum/Runtime/2.0.0')),
    ).toBe(true);
    expect(readFileSync(join(unowned, 'keep'), 'utf8')).toBe('mine');
  });

  it('rejects a public or tampered ownership receipt', async () => {
    const root = temporaryDirectory('receipt-mode');
    const input = installInput(root, '2.0.0');
    await installRuntime({ ...input, smoke: async () => undefined });
    const receipt = join(input.dataDirectory, 'runtime-install-receipt.json');
    expect(lstatSync(receipt).mode & 0o777).toBe(0o600);

    chmodSync(receipt, 0o644);
    await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
      /receipt.*private|0600/iu,
    );
  });
});

describe('reversible owned runtime removal', () => {
  it('quarantines receipted versions and restores launchers and receipt on rollback', async () => {
    const root = temporaryDirectory('remove-rollback');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    const receiptPath = join(input.dataDirectory, 'runtime-install-receipt.json');
    const receiptBytes = readFileSync(receiptPath);
    const launcherBytes = readFileSync(installed.mcpLauncherPath);

    const prepared = prepareOwnedRuntimeRemoval(input)!;
    expect(existsSync(installed.nodePath)).toBe(false);
    expect(existsSync(installed.mcpLauncherPath)).toBe(false);
    expect(existsSync(receiptPath)).toBe(false);

    prepared.rollback();
    expect(existsSync(installed.nodePath)).toBe(true);
    expect(readFileSync(installed.mcpLauncherPath)).toEqual(launcherBytes);
    expect(readFileSync(receiptPath)).toEqual(receiptBytes);
  });

  it('permanently removes only receipt-owned runtime paths on commit', async () => {
    const root = temporaryDirectory('remove-commit');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '2.0.0',
    });
    const userFile = join(input.dataDirectory, 'exports', 'project.md');
    mkdirSync(dirname(userFile), { recursive: true });
    writeFileSync(userFile, '# preserved\n');

    const prepared = prepareOwnedRuntimeRemoval(input)!;
    prepared.commit();

    expect(existsSync(installed.nodePath)).toBe(false);
    expect(existsSync(join(input.dataDirectory, 'runtime-install-receipt.json'))).toBe(false);
    expect(existsSync(layout.launchersDirectory)).toBe(false);
    expect(existsSync(layout.runtimeDirectory)).toBe(false);
    expect(readFileSync(userFile, 'utf8')).toBe('# preserved\n');
  });
});
