import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createClaudeCodeConnector,
  planClaudeCodeConnection,
} from '../src/connectors/claudeCode.js';
import { createCodexConnector } from '../src/connectors/codex.js';
import {
  configurationRevision,
  detectExecutable,
  readHostConfiguration,
  replaceHostConfigurationEntry,
  runBoundedHostCommand,
  sanitizedHostEnvironment,
} from '../src/connectors/process.js';
import { fingerprintCommand } from '../src/connectors/receipt.js';
import type {
  CommandInvocation,
  ConnectionReceipt,
  ConnectorVerification,
  HostEntry,
} from '../src/connectors/types.js';
import { killBridgeProcess, verifyMcpRoute } from '../src/connectors/verifier.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-targeted-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function receipt(connectorId: 'codex' | 'claude-code', entry: HostEntry): ConnectionReceipt {
  return {
    schemaVersion: 1,
    connectorId,
    scope: connectorId === 'codex' ? 'global' : 'user',
    commandFingerprint: fingerprintCommand(entry),
    configuredAt: '2026-08-30T00:00:00.000Z',
    lastVerifiedAt: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeSyntheticMcpServer(
  root: string,
  options?: { oversizedStderr?: boolean; ignoreTermination?: boolean },
): string {
  const executable = join(root, 'synthetic-mcp.mjs');
  const closeMarker = join(root, 'closed.marker');
  const pidFile = join(root, 'server.pid');
  const serverModule = import.meta.resolve('@modelcontextprotocol/server');
  const stdioModule = import.meta.resolve('@modelcontextprotocol/server/stdio');
  writeExecutable(
    executable,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(serverModule)};
import { serveStdio } from ${JSON.stringify(stdioModule)};
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
${options?.oversizedStderr ? `process.stderr.write('x'.repeat(9000));` : `process.stderr.write('safe synthetic diagnostic\\n');`}
${
  options?.ignoreTermination
    ? `process.on('SIGTERM', () => undefined); process.on('SIGINT', () => undefined); process.stdin.on('end', () => setInterval(() => undefined, 1000));`
    : ''
}
const handle = serveStdio(() => {
  const server = new McpServer({ name: 'pimpampum', version: '1.0.0' });
  server.registerTool('project_list', { description: 'synthetic' }, async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  return server;
});
const close = async () => { await handle.close(); process.exit(0); };
process.once('exit', () => writeFileSync(${JSON.stringify(closeMarker)}, 'closed'));
${
  options?.ignoreTermination
    ? ''
    : `process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());`
}
`,
  );
  return executable;
}

async function processGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describe('targeted SDK verifier branches', () => {
  // M-T8: the three synthetic servers are written once for the whole describe instead of once per
  // test; each variant keeps its own directory because the server writes its pid and close marker
  // next to itself.
  let serversRoot = '';
  let defaultServer = { root: '', executable: '' };
  let stubbornServer = { root: '', executable: '' };
  let oversizedServer = { root: '', executable: '' };

  beforeAll(() => {
    serversRoot = mkdtempSync(join(tmpdir(), 'pimpampum-targeted-mcp-servers-'));
    const variant = (
      name: string,
      options?: Parameters<typeof writeSyntheticMcpServer>[1],
    ): { root: string; executable: string } => {
      const root = join(serversRoot, name);
      mkdirSync(root);
      return { root, executable: writeSyntheticMcpServer(root, options) };
    };
    defaultServer = variant('default');
    stubbornServer = variant('stubborn', { ignoreTermination: true });
    oversizedServer = variant('oversized', { oversizedStderr: true });
  });

  afterAll(() => {
    rmSync(serversRoot, { recursive: true, force: true });
  });

  it('verifies and reaps a real synthetic stdio SDK route with bounded stderr', async () => {
    const { root, executable } = defaultServer;
    rmSync(join(root, 'closed.marker'), { force: true });
    await expect(
      verifyMcpRoute({
        command: executable,
        arguments: [],
        timeoutMilliseconds: 3_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list', 'project_list'],
      }),
    ).resolves.toMatchObject({
      available: true,
      serverName: 'pimpampum',
      tools: ['project_list'],
      diagnostics: ['safe synthetic diagnostic'],
    });
    await vi.waitFor(() => expect(existsSync(join(root, 'closed.marker'))).toBe(true));

    await expect(
      verifyMcpRoute({
        command: executable,
        arguments: [],
        timeoutMilliseconds: 3_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
        supportedProtocolVersions: ['synthetic-explicit-only'],
      }),
    ).rejects.toThrow(/incompatible protocol version/iu);
  });

  it('SIGKILLs a real bridge that ignores the graceful close once the shutdown deadline passes', async () => {
    const { root, executable } = stubbornServer;
    await expect(
      verifyMcpRoute({
        command: process.execPath,
        arguments: [executable],
        timeoutMilliseconds: 10_000,
        shutdownTimeoutMilliseconds: 750,
        requiredTools: ['project_list'],
        expectedServerName: 'pimpampum',
      }),
    ).rejects.toThrow(/could not reap the stdio route/iu);
    const pid = Number(readFileSync(join(root, 'server.pid'), 'utf8'));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    await expect(processGone(pid)).resolves.toBe(true);
  }, 15_000);

  it('kills a real child through the default signal of the bridge reaper', async () => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    const exited = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once('exit', (_code, signal) => resolve(signal)),
    );
    killBridgeProcess(child.pid);
    await expect(exited).resolves.toBe('SIGKILL');
  });

  it('fails closed and reaps a real SDK route whose stderr exceeds the diagnostic cap', async () => {
    const { executable } = oversizedServer;
    await expect(
      verifyMcpRoute({
        command: executable,
        arguments: [],
        timeoutMilliseconds: 3_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
      }),
    ).rejects.toThrow(/diagnostics exceeded|oversized output/iu);
  });

  it('covers non-preaborted cancellation and redacts supported safe diagnostics branches', async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    const verification = verifyMcpRoute({
      command: '/synthetic/pimpampum-mcp',
      arguments: [],
      timeoutMilliseconds: 1_000,
      expectedServerName: 'pimpampum',
      requiredTools: ['project_list'],
      signal: controller.signal,
      spawn: () => ({
        requiresProtocolVersion: true,
        initialize: async () => ({
          serverInfo: { name: 'pimpampum' },
          protocolVersion: 'synthetic-v1',
        }),
        listTools: async () => new Promise(() => undefined),
        close,
      }),
      supportedProtocolVersions: ['synthetic-v1'],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(verification).rejects.toThrow(/cancelled/iu);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects NUL arguments/invalid deadlines and catches diagnostics mutated after inspection', async () => {
    await expect(
      verifyMcpRoute({
        command: '/synthetic/pimpampum-mcp',
        arguments: ['bad\0argument'],
        timeoutMilliseconds: 10,
        expectedServerName: 'pimpampum',
        requiredTools: [],
      }),
    ).rejects.toThrow(/NUL/iu);
    for (const timeoutMilliseconds of [0, Number.NaN]) {
      await expect(
        verifyMcpRoute({
          command: '/synthetic/pimpampum-mcp',
          arguments: [],
          timeoutMilliseconds,
          expectedServerName: 'pimpampum',
          requiredTools: [],
          spawn: () => ({
            initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
            listTools: async () => ({ tools: [] }),
            close: async () => undefined,
          }),
        }),
      ).rejects.toThrow(/timeout must be positive/iu);
    }

    const diagnostics: unknown[] = ['safe', 42];
    await expect(
      verifyMcpRoute({
        command: '/synthetic/pimpampum-mcp',
        arguments: [],
        timeoutMilliseconds: 100,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
        spawn: () => ({
          initialize: async () => ({
            serverInfo: { name: 'pimpampum' },
            diagnostics,
          }),
          listTools: async () => {
            diagnostics.push('secret=synthetic-private');
            return { tools: [{ name: 'project_list' }], diagnostics: ['   '] };
          },
          close: async () => undefined,
        }),
      }),
    ).rejects.toThrow(/secret leakage.*diagnostics/iu);
  });

  it('accepts string diagnostics and rejects a probe without server identity or negotiated protocol', async () => {
    // M-T6: these are the verifier's own contracts, driven through its `spawn` seam rather than
    // through spies on the SDK client's prototype.
    const probe = (overrides: {
      serverInfo?: { name: string };
      protocolVersion?: string;
      requiresProtocolVersion?: boolean;
      diagnostics?: unknown;
    }) => ({
      ...(overrides.requiresProtocolVersion === undefined
        ? {}
        : { requiresProtocolVersion: overrides.requiresProtocolVersion }),
      initialize: async () => ({
        ...(overrides.serverInfo === undefined ? {} : { serverInfo: overrides.serverInfo }),
        ...(overrides.protocolVersion === undefined
          ? {}
          : { protocolVersion: overrides.protocolVersion }),
        diagnostics: overrides.diagnostics,
      }),
      listTools: async () => ({ tools: [{ name: 'project_list' }] }),
      close: async () => undefined,
    });
    const verify = (spawnProbe: ReturnType<typeof probe>) =>
      verifyMcpRoute({
        command: '/synthetic/pimpampum-mcp',
        arguments: [],
        timeoutMilliseconds: 1_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
        spawn: () => spawnProbe,
      });

    await expect(
      verify(
        probe({ serverInfo: { name: 'pimpampum' }, diagnostics: 'synthetic string diagnostic' }),
      ),
    ).resolves.toMatchObject({ diagnostics: ['synthetic string diagnostic'] });
    await expect(verify(probe({}))).rejects.toThrow(/identity/iu);
    await expect(
      verify(probe({ serverInfo: { name: 'pimpampum' }, requiresProtocolVersion: true })),
    ).rejects.toThrow(/protocol/iu);
  });

  it('pins the defensive SDK metadata branches inside spawnSdkProbe through prototype spies', async () => {
    // A real server always reports `serverInfo`, negotiates a protocol version and writes Buffer
    // chunks, so the `undefined` and string-chunk arms of `spawnSdkProbe` are unreachable through
    // the synthetic server. `src/` is frozen this wave; the handoff is to make the SDK client
    // injectable (or `v8 ignore` those arms) and delete this test.
    const { executable } = defaultServer;
    const stderr = vi
      .spyOn(StdioClientTransport.prototype, 'stderr', 'get')
      .mockReturnValue(Readable.from(['synthetic string diagnostic']) as never);
    await expect(
      verifyMcpRoute({
        command: executable,
        arguments: [],
        timeoutMilliseconds: 3_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
      }),
    ).resolves.toMatchObject({ diagnostics: ['synthetic string diagnostic'] });
    stderr.mockRestore();

    const immediateOverflowStream = {
      on(event: string, listener: (chunk: string) => void) {
        if (event === 'data') listener('x'.repeat(9_000));
        return immediateOverflowStream;
      },
    };
    const overflowedStderr = vi
      .spyOn(StdioClientTransport.prototype, 'stderr', 'get')
      .mockReturnValue(immediateOverflowStream as never);
    await expect(
      verifyMcpRoute({
        command: executable,
        arguments: [],
        timeoutMilliseconds: 3_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
      }),
    ).rejects.toThrow(/diagnostics exceeded|oversized output/iu);
    overflowedStderr.mockRestore();

    const missingServer = vi.spyOn(Client.prototype, 'getServerVersion').mockReturnValue(undefined);
    await expect(
      verifyMcpRoute({
        command: executable,
        arguments: [],
        timeoutMilliseconds: 3_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
      }),
    ).rejects.toThrow(/identity/iu);
    missingServer.mockRestore();

    const missingProtocol = vi
      .spyOn(Client.prototype, 'getNegotiatedProtocolVersion')
      .mockReturnValue(undefined);
    await expect(
      verifyMcpRoute({
        command: executable,
        arguments: [],
        timeoutMilliseconds: 3_000,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
      }),
    ).rejects.toThrow(/protocol/iu);
    missingProtocol.mockRestore();
  });

  it('rejects credential-shaped arguments before spawning and forwards safe ones to the probe', async () => {
    for (const argument of ['Authorization: synthetic-credential', 'Bearer synthetic-credential']) {
      await expect(
        verifyMcpRoute({
          command: defaultServer.executable,
          arguments: [argument],
          timeoutMilliseconds: 10,
          expectedServerName: 'pimpampum',
          requiredTools: [],
        }),
      ).rejects.toThrow(/secrets.*arguments/iu);
    }

    await expect(
      verifyMcpRoute({
        command: '/synthetic/pimpampum-mcp',
        arguments: ['--safe-argument'],
        timeoutMilliseconds: 100,
        expectedServerName: 'pimpampum',
        requiredTools: ['project_list'],
        spawn: (_command, arguments_) => ({
          initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
          listTools: async () => ({ tools: [{ name: 'project_list' }] }),
          close: async () => undefined,
          diagnostics: () => [`received ${arguments_.join(' ')}`],
        }),
      }),
    ).resolves.toMatchObject({ diagnostics: ['received --safe-argument'] });
  });
});

describe('targeted process branches', () => {
  it('rejects executable directories and all invalid private-mode variants', async () => {
    const root = temporaryDirectory('process-modes');
    await expect(
      detectExecutable({
        id: 'codex',
        names: ['codex'],
        boundedLocations: [root],
        path: '',
        timeoutMilliseconds: 20,
        run: async () => ({ exitCode: 0, stdout: 'version' }),
      }),
    ).resolves.toEqual({ executable: null, supported: false, versionOutput: null });
    mkdirSync(join(root, 'codex'));
    await expect(
      detectExecutable({
        id: 'codex',
        names: ['codex'],
        boundedLocations: [root],
        path: '',
        timeoutMilliseconds: 20,
        run: async () => ({ exitCode: 0, stdout: 'version' }),
      }),
    ).resolves.toEqual({ executable: null, supported: false, versionOutput: null });

    for (const mode of [0.5, -1, 0o1000, 0o606]) {
      await expect(
        replaceHostConfigurationEntry({
          path: join(root, `${mode}.json`),
          expectedRevision: null,
          mode,
          update: () => ({}),
        }),
      ).rejects.toThrow(/private/iu);
    }
  });

  it('detects deletion of an existing config during the revision-checked replace', async () => {
    const root = temporaryDirectory('process-delete-race');
    const path = join(root, 'config.json');
    writeFileSync(path, '{"before":true}', { mode: 0o600 });
    const revision = configurationRevision(path);
    await expect(
      replaceHostConfigurationEntry({
        path,
        expectedRevision: revision,
        mode: 0o600,
        update: () => {
          unlinkSync(path);
          return { after: true };
        },
      }),
    ).rejects.toThrow(/changed concurrently/iu);
  });

  it('covers process-group fallback, repeated termination, escalation, and missing exit codes', async () => {
    expect(sanitizedHostEnvironment({ HOME: '/synthetic/home' })).toEqual({
      HOME: '/synthetic/home',
      PATH: '',
    });

    const fakeChild = (pid: number | undefined, kill: () => boolean) => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number | undefined;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = pid;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(kill);
      return child;
    };
    const spawnFor = (child: ReturnType<typeof fakeChild>) =>
      vi.fn(() => child) as unknown as typeof import('node:child_process').spawn;

    // The 250 ms termination grace runs on fake timers, so the SIGKILL escalation is asserted at
    // the exact deadline instead of after a real sleep. A child that never reported a pid receives
    // no signal at all; the deadline only clears its escalation timer.
    vi.useFakeTimers();
    const noPid = fakeChild(undefined, () => true);
    try {
      const escalated = runBoundedHostCommand(
        { executable: '/synthetic/host', arguments: [] },
        { timeoutMilliseconds: 1_000, maxOutputBytes: 1, spawnProcess: spawnFor(noPid) },
      );
      noPid.stdout.emit('data', 'too large');
      noPid.stderr.emit('data', 'repeated termination');
      await vi.advanceTimersByTimeAsync(250);
      expect(noPid.kill).not.toHaveBeenCalled();
      noPid.emit('close', null, null);
      await expect(escalated).rejects.toThrow(/output exceeded/iu);
    } finally {
      vi.useRealTimers();
    }

    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('synthetic group signal failure');
    });
    const fallback = fakeChild(999_999, () => {
      throw new Error('synthetic child signal failure');
    });
    const failed = runBoundedHostCommand(
      { executable: '/synthetic/host', arguments: [] },
      { timeoutMilliseconds: 1_000, maxOutputBytes: 1, spawnProcess: spawnFor(fallback) },
    );
    fallback.stdout.emit('data', Buffer.from('too large'));
    fallback.emit('close', null, null);
    await expect(failed).rejects.toThrow(/output exceeded/iu);
    expect(processKill).toHaveBeenCalled();
    expect(fallback.kill).toHaveBeenCalled();

    processKill.mockRestore();
    const clean = fakeChild(12, () => true);
    const completed = runBoundedHostCommand(
      { executable: '/synthetic/host', arguments: [] },
      { timeoutMilliseconds: 1_000, spawnProcess: spawnFor(clean) },
    );
    clean.emit('close', null, null);
    await expect(completed).resolves.toMatchObject({ exitCode: 1 });

    // Windows signals the child directly, so the escalation is observable on `kill`: SIGTERM at
    // the output overflow, SIGKILL exactly when the 250 ms grace ends.
    vi.useFakeTimers();
    const windows = fakeChild(13, () => true);
    try {
      const windowsFailure = runBoundedHostCommand(
        { executable: '/synthetic/windows-host.exe', arguments: [] },
        {
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 1,
          spawnProcess: spawnFor(windows),
          platform: 'win32',
        },
      );
      windows.stdout.emit('data', 'too large');
      expect(windows.kill.mock.calls).toEqual([['SIGTERM']]);
      await vi.advanceTimersByTimeAsync(249);
      expect(windows.kill.mock.calls).toEqual([['SIGTERM']]);
      await vi.advanceTimersByTimeAsync(1);
      expect(windows.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
      windows.emit('close', null, null);
      await expect(windowsFailure).rejects.toThrow(/output exceeded/iu);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates non-missing path lookup errors before creating a temporary file', async () => {
    const root = temporaryDirectory('process-enotdir');
    const parentFile = join(root, 'not-a-directory');
    writeFileSync(parentFile, 'regular file');
    await expect(
      replaceHostConfigurationEntry({
        path: join(parentFile, 'config.json'),
        expectedRevision: null,
        mode: 0o600,
        update: () => ({}),
      }),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('enforces post-open regular-file/size checks and closes failed temporary descriptors', async () => {
    const root = temporaryDirectory('process-read-seams');
    const config = join(root, 'config.json');
    writeFileSync(config, '{}', { mode: 0o600 });
    expect(() =>
      readHostConfiguration(config, 100, {
        metadata: (_descriptor, actual) => ({ ...actual, isFile: () => false }) as typeof actual,
      }),
    ).toThrow(/regular file/iu);
    expect(() =>
      readHostConfiguration(config, 4, {
        contents: () => Buffer.from('12345'),
      }),
    ).toThrow(/bounded size/iu);

    const target = join(root, 'new.json');
    await expect(
      replaceHostConfigurationEntry({
        path: target,
        expectedRevision: null,
        mode: 0o600,
        update: () => ({}),
        afterTemporaryOpen: () => {
          throw new Error('synthetic post-open I/O failure');
        },
      }),
    ).rejects.toThrow(/post-open I\/O failure/iu);
    expect(readdirSync(root).filter((name) => name.endsWith('.pimpampum.tmp'))).toEqual([]);
  });
});

describe('targeted Codex branches', () => {
  function createCodexFixture(input?: {
    get?: { exitCode: number; stdout: string; stderr: string };
    list?: { exitCode: number; stdout: string; stderr: string };
    supportsGet?: boolean;
    supportsList?: boolean;
    storedReceipt?: ConnectionReceipt | null;
    receiptWriteRejects?: boolean;
    receiptRemoveRejects?: boolean;
    removeFailure?: boolean;
  }) {
    const root = temporaryDirectory('codex');
    const executable = join(root, 'codex');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    let storedReceipt = input?.storedReceipt ?? null;
    let supportsGet = input?.supportsGet ?? true;
    let supportsList = input?.supportsList ?? false;
    const run = vi.fn(async (invocation: CommandInvocation) => {
      const args = invocation.arguments;
      if (args[0] === '--version') return { exitCode: 0, stdout: 'codex 1.0.0', stderr: '' };
      if (args.at(-1) === '--help') {
        const feature = args[1];
        const supported =
          feature === 'get'
            ? supportsGet
            : feature === 'list'
              ? supportsList
              : feature === 'add' || feature === 'remove';
        return {
          exitCode: supported ? 0 : 1,
          stdout: supported && (feature === 'get' || feature === 'list') ? '--json' : '',
          stderr: '',
        };
      }
      if (args[1] === 'get') {
        return (
          input?.get ?? {
            exitCode: 1,
            stdout: '',
            stderr: "No MCP server named 'pimpampum' found.",
          }
        );
      }
      if (args[1] === 'list') {
        return input?.list ?? { exitCode: 0, stdout: '[]', stderr: '' };
      }
      if (args[1] === 'remove' && input?.removeFailure) {
        return { exitCode: 9, stdout: '', stderr: 'synthetic remove rejection' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const connector = createCodexConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      boundedLocations: [root],
      path: root,
      requiredTools: [],
      run,
      verify: async () => ({
        available: false,
        serverName: 'pimpampum',
        tools: [],
        diagnostics: [],
      }),
      receipt: {
        read: async () => storedReceipt,
        write: async (value) => {
          if (input?.receiptWriteRejects) throw new Error('synthetic receipt write rejection');
          storedReceipt = value;
        },
        remove: async () => {
          if (input?.receiptRemoveRejects) throw new Error('synthetic receipt remove rejection');
          storedReceipt = null;
        },
      },
    });
    return {
      connector,
      executable,
      run,
      setSupports: (get: boolean, list: boolean) => {
        supportsGet = get;
        supportsList = list;
      },
    };
  }

  it('fails closed on malformed get/list JSON, wrong target, list failure, and lost inspect support', async () => {
    const cases = [
      createCodexFixture({ get: { exitCode: 0, stdout: '{bad', stderr: '' } }),
      createCodexFixture({ get: { exitCode: 0, stdout: '{}', stderr: '' } }),
      createCodexFixture({ get: { exitCode: 1, stdout: '', stderr: 'synthetic failure' } }),
      createCodexFixture({
        supportsGet: false,
        supportsList: true,
        list: { exitCode: 0, stdout: '{bad', stderr: '' },
      }),
      createCodexFixture({
        supportsGet: false,
        supportsList: true,
        list: { exitCode: 0, stdout: '{}', stderr: '' },
      }),
      createCodexFixture({
        supportsGet: false,
        supportsList: true,
        list: { exitCode: 1, stdout: '', stderr: 'failed' },
      }),
    ];
    for (const fixture of cases) {
      await expect(fixture.connector.inspect()).rejects.toMatchObject({
        code: 'unavailable',
        status: 503,
        details: { connectorId: 'codex' },
      });
    }

    // Detection and its feature probe are memoized per instance: a host that changes its answers
    // after detection cannot flip the connector into a different inspection strategy.
    const lost = createCodexFixture();
    const detection = await lost.connector.detect();
    expect(detection.supported).toBe(true);
    lost.setSupports(false, false);
    await expect(lost.connector.inspect()).resolves.toMatchObject({ state: 'notConnected' });
    expect(lost.run.mock.calls.filter(([call]) => call.arguments.at(-1) === '--help')).toHaveLength(
      4,
    );
  });

  it('covers default bounded runner and neutral/unavailable restore paths', async () => {
    const root = temporaryDirectory('codex-default-run');
    const executable = join(root, 'codex');
    writeExecutable(
      executable,
      `#!/bin/sh
case "$*" in
  "--version") echo "codex 1.0.0" ;;
  "mcp get --help"|"mcp list --help") echo "--json" ;;
  "mcp add --help"|"mcp remove --help") echo "Usage" ;;
  *) exit 1 ;;
esac
`,
    );
    const connector = createCodexConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      boundedLocations: [root],
      path: root,
      requiredTools: [],
      receipt: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(connector.detect()).resolves.toMatchObject({ executable, supported: true });

    // The detection is reused; a CLI that vanishes afterwards surfaces as one typed host failure.
    unlinkSync(executable);
    await expect(connector.plan()).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringMatching(
        /Codex configuration could not be inspected: spawn .* ENOENT/u,
      ),
    });
    await expect(
      connector.restore({ connectorId: 'codex', revision: null, entry: null }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('executes best-effort receipt rollback catch callbacks for absent and prior receipts', async () => {
    const absent = createCodexFixture({ receiptRemoveRejects: true });
    await expect(absent.connector.connect(await absent.connector.plan())).rejects.toThrow(
      /persist|verification/iu,
    );

    const expectedEntry: HostEntry = {
      command: '/synthetic/pimpampum-mcp',
      arguments: [],
      scope: 'global',
    };
    const prior = createCodexFixture({
      get: {
        exitCode: 0,
        stdout: JSON.stringify({
          name: 'pimpampum',
          transport: { type: 'stdio', command: expectedEntry.command, args: [] },
        }),
        stderr: '',
      },
      storedReceipt: receipt('codex', expectedEntry),
      receiptWriteRejects: true,
    });
    await expect(prior.connector.connect(await prior.connector.plan())).rejects.toThrow();
  });

  it('rejects official restore removal failure and a replacement plan missing its fingerprint', async () => {
    const expectedEntry: HostEntry = {
      command: '/synthetic/pimpampum-mcp',
      arguments: [],
      scope: 'global',
    };
    const currentJson = JSON.stringify({
      name: 'pimpampum',
      transport: { type: 'stdio', command: expectedEntry.command, args: [] },
    });
    const removal = createCodexFixture({
      get: { exitCode: 0, stdout: currentJson, stderr: '' },
      removeFailure: true,
    });
    await expect(
      removal.connector.restore({
        connectorId: 'codex',
        revision: null,
        entry: { command: '/synthetic/prior', arguments: [], scope: 'global' },
      }),
    ).rejects.toThrow(/could not remove the Pimpampum MCP entry: synthetic remove rejection/iu);

    const conflictJson = JSON.stringify({
      name: 'pimpampum',
      transport: { type: 'stdio', command: '/synthetic/conflict', args: [] },
    });
    const conflict = createCodexFixture({
      get: { exitCode: 0, stdout: conflictJson, stderr: '' },
    });
    const replacement = await conflict.connector.plan({ conflictDecision: 'replace' });
    const withoutFingerprint = { ...replacement };
    delete withoutFingerprint.reviewedEntryFingerprint;
    await expect(conflict.connector.connect(withoutFingerprint)).rejects.toThrow(/changed/iu);
  });

  it('reuses one detection across plan and connect, so a vanished CLI fails at persistence', async () => {
    const root = temporaryDirectory('codex-disappears');
    const executable = join(root, 'codex');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    let getCount = 0;
    let versionCalls = 0;
    const run = async (invocation: CommandInvocation) => {
      const args = invocation.arguments;
      if (args[0] === '--version') {
        versionCalls += 1;
        return { exitCode: 0, stdout: 'codex 1.0.0', stderr: '' };
      }
      if (args.at(-1) === '--help') {
        return {
          exitCode: 0,
          stdout: args[1] === 'get' || args[1] === 'list' ? '--json' : '',
          stderr: '',
        };
      }
      if (args[1] === 'get') {
        getCount += 1;
        if (getCount === 2) unlinkSync(executable);
        return { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const connector = createCodexConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      boundedLocations: [root],
      path: root,
      requiredTools: [],
      run,
      receipt: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const plan = await connector.plan();
    await expect(connector.connect(plan)).rejects.toThrow(/did not persist/iu);
    expect(versionCalls).toBe(1);
  });

  it('probes the host features once per connector instance', async () => {
    const root = temporaryDirectory('codex-probe-change');
    const executable = join(root, 'codex');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    let helpCalls = 0;
    const connector = createCodexConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      boundedLocations: [root],
      path: root,
      requiredTools: [],
      run: async (invocation) => {
        const args = invocation.arguments;
        if (args[0] === '--version') return { exitCode: 0, stdout: 'codex 1.0.0', stderr: '' };
        if (args.at(-1) === '--help') {
          const detectionBatch = helpCalls < 4;
          helpCalls += 1;
          const inspectFeature = args[1] === 'get' || args[1] === 'list';
          return {
            exitCode: inspectFeature ? (detectionBatch ? 0 : 1) : 0,
            stdout: inspectFeature && detectionBatch ? '--json' : '',
            stderr: '',
          };
        }
        if (args[1] === 'get') {
          return { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      receipt: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(connector.inspect()).resolves.toMatchObject({ state: 'notConnected' });
    await expect(connector.plan()).resolves.toMatchObject({ state: 'notConnected' });
    expect(helpCalls).toBe(4);
  });

  it('takes the version from the single detection probe and never runs --version twice', async () => {
    const root = temporaryDirectory('codex-version-exit');
    const executable = join(root, 'codex');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    let versionCalls = 0;
    const connector = createCodexConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      boundedLocations: [root],
      path: root,
      requiredTools: [],
      run: async (invocation) => {
        if (invocation.arguments[0] === '--version') {
          versionCalls += 1;
          return { exitCode: 0, stdout: '  codex 1.0.0\n', stderr: '' };
        }
        if (invocation.arguments[1] === 'get' && invocation.arguments.at(-1) !== '--help') {
          return { exitCode: 1, stdout: '', stderr: "No MCP server named 'pimpampum' found." };
        }
        return { exitCode: 0, stdout: '--json', stderr: '' };
      },
      receipt: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(connector.detect()).resolves.toMatchObject({
      version: 'codex 1.0.0',
      supported: true,
    });
    await connector.inspect();
    expect(versionCalls).toBe(1);
  });
});

describe('targeted Claude Code branches', () => {
  it('covers defensive direct-plan and missing-config inspection branches', async () => {
    expect(
      planClaudeCodeConnection({
        executable: '/synthetic/claude',
        supported: true,
        launcherPath: '/synthetic/pimpampum-mcp',
        inspection: null,
        higherPrecedenceEntry: null,
        receipt: { ...receipt('codex', { command: 'x', arguments: [], scope: 'global' }) },
      }),
    ).toMatchObject({ state: 'notConnected' });

    const root = temporaryDirectory('claude-missing-config');
    const executable = join(root, 'claude');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    const run = async (invocation: CommandInvocation) => ({
      exitCode: 0,
      stdout: invocation.arguments[0] === '--version' ? '2.1.251' : '--scope user',
      stderr: '',
      signal: null,
    });
    const connector = createClaudeCodeConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      userConfigPath: join(root, 'missing.json'),
      boundedExecutableLocations: [root],
      pathValue: root,
      runCommand: run,
      verifyRoute: async () => verification(),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(connector.inspect()).resolves.toMatchObject({
      state: 'notConnected',
      entry: null,
    });
  });

  it('covers unsupported inspection and local-before-project sorting branches', async () => {
    const root = temporaryDirectory('claude-sources');
    const executable = join(root, 'claude');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    const user = join(root, 'user.json');
    const local = join(root, 'local.json');
    const project = join(root, 'project.json');
    writeFileSync(user, '{"mcpServers":{}}', { mode: 0o600 });
    writeFileSync(local, '{"mcpServers":{}}', { mode: 0o600 });
    writeFileSync(
      project,
      '{"mcpServers":{"pimpampum":{"command":"/synthetic/project","args":[]}}}',
      { mode: 0o600 },
    );
    const unsupported = createClaudeCodeConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      userConfigPath: user,
      boundedExecutableLocations: [root],
      pathValue: root,
      runCommand: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.arguments[0] === '--version' ? 'development' : '--scope user',
        stderr: '',
        signal: null,
      }),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(unsupported.inspect()).resolves.toMatchObject({ state: 'unsupportedVersion' });

    const connector = createClaudeCodeConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      userConfigPath: user,
      boundedExecutableLocations: [root],
      pathValue: root,
      higherPrecedenceConfigSources: [
        { path: project, scope: 'project' },
        { path: local, scope: 'local' },
      ],
      runCommand: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.arguments[0] === '--version' ? '2.1.251' : '--scope user',
        stderr: '',
        signal: null,
      }),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(connector.inspect()).resolves.toMatchObject({
      state: 'conflict',
      higherPrecedenceEntry: { command: '/synthetic/project', scope: 'project' },
    });
  });

  it('covers default runner/default verifier/default clock against synthetic CLIs and MCP', async () => {
    const root = temporaryDirectory('claude-defaults');
    const cli = join(root, 'claude');
    writeExecutable(
      cli,
      `#!/bin/sh
case "$*" in
  "--version") echo "2.1.251" ;;
  "mcp get --help") echo "--json" ;;
  "mcp add-json --help"|"mcp add --help"|"mcp remove --help") echo "--scope user" ;;
  *) exit 1 ;;
esac
`,
    );
    const mcp = writeSyntheticMcpServer(root);
    const config = join(root, 'config.json');
    writeFileSync(config, '{"mcpServers":{}}', { mode: 0o600 });
    const connector = createClaudeCodeConnector({
      launcherPath: mcp,
      userConfigPath: config,
      boundedExecutableLocations: [root],
      pathValue: root,
      requiredTools: ['project_list'],
      timeoutMilliseconds: 3_000,
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(connector.detect()).resolves.toMatchObject({ executable: cli, supported: true });
    await expect(connector.verify()).resolves.toMatchObject({
      available: true,
      connectorId: 'claude-code',
      verifiedAt: expect.any(String),
    });

    const defaultClock = createClaudeCodeConnector({
      launcherPath: mcp,
      userConfigPath: config,
      boundedExecutableLocations: [root],
      pathValue: root,
      verifyRoute: async () => verification(),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(defaultClock.verify()).resolves.toMatchObject({ available: true });

    const defaultRequiredTools = createClaudeCodeConnector({
      launcherPath: mcp,
      userConfigPath: config,
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(defaultRequiredTools.verify()).rejects.toThrow(/missing required/iu);
  });

  it('executes rollback catch callbacks when restore and receipt cleanup also fail', async () => {
    const root = temporaryDirectory('claude-catch');
    const executable = join(root, 'claude');
    const config = join(root, 'config.json');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    writeFileSync(config, '{"mcpServers":{}}', { mode: 0o600 });
    let mutationCount = 0;
    const run = vi.fn(async (invocation: CommandInvocation) => {
      const args = invocation.arguments;
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: '2.1.251', stderr: '', signal: null };
      }
      if (args.at(-1) === '--help') {
        return { exitCode: 0, stdout: '--scope user', stderr: '', signal: null };
      }
      if (args[1] === 'add-json') {
        mutationCount += 1;
        if (mutationCount === 1) {
          const target = JSON.parse(args.at(-1)!) as unknown;
          writeFileSync(config, JSON.stringify({ mcpServers: { pimpampum: target } }));
          return { exitCode: 0, stdout: '', stderr: '', signal: null };
        }
        return { exitCode: 9, stdout: '', stderr: 'restore rejected', signal: null };
      }
      if (args[1] === 'remove') {
        return { exitCode: 9, stdout: '', stderr: 'rollback rejected', signal: null };
      }
      return { exitCode: 0, stdout: '', stderr: '', signal: null };
    });
    const connector = createClaudeCodeConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      userConfigPath: config,
      boundedExecutableLocations: [root],
      pathValue: root,
      runCommand: run,
      verifyRoute: async () => verification(false),
      receiptStore: {
        read: async () => null,
        write: async () => {
          throw new Error('receipt write rejected');
        },
        remove: async () => {
          throw new Error('receipt remove rejected');
        },
      },
    });
    await expect(connector.connect(await connector.plan())).rejects.toThrow(
      /verification|receipt write/iu,
    );
  });

  it('executes disconnect rollback catch when receipt removal and restoration both fail', async () => {
    const root = temporaryDirectory('claude-disconnect-catch');
    const executable = join(root, 'claude');
    const config = join(root, 'config.json');
    const expectedEntry: HostEntry = {
      command: '/synthetic/pimpampum-mcp',
      arguments: [],
      scope: 'user',
    };
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: { pimpampum: { command: expectedEntry.command, args: [], env: {} } },
      }),
      { mode: 0o600 },
    );
    const run = async (invocation: CommandInvocation) => {
      const args = invocation.arguments;
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: '2.1.251', stderr: '', signal: null };
      }
      if (args.at(-1) === '--help') {
        return { exitCode: 0, stdout: '--scope user', stderr: '', signal: null };
      }
      if (args[1] === 'remove') {
        writeFileSync(config, '{"mcpServers":{}}', { mode: 0o600 });
        return { exitCode: 0, stdout: '', stderr: '', signal: null };
      }
      if (args[1] === 'add-json') {
        return { exitCode: 9, stdout: '', stderr: 'restore rejected', signal: null };
      }
      return { exitCode: 0, stdout: '', stderr: '', signal: null };
    };
    const connector = createClaudeCodeConnector({
      launcherPath: expectedEntry.command,
      userConfigPath: config,
      boundedExecutableLocations: [root],
      pathValue: root,
      runCommand: run,
      verifyRoute: async () => verification(),
      receiptStore: {
        read: async () => receipt('claude-code', expectedEntry),
        write: async () => undefined,
        remove: async () => {
          throw new Error('receipt removal rejected');
        },
      },
    });
    const error = await connector.disconnect().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/disconnect and rollback failed/iu);
    expect((error as AggregateError).errors.map((item) => (item as Error).message)).toEqual([
      'receipt removal rejected',
      expect.stringMatching(/could not restore the Pimpampum MCP entry: restore rejected/iu),
    ]);
  });

  it('treats config without mcpServers as absent and covers default discovery option fallbacks', async () => {
    const root = temporaryDirectory('claude-default-discovery');
    const executable = join(root, 'claude');
    const config = join(root, 'config.json');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    writeFileSync(config, '{"theme":"dark"}', { mode: 0o600 });
    const previousPath = process.env.PATH;
    process.env.PATH = root;
    try {
      const connector = createClaudeCodeConnector({
        launcherPath: '/synthetic/pimpampum-mcp',
        userConfigPath: config,
        runCommand: async (invocation) => ({
          exitCode: 0,
          stdout: invocation.arguments[0] === '--version' ? '' : '',
          stderr: '',
          signal: null,
        }),
        receiptStore: {
          read: async () => null,
          write: async () => undefined,
          remove: async () => undefined,
        },
      });
      await expect(connector.detect()).resolves.toMatchObject({
        executable,
        version: null,
        supported: false,
        capabilities: { scopes: [] },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const supported = createClaudeCodeConnector({
      launcherPath: '/synthetic/pimpampum-mcp',
      userConfigPath: config,
      boundedExecutableLocations: [root],
      pathValue: root,
      runCommand: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.arguments[0] === '--version' ? '2.1.251' : '--scope user',
        stderr: '',
        signal: null,
      }),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    await expect(supported.inspect()).resolves.toMatchObject({
      state: 'notConnected',
      entry: null,
    });
  });

  it('executes prior-receipt rollback cleanup and rejects a replacement missing review proof', async () => {
    const root = temporaryDirectory('claude-prior-cleanup');
    const executable = join(root, 'claude');
    const config = join(root, 'config.json');
    const expectedEntry: HostEntry = {
      command: '/synthetic/pimpampum-mcp',
      arguments: [],
      scope: 'user',
    };
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    writeFileSync(
      config,
      JSON.stringify({ mcpServers: { pimpampum: { command: expectedEntry.command, args: [] } } }),
      { mode: 0o600 },
    );
    const run = async (invocation: CommandInvocation) => ({
      exitCode: 0,
      stdout: invocation.arguments[0] === '--version' ? '2.1.251' : '--scope user',
      stderr: '',
      signal: null,
    });
    const priorReceipt = receipt('claude-code', expectedEntry);
    const connector = createClaudeCodeConnector({
      launcherPath: expectedEntry.command,
      userConfigPath: config,
      boundedExecutableLocations: [root],
      pathValue: root,
      runCommand: run,
      verifyRoute: async () => verification(false),
      receiptStore: {
        read: async () => priorReceipt,
        write: async () => {
          throw new Error('synthetic prior receipt write rejection');
        },
        remove: async () => undefined,
      },
    });
    await expect(connector.connect(await connector.plan())).rejects.toThrow(/verification/iu);

    writeFileSync(
      config,
      '{"mcpServers":{"pimpampum":{"command":"/synthetic/conflict","args":[]}}}',
      { mode: 0o600 },
    );
    const noReceiptConnector = createClaudeCodeConnector({
      launcherPath: expectedEntry.command,
      userConfigPath: config,
      boundedExecutableLocations: [root],
      pathValue: root,
      runCommand: run,
      verifyRoute: async () => verification(),
      receiptStore: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const replacement = await noReceiptConnector.plan({ conflictDecision: 'replace' });
    const withoutFingerprint = { ...replacement };
    delete withoutFingerprint.reviewedEntryFingerprint;
    await expect(noReceiptConnector.connect(withoutFingerprint)).rejects.toThrow(/changed/iu);
  });

  it('uses an empty sanitized PATH when neither caller nor process supplies one', async () => {
    const root = temporaryDirectory('claude-empty-path');
    const previousPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const connector = createClaudeCodeConnector({
        launcherPath: '/synthetic/pimpampum-mcp',
        userConfigPath: join(root, 'missing.json'),
        runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '', signal: null }),
        receiptStore: {
          read: async () => null,
          write: async () => undefined,
          remove: async () => undefined,
        },
      });
      await expect(connector.detect()).resolves.toMatchObject({ executable: null });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('orders every local/project comparator pairing deterministically', async () => {
    const root = temporaryDirectory('claude-comparator');
    const executable = join(root, 'claude');
    const user = join(root, 'user.json');
    const local = join(root, 'local.json');
    const project = join(root, 'project.json');
    writeExecutable(executable, '#!/bin/sh\nexit 0\n');
    for (const path of [user, local, project]) {
      writeFileSync(path, '{"mcpServers":{}}', { mode: 0o600 });
    }
    const run = async (invocation: CommandInvocation) => ({
      exitCode: 0,
      stdout: invocation.arguments[0] === '--version' ? '2.1.251' : '--scope user',
      stderr: '',
      signal: null,
    });
    const pairs = [
      [
        { path: project, scope: 'project' as const },
        { path: local, scope: 'local' as const },
      ],
      [
        { path: local, scope: 'local' as const },
        { path: project, scope: 'project' as const },
      ],
      [
        { path: local, scope: 'local' as const },
        { path: local, scope: 'local' as const },
      ],
      [
        { path: project, scope: 'project' as const },
        { path: project, scope: 'project' as const },
      ],
    ];
    for (const higherPrecedenceConfigSources of pairs) {
      const connector = createClaudeCodeConnector({
        launcherPath: '/synthetic/pimpampum-mcp',
        userConfigPath: user,
        higherPrecedenceConfigSources,
        boundedExecutableLocations: [root],
        pathValue: root,
        runCommand: run,
        receiptStore: {
          read: async () => null,
          write: async () => undefined,
          remove: async () => undefined,
        },
      });
      await expect(connector.inspect()).resolves.toMatchObject({ state: 'notConnected' });
    }
  });
});

function verification(available = true): ConnectorVerification {
  return {
    connectorId: 'claude-code',
    available,
    verifiedAt: '2026-08-31T00:00:00.000Z',
    serverName: available ? 'pimpampum' : null,
    tools: available ? ['project_list'] : [],
    diagnostics: [],
  };
}
