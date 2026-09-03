import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCandidateServiceManagerFactory,
  createHealthVerifiedServiceManager,
  createPlatformServiceManagers,
  probeOmarchy,
  serviceArtifactPath,
  type OmarchyProbe,
} from '../src/cliComposition/platformAdapters.js';
import type { PlatformServiceAdapter, PlatformServiceManagerInput } from '../src/service/types.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ok = { exitCode: 0, stdout: '', stderr: '' };

function probeHost(
  platform: NodeJS.Platform,
  found: Record<string, string>,
  runCommand = vi.fn(async () => ok),
) {
  return {
    platform,
    findExecutable: (name: string) => found[name] ?? null,
    runCommand,
  };
}

const BOTH = { omarchy: '/usr/bin/omarchy', 'omarchy-shell': '/usr/bin/omarchy-shell' };

describe('Omarchy probe', () => {
  it('is off outside Linux and without both executables', async () => {
    const darwin = probeHost('darwin', BOTH);
    await expect(probeOmarchy(darwin, 'status')).resolves.toEqual({
      omarchyPath: null,
      omarchyShellPath: null,
      useOmarchy: false,
    });
    const partial = probeHost('linux', { omarchy: '/usr/bin/omarchy' });
    await expect(probeOmarchy(partial, 'status')).resolves.toEqual({
      omarchyPath: '/usr/bin/omarchy',
      omarchyShellPath: null,
      useOmarchy: false,
    });
    expect(partial.runCommand).not.toHaveBeenCalled();
  });

  it('probes only for the verbs that touch the service', async () => {
    const host = probeHost('linux', BOTH);
    await expect(probeOmarchy(host, 'version')).resolves.toMatchObject({ useOmarchy: false });
    expect(host.runCommand).not.toHaveBeenCalled();
  });

  it('accepts version, falls back to --version, and tolerates a hung or incompatible dispatcher', async () => {
    const compatible = probeHost(
      'linux',
      BOTH,
      vi.fn(async () => ({ ...ok, stdout: 'Omarchy 4.0.0\n' })),
    );
    await expect(probeOmarchy(compatible, 'status')).resolves.toMatchObject({ useOmarchy: true });
    expect(compatible.runCommand).toHaveBeenCalledWith('/usr/bin/omarchy', ['version'], {
      timeoutMilliseconds: 5_000,
    });

    const fallback = probeHost(
      'linux',
      BOTH,
      vi
        .fn(async () => ({ ...ok, stdout: 'quattro' }))
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'unknown command' }),
    );
    await expect(probeOmarchy(fallback, 'install')).resolves.toMatchObject({ useOmarchy: true });
    expect(fallback.runCommand).toHaveBeenNthCalledWith(2, '/usr/bin/omarchy', ['--version'], {
      timeoutMilliseconds: 5_000,
    });

    const hung = probeHost(
      'linux',
      BOTH,
      vi.fn(async () => {
        throw new Error('timed out');
      }),
    );
    await expect(probeOmarchy(hung, 'uninstall')).resolves.toMatchObject({ useOmarchy: false });
    expect(hung.runCommand).toHaveBeenCalledOnce();

    const old = probeHost(
      'linux',
      BOTH,
      vi.fn(async () => ({ ...ok, stdout: 'Omarchy 3.1' })),
    );
    await expect(probeOmarchy(old, 'update:check')).resolves.toMatchObject({ useOmarchy: false });
  });
});

function managerInput(platform: NodeJS.Platform): PlatformServiceManagerInput & { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-platform-adapters-'));
  roots.push(root);
  mkdirSync(join(root, 'data'), { mode: 0o700 });
  mkdirSync(join(root, 'plugin'));
  return {
    root,
    platform,
    homeDirectory: root,
    dataDirectory: join(root, 'data'),
    nodePath: process.execPath,
    cliPath: join(root, 'cli.js'),
    version: '1.0.0',
    runCommand: async () => ok,
  };
}

const NO_OMARCHY: OmarchyProbe = { omarchyPath: null, omarchyShellPath: null, useOmarchy: false };

describe('platform service managers', () => {
  it('pairs launchd with the desktop app on macOS and offers a service-only manager', () => {
    const input = managerInput('darwin');
    const managers = createPlatformServiceManagers({
      managerInput: input,
      macOSAppBundlePath: join(input.root, 'Pimpampum.app'),
      omarchy: NO_OMARCHY,
      omarchyPluginSourcePath: join(input.root, 'plugin'),
    });
    expect(managers.managerInput).toBe(input);
    expect(managers.serviceOnlyManager).toBeDefined();
    expect(managers.serviceManager.prepareUninstall).toBeTypeOf('function');
  });

  it.each([
    ['without Omarchy', NO_OMARCHY],
    [
      'with Omarchy present but not answering',
      {
        omarchyPath: '/usr/bin/omarchy',
        omarchyShellPath: '/usr/bin/omarchy-shell',
        useOmarchy: false,
      },
    ],
    [
      'with Omarchy owning the desktop',
      {
        omarchyPath: '/usr/bin/omarchy',
        omarchyShellPath: '/usr/bin/omarchy-shell',
        useOmarchy: true,
      },
    ],
  ])('builds the Linux manager %s and never a service-only one', (_label, omarchy) => {
    const input = managerInput('linux');
    const managers = createPlatformServiceManagers({
      managerInput: input,
      macOSAppBundlePath: join(input.root, 'Pimpampum.app'),
      omarchy,
      omarchyPluginSourcePath: join(input.root, 'plugin'),
    });
    expect(managers.serviceOnlyManager).toBeUndefined();
    expect(managers.serviceManager.status).toBeTypeOf('function');
  });

  /**
   * The packaged runtime ships `dist/` with no `integrations/` beside it, so the composed plugin
   * source does not exist on an installed machine. Every fixture above creates that directory,
   * which is how a constructor that threw on a missing source reached a release: on a real Omarchy
   * host it failed `status`, `install`, `uninstall` and `update` with an internal error.
   */
  it('builds a working Linux manager when the packaged runtime carries no plugin source', async () => {
    const input = managerInput('linux');
    const managers = createPlatformServiceManagers({
      managerInput: input,
      macOSAppBundlePath: join(input.root, 'Pimpampum.app'),
      omarchy: {
        omarchyPath: '/usr/bin/omarchy',
        omarchyShellPath: '/usr/bin/omarchy-shell',
        useOmarchy: true,
      },
      omarchyPluginSourcePath: join(input.root, 'no-build-tree'),
    });
    await expect(managers.serviceManager.status()).resolves.toEqual({
      installed: false,
      running: false,
      adapter: null,
      version: null,
    });
  });

  it('builds an adapterless manager on any other platform', () => {
    const input = managerInput('win32');
    const managers = createPlatformServiceManagers({
      managerInput: input,
      macOSAppBundlePath: join(input.root, 'Pimpampum.app'),
      omarchy: NO_OMARCHY,
      omarchyPluginSourcePath: join(input.root, 'plugin'),
    });
    expect(managers.serviceOnlyManager).toBeUndefined();
  });

  it('derives candidate managers on macOS only', () => {
    const candidate = {
      appBundlePath: '/Applications/.staged/Pimpampum.app',
      version: '2.0.0',
      nodePath: '/runtime/bin/node',
      cliPath: '/runtime/dist/cli.js',
      packagedRuntime: {
        version: '2.0.0',
        target: 'darwin-arm64' as const,
        runtimeDirectory: '/runtime',
      },
    };
    expect(
      createCandidateServiceManagerFactory(managerInput('darwin'))(candidate).install,
    ).toBeTypeOf('function');
    expect(() => createCandidateServiceManagerFactory(managerInput('linux'))(candidate)).toThrow(
      /only activate on macOS/u,
    );
  });

  it('names the service definition for the setup plan', () => {
    expect(serviceArtifactPath('darwin', '/Users/me')).toBe(
      '/Users/me/Library/LaunchAgents/dev.pimpampum.daemon.plist',
    );
    expect(serviceArtifactPath('linux', '/home/me')).toBe(
      '/home/me/.config/systemd/user/pimpampum.service',
    );
  });
});

describe('health-verified service manager', () => {
  it('verifies the installed receipt over loopback instead of re-entering the lifecycle lock', async () => {
    const input = managerInput('linux');
    const adapter: PlatformServiceAdapter = {
      id: 'health-probe',
      platform: 'linux',
      artifacts: () => [{ path: join(input.root, 'service.unit'), content: 'unit', mode: 0o600 }],
      activate: async () => undefined,
      deactivate: async () => undefined,
      isRunning: async () => {
        throw new Error('status re-entered the lifecycle lock during installation');
      },
    };
    const healthVerifier = vi.fn(async () => undefined);
    const manager = createHealthVerifiedServiceManager(
      { ...input, adapters: { linux: adapter } },
      healthVerifier,
    );
    await expect(manager.install()).resolves.toMatchObject({ installed: true });
    expect(healthVerifier).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:7337',
      version: '1.0.0',
    });
  });
});
