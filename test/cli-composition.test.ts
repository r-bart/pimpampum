import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeCliRuntime,
  compositionFailure,
  type CompositionDependencies,
} from '../src/cliComposition/composeCliRuntime.js';
import {
  describeRuntimeTarget,
  resolveEntryPaths,
  type CliHost,
} from '../src/cliComposition/host.js';
import { createProcessHost, runCliEntrypoint } from '../src/cliMain.js';
import type { RuntimeConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { installReceiptPath } from '../src/service/receipt.js';
import { PIMPAMPUM_VERSION } from '../src/version.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ok = { exitCode: 0, stdout: '', stderr: '' };

function fixture(overrides: Partial<CliHost> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-cli-composition-'));
  roots.push(root);
  const homeDirectory = join(root, 'home');
  const checkout = join(root, 'checkout');
  const dataDirectory = join(root, 'data');
  mkdirSync(homeDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(checkout, 'dist'), { recursive: true });
  mkdirSync(join(checkout, 'integrations', 'omarchy', 'pimpampum-status'), { recursive: true });
  // Port 1 is never a daemon, so a client that does connect fails fast instead of finding one.
  const config: RuntimeConfig = {
    host: '127.0.0.1',
    port: 1,
    dataDirectory,
    databasePath: join(dataDirectory, 'pimpampum.sqlite'),
    token: '',
    baseUrl: 'http://127.0.0.1:1',
  };
  const recorded = {
    out: [] as string[],
    err: [] as string[],
    exits: [] as number[],
    signals: new Map<string, () => void>(),
    exitHooks: [] as Array<() => void>,
  };
  const host: CliHost = {
    platform: 'darwin',
    arch: 'arm64',
    homeDirectory,
    execPath: process.execPath,
    entryModulePath: join(checkout, 'dist', 'cli.js'),
    argv: ['version'],
    env: {},
    cwd: root,
    uid: undefined,
    findExecutable: () => null,
    runCommand: vi.fn(async () => ok),
    createCommandRunner: vi.fn(() => host.runCommand),
    config: {
      client: () => config,
      daemon: () => ({
        ...config,
        port: 0,
        databasePath: ':memory:',
        token: 'daemon-token'.repeat(3),
      }),
    },
    stdin: Readable.from(['{"tool":"input"}']),
    stdout: (text) => {
      recorded.out.push(text);
    },
    stderr: (text) => {
      recorded.err.push(text);
    },
    onSignal: (signal, callback) => {
      recorded.signals.set(signal, callback);
    },
    onExit: (callback) => {
      recorded.exitHooks.push(callback);
    },
    exit: ((code: number) => {
      recorded.exits.push(code);
    }) as CliHost['exit'],
    startStdioBridge: vi.fn(async () => undefined),
    ...overrides,
  };
  return { root, homeDirectory, checkout, dataDirectory, config, recorded, host };
}

function stagerStub(root: string) {
  const cleanup = vi.fn();
  const stage = vi.fn(async () => ({
    appBundlePath: join(root, 'staged', 'Pimpampum.app'),
    version: PIMPAMPUM_VERSION,
    cleanup,
  }));
  const dependencies: CompositionDependencies = {
    stageMacOSApplication: stage as unknown as CompositionDependencies['stageMacOSApplication'],
  };
  return { stage, cleanup, dependencies };
}

/**
 * A real packaged install: the app bundle carries `PimpampumRuntime`, whose manifest names the two
 * entrypoints the host then reports as its own Node and CLI. Returns the bundle the bootstrap must
 * find, so a verb that would otherwise download one uses it instead.
 */
function packagedRuntime(value: ReturnType<typeof fixture>): string {
  const application = join(value.root, 'Pimpampum.app');
  const runtimeRoot = join(application, 'Contents', 'Resources', 'PimpampumRuntime');
  const payload = join(runtimeRoot, 'payload');
  const contents = {
    'bin/node': '#!/bin/sh\nexit 0\n',
    'dist/cli.js': 'export const cli = true;\n',
    'dist/mcpStdio.js': 'export const mcp = true;\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'addon',
  };
  for (const [path, content] of Object.entries(contents)) {
    const destination = join(payload, ...path.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { mode: path === 'bin/node' ? 0o755 : 0o644 });
  }
  writeFileSync(
    join(runtimeRoot, 'runtime-manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      pimpampumVersion: PIMPAMPUM_VERSION,
      nodeVersion: '24.19.0',
      target: { platform: 'darwin', architecture: 'arm64' },
      unpackedBytes: Object.values(contents).reduce(
        (total, content) => total + Buffer.byteLength(content),
        0,
      ),
      entrypoints: { node: 'bin/node', cli: 'dist/cli.js', mcp: 'dist/mcpStdio.js' },
      files: Object.entries(contents).map(([path, content]) => ({
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        mode: path === 'bin/node' ? 0o755 : 0o644,
        size: Buffer.byteLength(content),
      })),
    }),
    { mode: 0o644 },
  );
  value.host.entryModulePath = join(payload, 'dist', 'cli.js');
  value.host.execPath = join(payload, 'bin', 'node');
  return application;
}

/** A directory where the runtime manifest should be a file makes the packaged bootstrap refuse. */
function breakPackagedBootstrap(value: ReturnType<typeof fixture>): void {
  mkdirSync(join(value.root, 'runtime-manifest.json'));
}

describe('host descriptions', () => {
  it('maps platform and architecture to the packaged runtime targets', () => {
    expect(describeRuntimeTarget('darwin', 'arm64')).toEqual({
      supported: true,
      platform: 'darwin',
      architecture: 'arm64',
      packagedRelease: 'darwin-arm64',
    });
    expect(describeRuntimeTarget('linux', 'x64')).toMatchObject({ packagedRelease: 'linux-x64' });
    expect(describeRuntimeTarget('linux', 'arm64')).toMatchObject({
      packagedRelease: 'linux-arm64',
    });
    expect(describeRuntimeTarget('darwin', 'x64')).toEqual({ supported: false });
    expect(describeRuntimeTarget('win32', 'x64')).toEqual({ supported: false });
    expect(describeRuntimeTarget('linux', 'ia32')).toEqual({ supported: false });
  });

  it('resolves the compiled siblings from a source entry and from a compiled one', () => {
    expect(resolveEntryPaths('/repo/src/cli.ts')).toEqual({
      compiledCliPath: '/repo/dist/cli.js',
      compiledMcpStdioPath: '/repo/dist/mcpStdio.js',
      builtMacOSAppPath: '/repo/platforms/macos/dist/Pimpampum.app',
      bundledOmarchyPluginPath: '/repo/integrations/omarchy/pimpampum-status',
    });
    expect(resolveEntryPaths('/opt/pimpampum/dist/cli.js')).toMatchObject({
      compiledCliPath: '/opt/pimpampum/dist/cli.js',
      compiledMcpStdioPath: '/opt/pimpampum/dist/mcpStdio.js',
    });
  });
});

describe('composition failures', () => {
  it('keeps typed errors and wraps plain ones with the remedy for the install kind', () => {
    const typed = new AppError('conflict', 'busy', 409);
    expect(compositionFailure(typed, 'npm', 'darwin')).toBe(typed);
    const npm = compositionFailure(new Error('receipt torn'), 'npm', 'darwin');
    expect(npm).toMatchObject({
      code: 'unavailable',
      status: 503,
      message: expect.stringMatching(
        /^receipt torn\. Reinstall with `npm install --global pimpampum`/u,
      ),
      details: expect.objectContaining({ phase: 'composition', installKind: 'npm' }),
    });
    expect(compositionFailure(new Error('x'), 'packaged', 'darwin').message).toMatch(
      /Reinstall the Pimpampum app/u,
    );
    expect(compositionFailure(new Error('x'), 'packaged', 'linux').message).toMatch(
      /pimpampum-bootstrap/u,
    );
    expect(compositionFailure('string failure', 'npm', 'linux').message).toMatch(
      /^Lifecycle composition failed\./u,
    );
  });
});

describe('composed runtime', () => {
  it('describes the client configuration without touching the filesystem', async () => {
    const value = fixture();
    const runtime = await composeCliRuntime(value.host);
    expect(runtime.describeConfig()).toEqual({
      dataDirectory: value.dataDirectory,
      databasePath: join(value.dataDirectory, 'pimpampum.sqlite'),
      baseUrl: 'http://127.0.0.1:1',
      tokenPath: join(value.dataDirectory, 'token'),
      tokenSource: 'file',
      tokenConfigured: false,
      mcp: {
        streamableHttpUrl: 'http://127.0.0.1:1/mcp',
        stdio: { command: process.execPath, args: [join(value.checkout, 'dist', 'mcpStdio.js')] },
      },
    });
    expect(existsSync(value.dataDirectory)).toBe(false);
    const fromEnvironment = fixture({ env: { PIMPAMPUM_TOKEN: ' t ' } });
    expect((await composeCliRuntime(fromEnvironment.host)).describeConfig()).toMatchObject({
      tokenPath: null,
      tokenSource: 'environment',
    });
  });

  it('fails typed for daemon clients until the token exists, then builds them', async () => {
    const value = fixture();
    const runtime = await composeCliRuntime(value.host);
    expect(() => runtime.createClient()).toThrowError(
      expect.objectContaining({
        code: 'unavailable',
        details: { tokenPath: join(value.dataDirectory, 'token') },
      }),
    );
    await expect(runtime.createAgentClient()).rejects.toMatchObject({ code: 'unavailable' });

    const withToken = fixture();
    withToken.host.config.client = () => ({ ...withToken.config, token: 'x'.repeat(32) });
    const ready = await composeCliRuntime(withToken.host);
    expect(ready.createClient().health).toBeTypeOf('function');
    await expect(ready.createAgentClient()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('forwards the process seams to the host', async () => {
    const value = fixture();
    const runtime = await composeCliRuntime(value.host);
    const file = join(value.root, 'body.md');
    writeFileSync(file, 'body');
    expect(runtime.readFile(file)).toBe('body');
    expect(() => runtime.readFile(file, 3)).toThrowError(
      expect.objectContaining({ code: 'payload_too_large' }),
    );
    await expect(runtime.readStdin()).resolves.toBe('{"tool":"input"}');
    const bounded = fixture({ stdin: Readable.from(['{"tool":"input"}']) });
    await expect((await composeCliRuntime(bounded.host)).readStdin(3)).rejects.toMatchObject({
      code: 'payload_too_large',
    });
    expect(runtime.resolvePath('notes')).toBe(join(value.root, 'notes'));
    runtime.stdout('out');
    runtime.stderr('err');
    const onSignal = vi.fn();
    runtime.onSignal('SIGINT', onSignal);
    runtime.exit(2);
    await runtime.startStdioBridge();
    expect(value.recorded).toMatchObject({ out: ['out'], err: ['err'], exits: [2] });
    expect(value.recorded.signals.get('SIGINT')).toBe(onSignal);
    expect(value.host.startStdioBridge).toHaveBeenCalledOnce();
  });

  it('boots the daemon from the host daemon configuration for serve', async () => {
    const value = fixture();
    mkdirSync(value.dataDirectory, { mode: 0o700 });
    const runtime = await composeCliRuntime(value.host);
    const running = await runtime.startServer();
    try {
      expect(running.config.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    } finally {
      await running.close();
    }
  });

  it('composes the macOS lifecycle lazily and creates the data directory once touched', async () => {
    const value = fixture();
    const runtime = await composeCliRuntime(value.host);
    expect(existsSync(value.dataDirectory)).toBe(false);
    const manager = runtime.serviceManager;
    expect(existsSync(value.dataDirectory)).toBe(true);
    expect(runtime.serviceOnlyManager).toBeDefined();
    expect(runtime.connections).toBeDefined();
    expect(runtime.setup).toBeDefined();
    expect(runtime.updateManager.check).toBeTypeOf('function');
    expect(value.host.createCommandRunner).toHaveBeenCalledWith({ timeoutMilliseconds: 600_000 });
    await expect(manager.status()).resolves.toMatchObject({ installed: false });
    await expect(runtime.connections!.list()).resolves.toHaveLength(2);
  });

  it('composes the Linux lifecycle with Omarchy when the probe confirms a compatible release', async () => {
    const value = fixture({
      platform: 'linux',
      arch: 'x64',
      argv: ['status'],
      findExecutable: (name) => `/usr/bin/${name}`,
      runCommand: vi.fn(async () => ({ ...ok, stdout: 'Omarchy 4.0.0' })),
    });
    const runtime = await composeCliRuntime(value.host);
    expect(value.host.runCommand).toHaveBeenCalledWith('/usr/bin/omarchy', ['version'], {
      timeoutMilliseconds: 5_000,
    });
    expect(runtime.serviceManager.uninstall).toBeTypeOf('function');
    expect(runtime.serviceOnlyManager).toBeUndefined();
    expect(runtime.setup).toBeDefined();
  });

  it('keeps systemd alone when Omarchy is absent, silent, or not asked', async () => {
    const silent = fixture({
      platform: 'linux',
      arch: 'arm64',
      argv: ['install'],
      findExecutable: (name) => `/usr/bin/${name}`,
      runCommand: vi.fn(async () => {
        throw new Error('timed out');
      }),
    });
    expect((await composeCliRuntime(silent.host)).serviceManager.install).toBeTypeOf('function');
    const absent = fixture({ platform: 'linux', arch: 'x64', argv: ['status'] });
    expect((await composeCliRuntime(absent.host)).serviceManager.status).toBeTypeOf('function');
    const unasked = fixture({
      platform: 'linux',
      arch: 'x64',
      argv: ['version'],
      findExecutable: (name) => `/usr/bin/${name}`,
    });
    await composeCliRuntime(unasked.host);
    expect(unasked.host.runCommand).not.toHaveBeenCalled();
  });

  it('offers no connectors or setup on a host without a packaged runtime', async () => {
    const windows = fixture({ platform: 'win32', arch: 'x64', argv: ['status'] });
    const runtime = await composeCliRuntime(windows.host);
    expect(runtime.connections).toBeUndefined();
    expect(runtime.setup).toBeUndefined();
    expect(runtime.serviceOnlyManager).toBeUndefined();
    expect(runtime.updateManager.check).toBeTypeOf('function');
    const intel = fixture({ arch: 'x64', argv: ['install'] });
    const intelRuntime = await composeCliRuntime(intel.host, stagerStub(intel.root).dependencies);
    expect(intelRuntime.connections).toBeUndefined();
    expect(intelRuntime.serviceOnlyManager).toBeDefined();
  });

  it('stages the macOS app for install and setup apply only while the built bundle is missing', async () => {
    const value = fixture({ argv: ['install'] });
    const { stage, cleanup, dependencies } = stagerStub(value.root);
    const runtime = await composeCliRuntime(value.host, dependencies);
    expect(stage).toHaveBeenCalledWith({
      homeDirectory: value.homeDirectory,
      dataDirectory: value.dataDirectory,
      version: PIMPAMPUM_VERSION,
      runCommand: value.host.runCommand,
      environment: value.host.env,
      currentUid: undefined,
    });
    expect(value.recorded.exitHooks).toHaveLength(1);
    value.recorded.exitHooks[0]!();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(runtime.serviceManager.install).toBeTypeOf('function');

    const apply = fixture({ argv: ['setup', 'apply', 'operation', 'revision', '--yes'] });
    const applyStager = stagerStub(apply.root);
    await composeCliRuntime(apply.host, applyStager.dependencies);
    expect(applyStager.stage).toHaveBeenCalledOnce();

    for (const argv of [['install', '--service-only'], ['setup', 'plan'], ['status']]) {
      const other = fixture({ argv });
      const otherStager = stagerStub(other.root);
      await composeCliRuntime(other.host, otherStager.dependencies);
      expect(otherStager.stage).not.toHaveBeenCalled();
    }

    const built = fixture({ argv: ['install'] });
    mkdirSync(join(built.checkout, 'platforms', 'macos', 'dist', 'Pimpampum.app'), {
      recursive: true,
    });
    const builtStager = stagerStub(built.root);
    await composeCliRuntime(built.host, builtStager.dependencies);
    expect(builtStager.stage).not.toHaveBeenCalled();
  });

  it('reports a corrupt install receipt as the update verb failure', async () => {
    const value = fixture({ argv: ['update:check'] });
    mkdirSync(value.dataDirectory, { mode: 0o700 });
    writeFileSync(installReceiptPath(value.dataDirectory), 'not json', { mode: 0o600 });
    const runtime = await composeCliRuntime(value.host);
    expect(() => runtime.updateManager).toThrowError(
      expect.objectContaining({ message: expect.stringMatching(/not valid JSON/u) }),
    );
  });

  it('composes a packaged install from the runtime and app bundle that carry the CLI', async () => {
    const value = fixture({ argv: ['install'] });
    const application = packagedRuntime(value);
    mkdirSync(value.dataDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(installReceiptPath(value.dataDirectory), 'not json', { mode: 0o600 });
    const { stage, dependencies } = stagerStub(value.root);

    const runtime = await composeCliRuntime(value.host, dependencies);
    // The bundle around the packaged runtime is the install source, so nothing is downloaded.
    expect(stage).not.toHaveBeenCalled();
    expect(existsSync(application)).toBe(true);
    expect(runtime.serviceManager.status).toBeTypeOf('function');
    expect(runtime.connections).toBeDefined();
    expect(runtime.setup).toBeDefined();
    // A receipt failure stays the receipt's own typed error, never the composition remedy.
    expect(() => runtime.updateManager).toThrowError(
      expect.objectContaining({ code: 'invalid_state' }),
    );
  });

  it('treats an empty argument list as no verb at all', async () => {
    const value = fixture({ argv: [] });
    const runtime = await composeCliRuntime(value.host);
    expect(runtime.describeConfig()).toMatchObject({ dataDirectory: value.dataDirectory });
  });

  it('reports a packaged runtime that does not fit this CLI with the packaged remedy', async () => {
    const value = fixture({ argv: ['status'] });
    breakPackagedBootstrap(value);
    const runtime = await composeCliRuntime(value.host);
    expect(() => runtime.serviceManager).toThrowError(
      expect.objectContaining({
        code: 'unavailable',
        message: expect.stringMatching(/bounded regular file\. Reinstall the Pimpampum app/u),
        details: expect.objectContaining({ phase: 'composition', installKind: 'packaged' }),
      }),
    );
    expect(() => runtime.updateManager).toThrowError(
      expect.objectContaining({ code: 'unavailable' }),
    );
  });
});

describe('entry point', () => {
  it('runs the verb against the composed runtime', async () => {
    const value = fixture();
    await runCliEntrypoint(pathToFileURL(value.host.entryModulePath).href, value.host);
    expect(JSON.parse(value.recorded.out[0]!)).toEqual({
      data: { name: 'pimpampum', version: PIMPAMPUM_VERSION },
    });
    expect(value.recorded.exits).toEqual([]);
  });

  it('prints a composition failure as one local envelope and exits 1', async () => {
    const value = fixture({ argv: ['install'] });
    breakPackagedBootstrap(value);
    await runCliEntrypoint(pathToFileURL(value.host.entryModulePath).href, value.host);
    expect(value.recorded.out).toEqual([]);
    expect(JSON.parse(value.recorded.err[0]!)).toMatchObject({
      error: { code: 'unavailable', details: { phase: 'composition', installKind: 'packaged' } },
    });
    expect(value.recorded.exits).toEqual([1]);
  });

  it('builds the host from the process by default', async () => {
    const value = fixture();
    const argv = process.argv;
    process.argv = [argv[0]!, 'cli', 'version'];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runCliEntrypoint(pathToFileURL(value.host.entryModulePath).href);
    } finally {
      process.argv = argv;
    }
    expect(write).toHaveBeenCalledOnce();
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toEqual({
      data: { name: 'pimpampum', version: PIMPAMPUM_VERSION },
    });
  });

  it('gathers every process seam into the host', () => {
    const value = fixture();
    vi.stubEnv('PIMPAMPUM_DATA_DIR', join(value.root, 'daemon-data'));
    const host = createProcessHost(pathToFileURL('/repo/dist/cli.js').href);
    expect(host).toMatchObject({
      platform: process.platform,
      arch: process.arch,
      homeDirectory: homedir(),
      execPath: process.execPath,
      entryModulePath: '/repo/dist/cli.js',
      cwd: process.cwd(),
      uid: process.getuid?.(),
    });
    expect(host.argv).toEqual(process.argv.slice(2));
    expect(host.env).toBe(process.env);
    expect(host.stdin).toBe(process.stdin);
    expect(host.findExecutable('definitely-not-installed-anywhere')).toBeNull();
    expect(host.createCommandRunner({ timeoutMilliseconds: 10 })).toBeTypeOf('function');
    expect(host.config.daemon().dataDirectory).toBe(join(value.root, 'daemon-data'));
    expect(existsSync(join(value.root, 'daemon-data', 'token'))).toBe(true);
    expect(host.config.client().token.length).toBeGreaterThanOrEqual(32);

    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    host.stdout('o');
    host.stderr('e');
    expect(out).toHaveBeenCalledWith('o');
    expect(err).toHaveBeenCalledWith('e');
    const callback = () => undefined;
    host.onSignal('SIGTERM', callback);
    expect(process.listeners('SIGTERM')).toContain(callback);
    process.removeListener('SIGTERM', callback);
    host.onExit(callback);
    expect(process.listeners('exit')).toContain(callback);
    process.removeListener('exit', callback);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    host.exit(3);
    expect(exit).toHaveBeenCalledWith(3);
  });
});
