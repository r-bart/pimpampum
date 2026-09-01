import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConcretePackagedProvider } from '../src/cliMain.js';
import { installRuntime } from '../src/runtime/installer.js';
import {
  installReceiptPath,
  readInstallReceipt,
  writeInstallReceipt,
} from '../src/service/receipt.js';
import type { RuntimeManifest } from '../src/runtime/types.js';
import type { PackagedRuntimeMetadata, ServiceManager } from '../src/service/types.js';

const roots: string[] = [];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function runtime(root: string, version: string) {
  const runtimeRoot = join(root, 'PimpampumRuntime');
  const sourceDirectory = join(runtimeRoot, 'payload');
  const contents = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': `export const version = ${JSON.stringify(version)};\n`,
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': `addon-${version}`,
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
  writeFileSync(join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { runtimeRoot, sourceDirectory, manifest };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-packaged-update-'));
  roots.push(root);
  const homeDirectory = join(root, 'home');
  const dataDirectory = join(root, 'data');
  const applications = join(homeDirectory, 'Applications');
  const installedApp = join(applications, 'Pimpampum.app');
  mkdirSync(installedApp, { recursive: true });
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(join(installedApp, 'old-bytes'), 'old-application-bytes');
  const previous = runtime(join(root, 'previous'), '1.1.3');
  const previousInstallation = await installRuntime({
    homeDirectory,
    dataDirectory,
    platform: 'darwin',
    architecture: 'arm64',
    sourceDirectory: previous.sourceDirectory,
    manifest: previous.manifest,
    smoke: async () => undefined,
  });
  writeInstallReceipt(
    installReceiptPath(dataDirectory),
    {
      schemaVersion: 1,
      adapter: 'launchd-macos-app',
      platform: 'darwin',
      version: '1.1.3',
      installationKey: 'a'.repeat(64),
      installedAt: '2026-08-31T10:00:00.000Z',
      nodePath: previousInstallation.nodePath,
      cliPath: previousInstallation.cliPath,
      dataDirectory,
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(dataDirectory, 'logs'),
      artifacts: [],
      updateProvider: 'packaged-release',
      packagedRuntime: {
        version: '1.1.3',
        target: 'darwin-arm64',
        runtimeDirectory: dirname(dirname(previousInstallation.nodePath)),
      },
    },
    dataDirectory,
  );
  const stagingRoot = mkdtempSync(join(applications, '.pimpampum-update-'));
  const candidatePath = join(stagingRoot, 'candidate');
  const app = join(candidatePath, 'Pimpampum.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'PimpampumMenuBar'), 'binary', { mode: 0o755 });
  const next = runtime(join(app, 'Contents', 'Resources'), '2.0.0');
  const plugin = join(candidatePath, 'pimpampum-status');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'Widget.qml'), 'Item {}\n');
  writeFileSync(
    join(plugin, 'runtime-manifest.json'),
    JSON.stringify({ version: '2.0.0', targets: { 'linux-arm64': {} } }),
  );
  const currentServiceManager: ServiceManager = {
    install: vi.fn(async () => ({ installed: true as const, reconciled: true, receiptPath: '' })),
    status: vi.fn(async () => ({
      installed: true,
      running: true,
      adapter: 'launchd-macos-app',
      version: '1.1.3',
    })),
    uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
  };
  return {
    root,
    homeDirectory,
    dataDirectory,
    installedApp,
    candidatePath,
    previousInstallation,
    next,
    currentServiceManager,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('packaged update transaction', () => {
  it.each([false, true])(
    'activates the candidate private runtime and preserves the previous app on late failure=%s',
    async (lateFailure) => {
      const value = await fixture();
      const createCandidateServiceManager = vi.fn(
        (candidate: {
          version: string;
          nodePath: string;
          cliPath: string;
          packagedRuntime: PackagedRuntimeMetadata;
        }): ServiceManager => ({
          install: vi.fn(async () => {
            mkdirSync(value.installedApp, { recursive: true });
            writeFileSync(join(value.installedApp, 'new-bytes'), 'new-application-bytes');
            writeInstallReceipt(
              installReceiptPath(value.dataDirectory),
              {
                schemaVersion: 1,
                adapter: 'launchd-macos-app',
                platform: 'darwin',
                version: candidate.version,
                installationKey: 'b'.repeat(64),
                installedAt: '2026-08-31T11:00:00.000Z',
                nodePath: candidate.nodePath,
                cliPath: candidate.cliPath,
                dataDirectory: value.dataDirectory,
                baseUrl: 'http://127.0.0.1:7337',
                logDirectory: join(value.dataDirectory, 'logs'),
                artifacts: [],
                updateProvider: 'packaged-release',
                ...(lateFailure ? {} : { packagedRuntime: candidate.packagedRuntime }),
              },
              value.dataDirectory,
            );
            return { installed: true as const, reconciled: true, receiptPath: '' };
          }),
          status: vi.fn(async () => ({
            installed: true,
            running: true,
            adapter: 'launchd-macos-app',
            version: '2.0.0',
          })),
          uninstall: vi.fn(async () => ({ uninstalled: true, dataPreserved: true as const })),
        }),
      );
      const provider = createConcretePackagedProvider({
        currentVersion: '1.1.3',
        dataDirectory: value.dataDirectory,
        homeDirectory: value.homeDirectory,
        target: 'darwin-arm64',
        nodePath: value.previousInstallation.nodePath,
        npmPath: null,
        runCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
        currentServiceManager: value.currentServiceManager,
        createCandidateServiceManager,
      });

      const operation = provider.reconcile({
        version: '2.0.0',
        candidatePath: value.candidatePath,
        target: 'darwin-arm64',
        sha256: 'c'.repeat(64),
        signature: 'signature',
      });
      if (lateFailure) {
        await expect(operation).rejects.toThrow(/receipt did not commit/iu);
        expect(readFileSync(join(value.installedApp, 'old-bytes'), 'utf8')).toBe(
          'old-application-bytes',
        );
        expect(existsSync(join(value.installedApp, 'new-bytes'))).toBe(false);
        expect(
          JSON.parse(
            readFileSync(join(value.dataDirectory, 'runtime-install-receipt.json'), 'utf8'),
          ),
        ).toMatchObject({ currentVersion: '1.1.3' });
        expect(
          readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
        ).toMatchObject({ version: '1.1.3', nodePath: value.previousInstallation.nodePath });
        expect(value.currentServiceManager.install).toHaveBeenCalledOnce();
      } else {
        await expect(operation).resolves.toBeUndefined();
        const candidate = createCandidateServiceManager.mock.calls[0]![0];
        expect(candidate.nodePath).toContain('/Runtime/2.0.0/darwin-arm64/bin/node');
        expect(candidate.packagedRuntime).toMatchObject({
          version: '2.0.0',
          target: 'darwin-arm64',
          runtimeDirectory: expect.stringContaining('/Runtime/2.0.0/darwin-arm64'),
        });
        expect(
          readInstallReceipt(installReceiptPath(value.dataDirectory), value.dataDirectory),
        ).toMatchObject({
          version: '2.0.0',
          nodePath: candidate.nodePath,
          updateProvider: 'packaged-release',
          packagedRuntime: candidate.packagedRuntime,
        });
      }
    },
  );
});
