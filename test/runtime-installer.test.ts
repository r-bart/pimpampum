import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectInstalledRuntime,
  installRuntime,
  prepareOwnedRuntimeRemoval,
  pruneOwnedRuntimeVersions,
  recoverInterruptedRuntimeRemoval,
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

function fileSnapshot(path: string): { content: string; mode: number } {
  return {
    content: readFileSync(path).toString('base64'),
    mode: lstatSync(path).mode & 0o777,
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
    // Identity is decided from the receipt and the on-disk tree before staging, so a no-op
    // reinstall neither copies the payload again nor smoke-tests a fresh copy.
    expect(repeatedSmoke).not.toHaveBeenCalled();
    expect(
      readdirSync(dirname(layout.versionDirectory)).filter((name) =>
        name.startsWith('.pimpampum-stage-'),
      ),
    ).toEqual([]);
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

  it('records a missing stale version as pruned and leaves a current-only receipt unchanged', async () => {
    const root = temporaryDirectory('prune-missing');
    const first = installInput(root, '1.9.0');
    const firstInstallation = await installRuntime({ ...first, smoke: async () => undefined });
    const second = installInput(root, '2.0.0');
    await installRuntime({ ...second, smoke: async () => undefined });
    rmSync(dirname(dirname(firstInstallation.nodePath)), { recursive: true });

    expect(pruneOwnedRuntimeVersions(second)).toEqual(['1.9.0']);
    expect(pruneOwnedRuntimeVersions(second)).toEqual([]);
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

  it('rejects missing, non-directory, and special-file runtime sources', async () => {
    const missingRoot = temporaryDirectory('missing-source');
    const missing = installInput(missingRoot, '2.0.0');
    rmSync(missing.sourceDirectory, { recursive: true });
    await expect(installRuntime({ ...missing, smoke: async () => undefined })).rejects.toThrow(
      /existing absolute directory/iu,
    );

    const fileRoot = temporaryDirectory('file-source');
    const file = installInput(fileRoot, '2.0.0');
    rmSync(file.sourceDirectory, { recursive: true });
    writeFileSync(file.sourceDirectory, 'file');
    await expect(installRuntime({ ...file, smoke: async () => undefined })).rejects.toThrow(
      /regular directory/iu,
    );

    const fifoRoot = temporaryDirectory('fifo-source');
    const fifo = installInput(fifoRoot, '2.0.0');
    execFileSync('/usr/bin/mkfifo', [join(fifo.sourceDirectory, 'named-pipe')]);
    await expect(installRuntime({ ...fifo, smoke: async () => undefined })).rejects.toThrow(
      /device or special file/iu,
    );
  });

  it.each([
    [
      'mode',
      (input: ReturnType<typeof installInput>) =>
        chmodSync(join(input.sourceDirectory, 'bin/node'), 0o644),
    ],
    [
      'size',
      (input: ReturnType<typeof installInput>) =>
        writeFileSync(join(input.sourceDirectory, 'bin/node'), '#!/bin/sh\nexit 00\n'),
    ],
    [
      'hash',
      (input: ReturnType<typeof installInput>) =>
        writeFileSync(join(input.sourceDirectory, 'bin/node'), '#!/bin/sh\nexit 1\n'),
    ],
  ] as const)('rejects runtime source %s drift', async (_label, mutate) => {
    const root = temporaryDirectory('source-drift');
    const input = installInput(root, '2.0.0');
    mutate(input);
    await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
      /drift/iu,
    );
  });

  it.each([
    ['JSON null', () => null],
    ['primitive', () => 1],
    ['missing schema', (value: Record<string, unknown>) => ({ ...value, schemaVersion: 2 })],
    ['unexpected field', (value: Record<string, unknown>) => ({ ...value, extra: true })],
    ['invalid version', (value: Record<string, unknown>) => ({ ...value, currentVersion: 1 })],
    ['invalid target', (value: Record<string, unknown>) => ({ ...value, targetId: 'linux-x64' })],
    ['escaped CLI path', (value: Record<string, unknown>) => ({ ...value, cliPath: '/tmp/cli' })],
    [
      'invalid launcher hash',
      (value: Record<string, unknown>) => ({ ...value, controlLauncherSha256: 'bad' }),
    ],
    ['invalid owned list', (value: Record<string, unknown>) => ({ ...value, ownedVersions: null })],
    [
      'invalid owned entry',
      (value: Record<string, unknown>) => ({ ...value, ownedVersions: [null] }),
    ],
    [
      'invalid owned schema',
      (value: Record<string, unknown>) => ({ ...value, ownedVersions: [{ version: '2.0.0' }] }),
    ],
    [
      'escaped owned path',
      (value: Record<string, unknown>) => ({
        ...value,
        ownedVersions: [
          { ...(value.ownedVersions as Record<string, unknown>[])[0]!, directory: '/tmp/runtime' },
        ],
      }),
    ],
  ] as const)('rejects a hostile runtime receipt: %s', async (_label, mutate) => {
    const root = temporaryDirectory('hostile-receipt');
    const input = installInput(root, '2.0.0');
    await installRuntime({ ...input, smoke: async () => undefined });
    const path = join(input.dataDirectory, 'runtime-install-receipt.json');
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify(mutate(current))}\n`, { mode: 0o600 });
    await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
      /runtime installation failed/iu,
    );
  });

  it('rejects malformed, oversized, and non-regular runtime receipt metadata', async () => {
    for (const variant of ['json', 'oversized', 'directory', 'symlink'] as const) {
      const root = temporaryDirectory(`receipt-${variant}`);
      const input = installInput(root, '2.0.0');
      mkdirSync(input.dataDirectory, { recursive: true });
      const path = join(input.dataDirectory, 'runtime-install-receipt.json');
      if (variant === 'json') writeFileSync(path, '{', { mode: 0o600 });
      if (variant === 'oversized') writeFileSync(path, Buffer.alloc(1_000_001), { mode: 0o600 });
      if (variant === 'directory') mkdirSync(path);
      if (variant === 'symlink') symlinkSync('/dev/null', path);
      await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow();
    }
  });

  it('rejects launcher drift and returns neutral removal results without a receipt', async () => {
    const root = temporaryDirectory('launcher-drift');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    writeFileSync(installed.mcpLauncherPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => pruneOwnedRuntimeVersions(input)).toThrow(/launcher drift/iu);

    const empty = installInput(temporaryDirectory('empty-removal'), '2.0.0');
    mkdirSync(empty.dataDirectory, { recursive: true });
    expect(pruneOwnedRuntimeVersions(empty)).toEqual([]);
    expect(prepareOwnedRuntimeRemoval(empty)).toBeNull();
  });

  it('rejects hostile interrupted activation journals', async () => {
    const mutations: unknown[] = [
      null,
      [],
      { schemaVersion: 2, candidateVersion: '2.0.0', createdFinal: false },
      { schemaVersion: 1, candidateVersion: 1, createdFinal: false },
      {
        schemaVersion: 1,
        candidateVersion: '2.0.0',
        createdFinal: false,
        targetId: 'linux-x64',
        finalDirectory: '/tmp/runtime',
      },
    ];
    for (const [index, value] of mutations.entries()) {
      const root = temporaryDirectory(`activation-journal-${index}`);
      const input = installInput(root, '2.0.0');
      mkdirSync(input.dataDirectory, { recursive: true });
      writeFileSync(
        join(input.dataDirectory, 'runtime-install-journal.json'),
        `${JSON.stringify(value)}\n`,
        { mode: 0o600 },
      );
      await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
        /activation journal/iu,
      );
    }
  });

  it('recovers both uncommitted and committed activation journals', async () => {
    const rollbackRoot = temporaryDirectory('activation-recovery-rollback');
    const previousInput = installInput(rollbackRoot, '1.0.0');
    await installRuntime({ ...previousInput, smoke: async () => undefined });
    const previousLayout = resolveRuntimeLayout({
      homeDirectory: previousInput.homeDirectory,
      platform: previousInput.platform,
      architecture: previousInput.architecture,
      version: '1.0.0',
    });
    const nextInput = installInput(rollbackRoot, '2.0.0');
    const nextLayout = resolveRuntimeLayout({
      homeDirectory: nextInput.homeDirectory,
      platform: nextInput.platform,
      architecture: nextInput.architecture,
      version: '2.0.0',
    });
    mkdirSync(nextLayout.versionDirectory, { recursive: true });
    writeFileSync(join(nextLayout.versionDirectory, 'partial'), 'partial');
    writeFileSync(
      join(nextInput.dataDirectory, 'runtime-install-journal.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        targetId: nextLayout.targetId,
        candidateVersion: '2.0.0',
        finalDirectory: nextLayout.versionDirectory,
        createdFinal: true,
        controlLauncher: fileSnapshot(previousLayout.controlLauncherPath),
        mcpLauncher: fileSnapshot(previousLayout.mcpLauncherPath),
        receipt: fileSnapshot(join(nextInput.dataDirectory, 'runtime-install-receipt.json')),
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      installRuntime({ ...nextInput, smoke: async () => undefined }),
    ).resolves.toMatchObject({ version: '2.0.0', previousVersion: '1.0.0' });
    expect(existsSync(join(nextLayout.versionDirectory, 'partial'))).toBe(false);

    const committedRoot = temporaryDirectory('activation-recovery-committed');
    const committedInput = installInput(committedRoot, '2.0.0');
    await installRuntime({ ...committedInput, smoke: async () => undefined });
    const committedLayout = resolveRuntimeLayout({
      homeDirectory: committedInput.homeDirectory,
      platform: committedInput.platform,
      architecture: committedInput.architecture,
      version: '2.0.0',
    });
    writeFileSync(
      join(committedInput.dataDirectory, 'runtime-install-journal.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        targetId: committedLayout.targetId,
        candidateVersion: '2.0.0',
        finalDirectory: committedLayout.versionDirectory,
        createdFinal: false,
        controlLauncher: null,
        mcpLauncher: null,
        receipt: null,
      })}\n`,
      { mode: 0o600 },
    );
    await expect(
      installRuntime({ ...committedInput, smoke: async () => undefined }),
    ).resolves.toMatchObject({ activated: false });
  });

  it('restores absent activation snapshots and rejects invalid or public snapshots', async () => {
    for (const variant of ['absent', 'invalid-snapshot', 'public'] as const) {
      const root = temporaryDirectory(`activation-${variant}`);
      const input = installInput(root, '2.0.0');
      const layout = resolveRuntimeLayout({
        homeDirectory: input.homeDirectory,
        platform: input.platform,
        architecture: input.architecture,
        version: '2.0.0',
      });
      mkdirSync(input.dataDirectory, { recursive: true });
      const path = join(input.dataDirectory, 'runtime-install-journal.json');
      writeFileSync(
        path,
        `${JSON.stringify({
          schemaVersion: 1,
          targetId: layout.targetId,
          candidateVersion: '2.0.0',
          finalDirectory: layout.versionDirectory,
          createdFinal: false,
          controlLauncher: variant === 'invalid-snapshot' ? { content: 1, mode: 0o755 } : null,
          mcpLauncher: null,
          receipt: null,
        })}\n`,
        { mode: 0o600 },
      );
      if (variant === 'public') chmodSync(path, 0o644);
      const installation = installRuntime({ ...input, smoke: async () => undefined });
      if (variant === 'absent')
        await expect(installation).resolves.toMatchObject({ activated: true });
      else
        await expect(installation).rejects.toThrow(
          variant === 'public' ? /private.*0600/iu : /snapshot is invalid/iu,
        );
    }
  });

  it('rejects relative data and unsafe interrupted staging paths', async () => {
    const relativeInput = installInput(temporaryDirectory('relative-data'), '2.0.0');
    relativeInput.dataDirectory = 'relative-data';
    await expect(
      installRuntime({ ...relativeInput, smoke: async () => undefined }),
    ).rejects.toThrow(/data directory must be absolute/iu);

    const stagingRoot = temporaryDirectory('unsafe-stage');
    const stagingInput = installInput(stagingRoot, '2.0.0');
    const layout = resolveRuntimeLayout({
      homeDirectory: stagingInput.homeDirectory,
      platform: stagingInput.platform,
      architecture: stagingInput.architecture,
      version: '2.0.0',
    });
    mkdirSync(dirname(layout.versionDirectory), { recursive: true });
    symlinkSync('/tmp', join(dirname(layout.versionDirectory), '.pimpampum-stage-linked'));
    await expect(installRuntime({ ...stagingInput, smoke: async () => undefined })).rejects.toThrow(
      /staging path is unsafe/iu,
    );
  });

  it('repairs a receipt-owned version whose bytes drifted instead of refusing the reinstall', async () => {
    const root = temporaryDirectory('repair-current');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '2.0.0',
    });
    const addonPath = join(
      layout.versionDirectory,
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    );
    writeFileSync(installed.cliPath, 'truncated');
    writeFileSync(addonPath, 'native-addon-x64!!');
    await expect(() => inspectInstalledRuntime(input)).not.toThrow();

    const smoke = vi.fn(async () => undefined);
    const repaired = await installRuntime({ ...input, smoke });

    expect(repaired).toMatchObject({ activated: true, version: '2.0.0', previousVersion: '2.0.0' });
    expect(smoke).toHaveBeenCalledOnce();
    expect(readFileSync(installed.cliPath, 'utf8')).toBe('export const version = "2.0.0";\n');
    expect(readFileSync(addonPath, 'utf8')).toBe('native-addon-arm64');
    expect(
      readdirSync(layout.versionsDirectory).filter((name) => name.startsWith('.pimpampum-')),
    ).toEqual([]);
    expect(existsSync(join(input.dataDirectory, 'runtime-install-journal.json'))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(input.dataDirectory, 'runtime-install-receipt.json'), 'utf8')),
    ).toMatchObject({
      currentVersion: '2.0.0',
      ownedVersions: [{ version: '2.0.0', directory: layout.versionDirectory }],
    });
    expect(inspectInstalledRuntime(input)).toMatchObject({ version: '2.0.0' });
  });

  it('repairs a drifted inactive owned version while reactivating it', async () => {
    const root = temporaryDirectory('repair-inactive');
    const first = installInput(root, '1.0.0');
    const firstInstalled = await installRuntime({ ...first, smoke: async () => undefined });
    const second = installInput(root, '2.0.0');
    const secondInstalled = await installRuntime({ ...second, smoke: async () => undefined });
    writeFileSync(firstInstalled.nodePath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    const reactivated = await installRuntime({ ...first, smoke: async () => undefined });

    expect(reactivated).toMatchObject({
      activated: true,
      version: '1.0.0',
      previousVersion: '2.0.0',
    });
    expect(readFileSync(firstInstalled.nodePath, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    expect(readFileSync(secondInstalled.cliPath, 'utf8')).toBe('export const version = "2.0.0";\n');
    expect(inspectInstalledRuntime(first)).toMatchObject({ version: '1.0.0' });
  });

  it('restores the quarantined copy of an interrupted repair and discards a committed one', async () => {
    const root = temporaryDirectory('repair-recovery');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '2.0.0',
    });
    const journalPath = join(input.dataDirectory, 'runtime-install-journal.json');
    const receiptPath = join(input.dataDirectory, 'runtime-install-receipt.json');
    const originalBytes = readFileSync(installed.cliPath);
    const journal = (replacedFinal: string, phase: 'prepared' | 'committed' = 'prepared') => ({
      schemaVersion: 1,
      phase,
      targetId: layout.targetId,
      candidateVersion: '2.0.0',
      finalDirectory: layout.versionDirectory,
      createdFinal: true,
      replacedFinal,
      controlLauncher: fileSnapshot(layout.controlLauncherPath),
      mcpLauncher: fileSnapshot(layout.mcpLauncherPath),
      receipt: fileSnapshot(receiptPath),
    });

    // Interrupted after the staged payload replaced the quarantined copy: the receipt still names
    // the old bytes, so recovery removes the half-activated payload and renames the copy back.
    const quarantineRoot = join(
      layout.versionsDirectory,
      '.pimpampum-remove-12345678-1234-1234-1234-123456789abc',
    );
    mkdirSync(quarantineRoot, { recursive: true });
    renameSync(layout.versionDirectory, join(quarantineRoot, 'replaced'));
    mkdirSync(layout.versionDirectory, { recursive: true });
    writeFileSync(join(layout.versionDirectory, 'partial'), 'partial');
    writeFileSync(journalPath, `${JSON.stringify(journal(join(quarantineRoot, 'replaced')))}\n`, {
      mode: 0o600,
    });

    await expect(installRuntime({ ...input, smoke: async () => undefined })).resolves.toMatchObject(
      { activated: false, version: '2.0.0' },
    );
    expect(readFileSync(installed.cliPath)).toEqual(originalBytes);
    expect(existsSync(join(layout.versionDirectory, 'partial'))).toBe(false);
    expect(existsSync(quarantineRoot)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);

    // Interrupted between the quarantine rename and the payload rename: the destination is gone
    // and the quarantined copy is the only one; recovery renames it back.
    mkdirSync(quarantineRoot, { recursive: true });
    renameSync(layout.versionDirectory, join(quarantineRoot, 'replaced'));
    writeFileSync(journalPath, `${JSON.stringify(journal(join(quarantineRoot, 'replaced')))}\n`, {
      mode: 0o600,
    });
    await expect(installRuntime({ ...input, smoke: async () => undefined })).resolves.toMatchObject(
      { activated: false },
    );
    expect(readFileSync(installed.cliPath)).toEqual(originalBytes);
    expect(existsSync(quarantineRoot)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);

    // Interrupted before the quarantine rename: the destination still holds the original bytes
    // and must survive; only the empty quarantine root goes.
    mkdirSync(quarantineRoot, { recursive: true });
    writeFileSync(journalPath, `${JSON.stringify(journal(join(quarantineRoot, 'replaced')))}\n`, {
      mode: 0o600,
    });
    await expect(installRuntime({ ...input, smoke: async () => undefined })).resolves.toMatchObject(
      { activated: false },
    );
    expect(readFileSync(installed.cliPath)).toEqual(originalBytes);
    expect(existsSync(quarantineRoot)).toBe(false);

    // Committed: the receipt already names the repaired bytes, so the quarantine is garbage. The
    // receipt cannot tell a same-version repair apart from its predecessor, so the phase decides.
    mkdirSync(join(quarantineRoot, 'replaced'), { recursive: true });
    writeFileSync(join(quarantineRoot, 'replaced', 'stale'), 'stale');
    writeFileSync(
      journalPath,
      `${JSON.stringify(journal(join(quarantineRoot, 'replaced'), 'committed'))}\n`,
      { mode: 0o600 },
    );
    await expect(installRuntime({ ...input, smoke: async () => undefined })).resolves.toMatchObject(
      { activated: false },
    );
    expect(readFileSync(installed.cliPath)).toEqual(originalBytes);
    expect(existsSync(quarantineRoot)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);

    // Committed without a receipt is a hand-edited state: fail closed, but drop the quarantine and
    // the journal so the failure does not repeat on every later lifecycle call.
    mkdirSync(join(quarantineRoot, 'replaced'), { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify(journal(join(quarantineRoot, 'replaced'), 'committed'))}\n`,
      { mode: 0o600 },
    );
    const receiptBytes = readFileSync(receiptPath);
    rmSync(receiptPath);
    await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
      /committed without a receipt/iu,
    );
    expect(existsSync(quarantineRoot)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
    expect(inspectInstalledRuntime(input)).toMatchObject({ version: '2.0.0' });
  });

  it('rejects a repair journal whose quarantine escapes the owned layout', async () => {
    const root = temporaryDirectory('repair-hostile');
    const input = installInput(root, '2.0.0');
    await installRuntime({ ...input, smoke: async () => undefined });
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '2.0.0',
    });
    const journalPath = join(input.dataDirectory, 'runtime-install-journal.json');
    for (const [replacedFinal, expected] of [
      ['/tmp/.pimpampum-remove-12345678-1234-1234-1234-123456789abc/replaced', /escapes/iu],
      [join(layout.versionsDirectory, 'not-a-quarantine', 'replaced'), /escapes/iu],
      [
        join(layout.versionsDirectory, '.pimpampum-remove-12345678-1234-1234-1234-123456789abc'),
        /escapes/iu,
      ],
      [42, /schema is invalid/iu],
    ] as const) {
      writeFileSync(
        journalPath,
        `${JSON.stringify({
          schemaVersion: 1,
          phase: 'prepared',
          targetId: layout.targetId,
          candidateVersion: '2.0.0',
          finalDirectory: layout.versionDirectory,
          createdFinal: true,
          replacedFinal,
          controlLauncher: null,
          mcpLauncher: null,
          receipt: null,
        })}\n`,
        { mode: 0o600 },
      );
      await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
        expected,
      );
      expect(existsSync(journalPath)).toBe(true);
      rmSync(journalPath);
    }

    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        phase: 'deleting',
        targetId: layout.targetId,
        candidateVersion: '2.0.0',
        finalDirectory: layout.versionDirectory,
        createdFinal: false,
        replacedFinal: null,
        controlLauncher: null,
        mcpLauncher: null,
        receipt: null,
      })}\n`,
      { mode: 0o600 },
    );
    await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
      /schema is invalid/iu,
    );
  });

  it('repairs drifted launchers behind a committed journal and never keeps the journal', async () => {
    const root = temporaryDirectory('committed-launcher-drift');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '2.0.0',
    });
    const journalPath = join(input.dataDirectory, 'runtime-install-journal.json');
    const receiptPath = join(input.dataDirectory, 'runtime-install-receipt.json');
    const committedJournal = `${JSON.stringify({
      schemaVersion: 1,
      phase: 'committed',
      targetId: layout.targetId,
      candidateVersion: '2.0.0',
      finalDirectory: layout.versionDirectory,
      createdFinal: false,
      controlLauncher: null,
      mcpLauncher: null,
      receipt: null,
    })}\n`;
    const launcherBytes = readFileSync(installed.mcpLauncherPath);

    writeFileSync(installed.mcpLauncherPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(journalPath, committedJournal, { mode: 0o600 });
    await expect(installRuntime({ ...input, smoke: async () => undefined })).resolves.toMatchObject(
      { activated: false },
    );
    expect(readFileSync(installed.mcpLauncherPath)).toEqual(launcherBytes);
    expect(existsSync(journalPath)).toBe(false);

    // A receipt that pins a hash no regenerated launcher can produce is a real tamper: the
    // install fails closed, but the journal still goes so the failure cannot become permanent.
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      receiptPath,
      `${JSON.stringify({ ...receipt, mcpLauncherSha256: 'f'.repeat(64) })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(journalPath, committedJournal, { mode: 0o600 });
    await expect(installRuntime({ ...input, smoke: async () => undefined })).rejects.toThrow(
      /launcher drift/iu,
    );
    expect(existsSync(journalPath)).toBe(false);
  });

  it('inspects the active runtime without recovering pending journals', async () => {
    const root = temporaryDirectory('inspect-read-only');
    const input = installInput(root, '1.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '1.0.0',
    });
    const journalPath = join(input.dataDirectory, 'runtime-install-journal.json');

    // Mid-activation shape: launchers already point at the candidate, receipt still names the
    // previous version. A poll must report the transient state, not undo the installer's work.
    const launcherBytes = readFileSync(installed.mcpLauncherPath);
    const drifted = '#!/bin/sh\nexec /elsewhere/node /elsewhere/dist/mcpStdio.js "$@"\n';
    writeFileSync(installed.mcpLauncherPath, drifted, { mode: 0o755 });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        targetId: layout.targetId,
        candidateVersion: '1.0.0',
        finalDirectory: layout.versionDirectory,
        createdFinal: false,
        controlLauncher: null,
        mcpLauncher: null,
        receipt: null,
      })}\n`,
      { mode: 0o600 },
    );
    expect(() => inspectInstalledRuntime(input)).toThrow(/in progress or was interrupted/iu);
    expect(readFileSync(installed.mcpLauncherPath, 'utf8')).toBe(drifted);
    expect(existsSync(journalPath)).toBe(true);
    rmSync(journalPath);
    expect(() => inspectInstalledRuntime(input)).toThrow(/launcher drift/iu);
    writeFileSync(installed.mcpLauncherPath, launcherBytes, { mode: 0o755 });

    // Mid-removal shape: the receipt is gone and the bytes sit in quarantine. Inspection sees no
    // runtime and leaves the removal journal for the locked entry points to recover.
    const restored = await installRuntime({ ...input, smoke: async () => undefined });
    prepareOwnedRuntimeRemoval(input);
    expect(inspectInstalledRuntime(input)).toBeNull();
    expect(existsSync(join(input.dataDirectory, 'runtime-removal-journal.json'))).toBe(true);
    expect(existsSync(restored.nodePath)).toBe(false);
    expect(recoverInterruptedRuntimeRemoval(input)).toBe('rolled-back');
    expect(existsSync(restored.nodePath)).toBe(true);
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

  it('recovers a power loss before the service receipt commit by rolling back', async () => {
    const root = temporaryDirectory('remove-power-rollback');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    const receiptPath = join(input.dataDirectory, 'runtime-install-receipt.json');
    const receiptBytes = readFileSync(receiptPath);
    prepareOwnedRuntimeRemoval(input);

    expect(recoverInterruptedRuntimeRemoval(input)).toBe('rolled-back');
    expect(existsSync(installed.nodePath)).toBe(true);
    expect(readFileSync(receiptPath)).toEqual(receiptBytes);
    expect(existsSync(join(input.dataDirectory, 'runtime-removal-journal.json'))).toBe(false);
  });

  it('finishes quarantine deletion after power loss beyond the receipt commit boundary', async () => {
    const root = temporaryDirectory('remove-power-commit');
    const input = installInput(root, '2.0.0');
    const installed = await installRuntime({ ...input, smoke: async () => undefined });
    prepareOwnedRuntimeRemoval(input);
    const journalPath = join(input.dataDirectory, 'runtime-removal-journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(journalPath, `${JSON.stringify({ ...journal, phase: 'committed' })}\n`, {
      mode: 0o600,
    });

    expect(recoverInterruptedRuntimeRemoval(input)).toBe('committed');
    expect(existsSync(installed.nodePath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(String(journal.quarantineRoot))).toBe(false);
  });

  it.each([
    ['non-object envelope', () => null],
    [
      'unsupported schema',
      (journal: Record<string, unknown>) => ({ ...journal, schemaVersion: 2 }),
    ],
    [
      'unsupported phase',
      (journal: Record<string, unknown>) => ({ ...journal, phase: 'deleting' }),
    ],
    [
      'escaped quarantine root',
      (journal: Record<string, unknown>) => ({ ...journal, quarantineRoot: '/tmp/not-owned' }),
    ],
    [
      'missing receipt snapshot',
      (journal: Record<string, unknown>) => ({ ...journal, receipt: null }),
    ],
    [
      'public receipt snapshot mode',
      (journal: Record<string, unknown>) => ({
        ...journal,
        receipt: { ...(journal.receipt as Record<string, unknown>), mode: 0o644 },
      }),
    ],
    [
      'malformed receipt snapshot bytes',
      (journal: Record<string, unknown>) => ({
        ...journal,
        receipt: { ...(journal.receipt as Record<string, unknown>), content: '***' },
      }),
    ],
    [
      'invalid receipt JSON',
      (journal: Record<string, unknown>) => ({
        ...journal,
        receipt: {
          ...(journal.receipt as Record<string, unknown>),
          content: Buffer.from('{').toString('base64'),
        },
      }),
    ],
    [
      'receipt version mismatch',
      (journal: Record<string, unknown>) => ({ ...journal, currentVersion: '1.0.0' }),
    ],
    [
      'unowned moved path',
      (journal: Record<string, unknown>) => ({
        ...journal,
        moved: [
          { original: '/tmp/unowned', quarantined: join(String(journal.quarantineRoot), '0') },
        ],
      }),
    ],
    [
      'duplicate moved path',
      (journal: Record<string, unknown>) => ({
        ...journal,
        moved: [
          ...(journal.moved as unknown[]),
          {
            ...(journal.moved as Record<string, unknown>[])[0]!,
            quarantined: join(
              String(journal.quarantineRoot),
              String((journal.moved as unknown[]).length),
            ),
          },
        ],
      }),
    ],
    [
      'invalid launcher snapshot',
      (journal: Record<string, unknown>) => ({
        ...journal,
        controlLauncher: { content: 1, mode: 0o755 },
      }),
    ],
  ] as const)('rejects a hostile durable removal journal: %s', async (_label, mutate) => {
    const root = temporaryDirectory('remove-hostile-journal');
    const input = installInput(root, '2.0.0');
    await installRuntime({ ...input, smoke: async () => undefined });
    prepareOwnedRuntimeRemoval(input);
    const path = join(input.dataDirectory, 'runtime-removal-journal.json');
    const journal = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const hostile = mutate(journal);
    writeFileSync(path, `${JSON.stringify(hostile)}\n`);

    expect(() => recoverInterruptedRuntimeRemoval(input)).toThrow(/runtime installation failed/iu);
  });

  it('rejects public removal journals and ambiguous active plus quarantined bytes', async () => {
    const publicRoot = temporaryDirectory('remove-public-journal');
    const publicInput = installInput(publicRoot, '2.0.0');
    await installRuntime({ ...publicInput, smoke: async () => undefined });
    prepareOwnedRuntimeRemoval(publicInput);
    const publicJournal = join(publicInput.dataDirectory, 'runtime-removal-journal.json');
    chmodSync(publicJournal, 0o644);
    expect(() => recoverInterruptedRuntimeRemoval(publicInput)).toThrow(/private.*0600/iu);

    const ambiguousRoot = temporaryDirectory('remove-ambiguous-journal');
    const ambiguousInput = installInput(ambiguousRoot, '2.0.0');
    await installRuntime({ ...ambiguousInput, smoke: async () => undefined });
    prepareOwnedRuntimeRemoval(ambiguousInput);
    const journal = JSON.parse(
      readFileSync(join(ambiguousInput.dataDirectory, 'runtime-removal-journal.json'), 'utf8'),
    ) as { moved: Array<{ original: string }> };
    mkdirSync(journal.moved[0]!.original, { recursive: true });
    expect(() => recoverInterruptedRuntimeRemoval(ambiguousInput)).toThrow(
      /active and quarantined/iu,
    );
  });

  it('recovers a prepared journal whose quarantined bytes were already restored', async () => {
    const root = temporaryDirectory('remove-partial-recovery');
    const input = installInput(root, '2.0.0');
    await installRuntime({ ...input, smoke: async () => undefined });
    prepareOwnedRuntimeRemoval(input);
    const journalPath = join(input.dataDirectory, 'runtime-removal-journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      moved: Array<{ quarantined: string }>;
    };
    const receipt = JSON.parse(
      Buffer.from(
        (
          JSON.parse(readFileSync(journalPath, 'utf8')) as {
            receipt: { content: string };
          }
        ).receipt.content,
        'base64',
      ).toString('utf8'),
    ) as { ownedVersions: Array<{ directory: string }> };
    renameSync(journal.moved[0]!.quarantined, receipt.ownedVersions[0]!.directory);
    expect(recoverInterruptedRuntimeRemoval(input)).toBe('rolled-back');
    expect(existsSync(journalPath)).toBe(false);
  });

  it('fails closed when both active and quarantined runtime bytes disappeared', async () => {
    const root = temporaryDirectory('remove-missing-both');
    const input = installInput(root, '2.0.0');
    await installRuntime({ ...input, smoke: async () => undefined });
    prepareOwnedRuntimeRemoval(input);
    const journalPath = join(input.dataDirectory, 'runtime-removal-journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      moved: Array<{ quarantined: string }>;
    };
    rmSync(journal.moved[0]!.quarantined, { recursive: true });
    expect(() => recoverInterruptedRuntimeRemoval(input)).toThrow(
      /missing active and quarantined/iu,
    );
  });

  it('handles missing owned bytes and keeps prepared removal terminal calls idempotent', async () => {
    const missingRoot = temporaryDirectory('remove-missing-owned');
    const missingInput = installInput(missingRoot, '2.0.0');
    const missing = await installRuntime({ ...missingInput, smoke: async () => undefined });
    rmSync(dirname(dirname(missing.nodePath)), { recursive: true });
    const preparedMissing = prepareOwnedRuntimeRemoval(missingInput)!;
    preparedMissing.rollback();
    preparedMissing.rollback();
    preparedMissing.commit();

    const committedRoot = temporaryDirectory('remove-idempotent-commit');
    const committedInput = installInput(committedRoot, '2.0.0');
    await installRuntime({ ...committedInput, smoke: async () => undefined });
    const preparedCommitted = prepareOwnedRuntimeRemoval(committedInput)!;
    preparedCommitted.commit();
    preparedCommitted.commit();
    preparedCommitted.rollback();
  });

  it('recovers a prepared removal when a receipted version was already absent', async () => {
    const root = temporaryDirectory('remove-missing-owned-recovery');
    const first = installInput(root, '1.0.0');
    const firstInstallation = await installRuntime({ ...first, smoke: async () => undefined });
    const second = installInput(root, '2.0.0');
    const secondInstallation = await installRuntime({ ...second, smoke: async () => undefined });
    rmSync(dirname(dirname(firstInstallation.nodePath)), { recursive: true });

    prepareOwnedRuntimeRemoval(second);

    expect(recoverInterruptedRuntimeRemoval(second)).toBe('rolled-back');
    expect(existsSync(secondInstallation.nodePath)).toBe(true);
    expect(existsSync(firstInstallation.nodePath)).toBe(false);
  });

  it('rejects a nested or non-UUID removal quarantine path', async () => {
    for (const variant of ['non-uuid', 'nested'] as const) {
      const root = temporaryDirectory('remove-quarantine-boundary');
      const input = installInput(root, '2.0.0');
      await installRuntime({ ...input, smoke: async () => undefined });
      prepareOwnedRuntimeRemoval(input);
      const path = join(input.dataDirectory, 'runtime-removal-journal.json');
      const journal = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const originalRoot = String(journal.quarantineRoot);
      const quarantineRoot =
        variant === 'non-uuid'
          ? join(dirname(originalRoot), '.pimpampum-remove-not-owned')
          : join(originalRoot, 'nested');
      writeFileSync(path, `${JSON.stringify({ ...journal, quarantineRoot })}\n`, { mode: 0o600 });

      expect(() => recoverInterruptedRuntimeRemoval(input)).toThrow(/escapes the owned layout/iu);
    }
  });

  it('rejects unsafe receipted runtime bytes during prune, prepare, and rollback', async () => {
    const pruneRoot = temporaryDirectory('prune-unsafe-owned');
    const first = installInput(pruneRoot, '1.0.0');
    await installRuntime({ ...first, smoke: async () => undefined });
    const second = installInput(pruneRoot, '2.0.0');
    await installRuntime({ ...second, smoke: async () => undefined });
    const firstLayout = resolveRuntimeLayout({
      homeDirectory: first.homeDirectory,
      platform: first.platform,
      architecture: first.architecture,
      version: '1.0.0',
    });
    rmSync(firstLayout.versionDirectory, { recursive: true });
    symlinkSync('/tmp', firstLayout.versionDirectory);
    expect(() => pruneOwnedRuntimeVersions(second)).toThrow(/owned runtime path is unsafe/iu);

    const prepareRoot = temporaryDirectory('prepare-unsafe-owned');
    const prepareInput = installInput(prepareRoot, '2.0.0');
    await installRuntime({ ...prepareInput, smoke: async () => undefined });
    const prepareLayout = resolveRuntimeLayout({
      homeDirectory: prepareInput.homeDirectory,
      platform: prepareInput.platform,
      architecture: prepareInput.architecture,
      version: '2.0.0',
    });
    rmSync(prepareLayout.versionDirectory, { recursive: true });
    symlinkSync('/tmp', prepareLayout.versionDirectory);
    expect(() => prepareOwnedRuntimeRemoval(prepareInput)).toThrow(
      /owned runtime path is unsafe/iu,
    );

    const rollbackRoot = temporaryDirectory('rollback-existing-destination');
    const rollbackInput = installInput(rollbackRoot, '2.0.0');
    await installRuntime({ ...rollbackInput, smoke: async () => undefined });
    const rollbackLayout = resolveRuntimeLayout({
      homeDirectory: rollbackInput.homeDirectory,
      platform: rollbackInput.platform,
      architecture: rollbackInput.architecture,
      version: '2.0.0',
    });
    const prepared = prepareOwnedRuntimeRemoval(rollbackInput)!;
    mkdirSync(rollbackLayout.versionDirectory, { recursive: true });
    expect(() => prepared.rollback()).toThrow(/destination already exists/iu);
  });

  it('cleans quarantine when a hostile journal target blocks preparation', async () => {
    const root = temporaryDirectory('remove-journal-symlink');
    const input = installInput(root, '2.0.0');
    await installRuntime({ ...input, smoke: async () => undefined });
    symlinkSync('/dev/null', join(input.dataDirectory, 'runtime-removal-journal.json'));
    expect(() => prepareOwnedRuntimeRemoval(input)).toThrow(/regular file|symlink/iu);
    const layout = resolveRuntimeLayout({
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      architecture: input.architecture,
      version: '2.0.0',
    });
    expect(
      readdirSync(layout.versionsDirectory).some((name) => name.startsWith('.pimpampum-remove-')),
    ).toBe(false);
  });
});
