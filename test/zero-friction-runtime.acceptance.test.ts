/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 *
 * These tests encode the spec's acceptance criteria as executable assertions. Each test names the
 * spec items it covers; a test changes only together with the spec item it names.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRuntime } from '../src/runtime/installer.js';
import { resolveRuntimeLayout } from '../src/runtime/layout.js';
import { parseRuntimeManifest } from '../src/runtime/manifest.js';
import type { RuntimeInstallation, RuntimeManifest } from '../src/runtime/types.js';
import { renderLaunchAgent } from '../src/service/launchd.js';
import { renderSystemdUnit } from '../src/service/systemd.js';
import { parsePlist, parseSystemdUnit } from './helpers/serviceArtifacts.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-zero-friction-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function runtimeCandidate(
  root: string,
  version = '2.0.0',
): {
  sourceDirectory: string;
  manifest: RuntimeManifest;
} {
  const sourceDirectory = join(root, `candidate-${version}`);
  const files = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': 'export const version = true;\n',
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'native-addon-arm64',
  };
  for (const [path, content] of Object.entries(files)) {
    const destination = join(sourceDirectory, path);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, content, { mode: path === 'bin/node' ? 0o755 : 0o644 });
  }
  return {
    sourceDirectory,
    manifest: {
      schemaVersion: 1,
      pimpampumVersion: version,
      nodeVersion: '24.7.0',
      target: { platform: 'darwin', architecture: 'arm64' },
      unpackedBytes: Object.values(files).reduce(
        (total, content) => total + Buffer.byteLength(content),
        0,
      ),
      entrypoints: {
        node: 'bin/node',
        cli: 'dist/cli.js',
        mcp: 'dist/mcpStdio.js',
      },
      files: Object.entries(files).map(([path, content]) => ({
        path,
        sha256: sha256(content),
        mode: path === 'bin/node' ? 0o755 : 0o644,
        size: Buffer.byteLength(content),
      })),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Zero-friction packaged runtime', () => {
  it('FR-1.1/FR-1.2: accepts only a complete runtime for the current target', async () => {
    // Spec: FR-1.1, FR-1.2, SEC-6
    const root = temporaryDirectory('manifest-valid');
    const candidate = runtimeCandidate(root);

    expect(
      parseRuntimeManifest(candidate.manifest, {
        platform: 'darwin',
        architecture: 'arm64',
        maximumUnpackedBytes: 50_000_000,
      }),
    ).toEqual(candidate.manifest);
    expect(() =>
      parseRuntimeManifest(candidate.manifest, {
        platform: 'linux',
        architecture: 'arm64',
        maximumUnpackedBytes: 50_000_000,
      }),
    ).toThrow(/target|platform/i);
  });

  it('FR-1.4/SEC-6/SEC-7: rejects traversal, symlinks, unexpected files, oversize and hash drift', async () => {
    // Spec: FR-1.4, SEC-6, SEC-7, EC-8
    const root = temporaryDirectory('manifest-hostile');
    const { manifest } = runtimeCandidate(root);
    const parse = (candidate: RuntimeManifest) =>
      parseRuntimeManifest(candidate, {
        platform: 'darwin',
        architecture: 'arm64',
        maximumUnpackedBytes: 1_024,
      });

    expect(() =>
      parse({
        ...manifest,
        files: [{ ...manifest.files[0]!, path: '../../Library/LaunchAgents/evil.plist' }],
      }),
    ).toThrow(/path|traversal/i);
    expect(() => parse({ ...manifest, unpackedBytes: 1_025 })).toThrow(/size|large|limit/i);
    expect(() =>
      parse({
        ...manifest,
        files: [{ ...manifest.files[0]!, sha256: '0'.repeat(64) }, ...manifest.files.slice(1)],
      }),
    ).toThrow(/hash|sha/i);
  });

  it('US-1/AC-1 and FR-5.3: resolves private absolute paths without PATH or npx', async () => {
    // Spec: US-1/AC-1, FR-1.2, FR-5.3, SEC-8
    const homeDirectory = join(temporaryDirectory('layout'), 'Home With Spaces ü');
    const layout = resolveRuntimeLayout({
      homeDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      version: '2.0.0',
    });

    expect(layout.versionDirectory).toBe(
      join(homeDirectory, 'Library/Application Support/Pimpampum/Runtime/2.0.0/darwin-arm64'),
    );
    expect(layout.controlLauncherPath).toMatch(/^\//u);
    expect(layout.mcpLauncherPath).toMatch(/^\//u);
    expect(JSON.stringify(layout)).not.toMatch(/\bnpx\b|\/usr\/local\/bin\/node/iu);
  });

  it('US-1/AC-4: installs and verifies a private runtime with one atomic activation', async () => {
    // Spec: US-1/AC-4, FR-1.1, FR-1.4, PERF-1
    const root = temporaryDirectory('install');
    const homeDirectory = join(root, 'home');
    const dataDirectory = join(root, 'data');
    const candidate = runtimeCandidate(root);
    const smoke = vi.fn(async (installation: RuntimeInstallation) => {
      expect(installation.nodePath).toMatch(/Runtime\/2\.0\.0/u);
      expect(installation.cliPath).toMatch(/dist\/cli\.js$/u);
    });

    const result = await installRuntime({
      homeDirectory,
      dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      ...candidate,
      smoke,
    });

    expect(result).toMatchObject({ activated: true, version: '2.0.0', previousVersion: null });
    expect(smoke).toHaveBeenCalledOnce();
    expect(existsSync(result.nodePath)).toBe(true);
    expect(statSync(result.mcpLauncherPath).mode & 0o111).not.toBe(0);
    expect(readFileSync(result.mcpLauncherPath, 'utf8')).not.toMatch(/token|npx/iu);
  });

  it('US-3/AC-5: a failed staged runtime preserves the prior verified version', async () => {
    // Spec: US-3/AC-5, FR-1.4, FR-7.4, EC-16
    const root = temporaryDirectory('runtime-rollback');
    const homeDirectory = join(root, 'home');
    const dataDirectory = join(root, 'data');
    const first = runtimeCandidate(root, '1.9.0');
    const second = runtimeCandidate(root, '2.0.0');

    const installed = await installRuntime({
      homeDirectory,
      dataDirectory,
      platform: 'darwin',
      architecture: 'arm64',
      ...first,
      smoke: async () => undefined,
    });
    await expect(
      installRuntime({
        homeDirectory,
        dataDirectory,
        platform: 'darwin',
        architecture: 'arm64',
        ...second,
        smoke: async () => {
          throw new Error('SQLite native addon failed to load');
        },
      }),
    ).rejects.toThrow('SQLite native addon failed to load');

    expect(existsSync(installed.nodePath)).toBe(true);
    expect(readFileSync(installed.mcpLauncherPath, 'utf8')).toContain('1.9.0');
    expect(
      existsSync(join(homeDirectory, 'Library/Application Support/Pimpampum/Runtime/2.0.0')),
    ).toBe(false);
  });

  it('FR-1.3/PERF-6: service definitions remain per-user and independent from UI lifetimes', () => {
    // Spec: FR-1.3, PERF-6, EC-14, SEC-1
    const launchd = parsePlist(
      renderLaunchAgent({
        nodePath: '/Users/roberto/Library/Application Support/Pimpampum/Runtime/2.0.0/bin/node',
        cliPath: '/Users/roberto/Library/Application Support/Pimpampum/Runtime/2.0.0/dist/cli.js',
        dataDirectory: '/Users/roberto/.pimpampum',
        host: '127.0.0.1',
        port: 7337,
        logDirectory: '/Users/roberto/.pimpampum/logs',
      }),
    );
    const systemd = parseSystemdUnit(
      renderSystemdUnit({
        nodePath: '/home/roberto/.local/share/pimpampum/runtime/2.0.0/bin/node',
        cliPath: '/home/roberto/.local/share/pimpampum/runtime/2.0.0/dist/cli.js',
        dataDirectory: '/home/roberto/.pimpampum',
        host: '127.0.0.1',
        port: 7337,
      }),
    );

    // The OS restarts the daemon after a failure and starts it at login; no UI process owns it.
    expect(launchd.RunAtLoad).toBe(true);
    expect(launchd.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(systemd.Service?.Restart).toEqual(['on-failure']);
    expect(systemd.Install?.WantedBy).toEqual(['default.target']);
    // Per-user: a LaunchAgent (not a daemon) and a user unit without `User=`; no token in either.
    expect(systemd.Service?.User).toBeUndefined();
    expect(JSON.stringify([launchd, systemd])).not.toMatch(/User=root|sudo|PIMPAMPUM_TOKEN/u);
  });

  it.todo('PERF-1: completes clean observed setup in under two minutes');
  // Spec: PERF-1, Success metric: download-to-verified-agent time

  it.todo('FR-1.2: proves CLI, serve, SQLite and MCP with an empty external PATH on every target');
  // Spec: FR-1.2, US-1/AC-1, Success metric: external Node/npm requirement

  it.todo('SEC-5: verifies signing, notarization and stapling on a clean macOS release artifact');
  // Spec: SEC-5
});
