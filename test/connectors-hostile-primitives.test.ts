import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configurationRevision,
  detectExecutable,
  readHostConfiguration,
  replaceHostConfigurationEntry,
  runBoundedHostCommand,
  sanitizeExecutablePath,
  sanitizedHostEnvironment,
} from '../src/connectors/process.js';
import { classifyConnectorOwnership, fingerprintCommand } from '../src/connectors/receipt.js';
import type { ConnectionReceipt, HostEntry } from '../src/connectors/types.js';
import { verifyMcpRoute } from '../src/connectors/verifier.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-hostile-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('hostile connector process and filesystem boundaries', () => {
  it('normalizes only absolute unique PATH entries and carries only NUL-free safe environment', () => {
    const first = join(tmpdir(), 'one', '..', 'bin');
    const second = join(tmpdir(), 'second');
    expect(
      sanitizeExecutablePath(
        ['', 'relative', first, `${first}\0poison`, first, second].join(delimiter),
      ),
    ).toBe([first, second].join(delimiter));
    expect(
      sanitizedHostEnvironment(
        {
          PATH: ['relative', first].join(delimiter),
          HOME: '/synthetic/home',
          LANG: 'en_US.UTF-8',
          USER: 'synthetic\0poison',
          NODE_OPTIONS: '--require hostile.js',
          PIMPAMPUM_TOKEN: 'synthetic-secret',
        },
        [second, 'relative'].join(delimiter),
      ),
    ).toEqual({ PATH: second, HOME: '/synthetic/home', LANG: 'en_US.UTF-8' });
  });

  it('rejects path, argument, timeout, and output-limit injection before spawning', async () => {
    const cases = [
      runBoundedHostCommand({ executable: 'node', arguments: [] }, { timeoutMilliseconds: 10 }),
      runBoundedHostCommand(
        { executable: `${process.execPath}\0suffix`, arguments: [] },
        { timeoutMilliseconds: 10 },
      ),
      runBoundedHostCommand(
        { executable: process.execPath, arguments: ['bad\0argument'] },
        { timeoutMilliseconds: 10 },
      ),
      runBoundedHostCommand(
        { executable: process.execPath, arguments: ['Bearer synthetic-credential'] },
        { timeoutMilliseconds: 10 },
      ),
      runBoundedHostCommand(
        { executable: process.execPath, arguments: [] },
        { timeoutMilliseconds: 0 },
      ),
      runBoundedHostCommand(
        { executable: process.execPath, arguments: [] },
        { timeoutMilliseconds: 10, maxOutputBytes: Number.NaN },
      ),
    ];
    for (const result of cases) await expect(result).rejects.toThrow();
  });

  it('captures both streams and rejects a missing absolute executable without hanging', async () => {
    await expect(
      runBoundedHostCommand(
        {
          executable: process.execPath,
          arguments: [
            '-e',
            'process.stdout.write("out");process.stderr.write("err");process.exitCode=7',
          ],
          environment: { PATH: '/usr/bin', NODE_OPTIONS: '--require hostile.js' },
        },
        { timeoutMilliseconds: 1_000 },
      ),
    ).resolves.toMatchObject({ exitCode: 7, stdout: 'out', stderr: 'err' });
    await expect(
      runBoundedHostCommand(
        { executable: join(tmpdir(), 'definitely-missing-host-cli'), arguments: [] },
        { timeoutMilliseconds: 100 },
      ),
    ).rejects.toThrow();
  });

  it('fails executable probes closed for absent, invalid, rejected, and stalled probes', async () => {
    const root = temporaryDirectory('probes');
    const executable = join(root, 'codex');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await expect(
      detectExecutable({
        id: 'codex',
        names: ['', '../codex', 'codex\0bad'],
        boundedLocations: [root, 'relative'],
        path: 'relative',
        timeoutMilliseconds: 10,
        run: async () => ({ exitCode: 0, stdout: 'unexpected' }),
      }),
    ).resolves.toEqual({ executable: null, supported: false, versionOutput: null });
    await expect(
      detectExecutable({
        id: 'codex',
        names: ['codex'],
        boundedLocations: [root],
        path: '',
        timeoutMilliseconds: 10,
        run: async () => ({ exitCode: 1, stdout: 'version' }),
      }),
    ).resolves.toEqual({ executable, supported: false, versionOutput: null });
    await expect(
      detectExecutable({
        id: 'codex',
        names: ['codex'],
        boundedLocations: [root],
        path: '',
        timeoutMilliseconds: 10,
        run: async () => {
          throw new Error('synthetic probe failure');
        },
      }),
    ).resolves.toEqual({ executable, supported: false, versionOutput: null });
    await expect(
      detectExecutable({
        id: 'codex',
        names: ['codex'],
        boundedLocations: [root],
        path: '',
        timeoutMilliseconds: 5,
        run: async () => new Promise(() => undefined),
      }),
    ).resolves.toEqual({ executable, supported: false, versionOutput: null });
  });

  it('rejects directories, FIFO, symlink, malformed, oversized, and invalid-bound reads', () => {
    const root = temporaryDirectory('reads');
    const regular = join(root, 'regular.json');
    writeFileSync(regular, '{}', { mode: 0o600 });
    expect(() => readHostConfiguration('relative.json')).toThrow(/absolute/iu);
    expect(() => readHostConfiguration(`${regular}\0suffix`)).toThrow(/absolute/iu);
    expect(() => readHostConfiguration(root)).toThrow(/regular file/iu);
    expect(() => readHostConfiguration(regular, 0)).toThrow(/positive/iu);

    const malformed = join(root, 'malformed.json');
    writeFileSync(malformed, '{bad-json', { mode: 0o600 });
    expect(() => readHostConfiguration(malformed)).toThrow(/valid JSON/iu);
    const oversized = join(root, 'oversized.json');
    writeFileSync(oversized, '123456789', { mode: 0o600 });
    expect(() => readHostConfiguration(oversized, 4)).toThrow(/bounded size/iu);

    const symlink = join(root, 'link.json');
    symlinkSync(regular, symlink);
    expect(() => readHostConfiguration(symlink)).toThrow(/symlink/iu);
    const dangling = join(root, 'dangling.json');
    symlinkSync(join(root, 'missing.json'), dangling);
    expect(() => readHostConfiguration(dangling)).toThrow(/symlink/iu);

    if (process.platform !== 'win32') {
      const fifo = join(root, 'config.fifo');
      execFileSync('/usr/bin/mkfifo', [fifo]);
      expect(() => readHostConfiguration(fifo)).toThrow(/regular file/iu);
    }
  });

  it('rejects unsafe writes, undefined/oversized updates, and both creation races', async () => {
    const root = temporaryDirectory('writes');
    const missing = join(root, 'missing.json');
    await expect(
      replaceHostConfigurationEntry({
        path: 'relative.json',
        expectedRevision: null,
        mode: 0o600,
        update: () => ({}),
      }),
    ).rejects.toThrow(/absolute/iu);
    await expect(
      replaceHostConfigurationEntry({
        path: missing,
        expectedRevision: null,
        mode: 0o644,
        update: () => ({}),
      }),
    ).rejects.toThrow(/private/iu);
    await expect(
      replaceHostConfigurationEntry({
        path: missing,
        expectedRevision: 'sha256:stale',
        mode: 0o600,
        update: () => ({}),
      }),
    ).rejects.toThrow(/revision/iu);
    await expect(
      replaceHostConfigurationEntry({
        path: missing,
        expectedRevision: null,
        mode: 0o600,
        update: () => undefined,
      }),
    ).rejects.toThrow(/produce JSON/iu);
    await expect(
      replaceHostConfigurationEntry({
        path: missing,
        expectedRevision: null,
        mode: 0o600,
        update: () => ({ value: 'x'.repeat(16 * 1024 * 1024 + 1) }),
      }),
    ).rejects.toThrow(/bounded size/iu);

    await expect(
      replaceHostConfigurationEntry({
        path: missing,
        expectedRevision: null,
        mode: 0o600,
        update: () => {
          writeFileSync(missing, '{"concurrent":true}', { mode: 0o600 });
          return { planned: true };
        },
      }),
    ).rejects.toThrow(/concurrent/iu);
    expect(readFileSync(missing, 'utf8')).toBe('{"concurrent":true}');

    const existing = join(root, 'existing.json');
    writeFileSync(existing, '{"before":true}', { mode: 0o600 });
    const revision = configurationRevision(existing);
    await expect(
      replaceHostConfigurationEntry({
        path: existing,
        expectedRevision: revision,
        mode: 0o600,
        update: () => {
          writeFileSync(existing, '{"concurrent":true}', { mode: 0o600 });
          return { planned: true };
        },
      }),
    ).rejects.toThrow(/concurrent/iu);
    expect(readFileSync(existing, 'utf8')).toBe('{"concurrent":true}');
    chmodSync(existing, 0o600);
  });
});

const route = {
  command: '/synthetic/runtime/bin/pimpampum-mcp',
  arguments: [] as string[],
  timeoutMilliseconds: 100,
  requiredTools: ['project_list'],
  expectedServerName: 'pimpampum',
};

function successfulProbe(overrides: Record<string, unknown> = {}) {
  return {
    initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
    listTools: async () => ({ tools: [{ name: 'project_list' }] }),
    close: async () => undefined,
    ...overrides,
  };
}

describe('hostile MCP protocol and diagnostic boundaries', () => {
  it('rejects launcher and required-tool injection before trusting the route', async () => {
    const cases = [
      verifyMcpRoute({ ...route, command: 'relative', spawn: () => successfulProbe() }),
      verifyMcpRoute({
        ...route,
        command: `${route.command}\0bad`,
        spawn: () => successfulProbe(),
      }),
      verifyMcpRoute({
        ...route,
        arguments: ['Authorization: Bearer synthetic-secret'],
        spawn: () => successfulProbe(),
      }),
      verifyMcpRoute({
        ...route,
        requiredTools: Array.from({ length: 513 }, (_, index) => `tool_${index}`),
        spawn: () => successfulProbe(),
      }),
    ];
    for (const result of cases) await expect(result).rejects.toThrow();
  });

  it('rejects cyclic, oversized, malformed, and excessive protocol payloads and always closes', async () => {
    const cyclic: Record<string, unknown> = { serverInfo: { name: 'pimpampum' } };
    cyclic.self = cyclic;
    const cases = [
      successfulProbe({ initialize: async () => cyclic }),
      successfulProbe({
        initialize: async () => ({ serverInfo: { name: 'pimpampum' }, pad: 'x'.repeat(1_000_001) }),
      }),
      successfulProbe({ listTools: async () => ({}) }),
      successfulProbe({
        listTools: async () => ({ tools: Array.from({ length: 513 }, () => ({ name: 'x' })) }),
      }),
      successfulProbe({ listTools: async () => ({ tools: [null] }) }),
      successfulProbe({ listTools: async () => ({ tools: [{ name: '' }] }) }),
      successfulProbe({ listTools: async () => ({ tools: [{ name: 'x'.repeat(129) }] }) }),
    ];
    for (const probe of cases) {
      const close = vi.fn(probe.close);
      await expect(
        verifyMcpRoute({ ...route, spawn: () => ({ ...probe, close }) }),
      ).rejects.toThrow();
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('enforces explicit protocol negotiation and bounded required names', async () => {
    await expect(
      verifyMcpRoute({
        ...route,
        supportedProtocolVersions: ['synthetic-v1'],
        spawn: () =>
          successfulProbe({
            requiresProtocolVersion: true,
            initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
          }),
      }),
    ).rejects.toThrow(/protocol/iu);
    await expect(
      verifyMcpRoute({
        ...route,
        requiredTools: [''],
        spawn: () => successfulProbe(),
      }),
    ).rejects.toThrow(/required/iu);
    await expect(
      verifyMcpRoute({
        ...route,
        requiredTools: ['x'.repeat(129)],
        spawn: () => successfulProbe(),
      }),
    ).rejects.toThrow(/required/iu);
  });

  it('redacts, deduplicates, bounds, and merges safe diagnostics', async () => {
    const result = await verifyMcpRoute({
      ...route,
      spawn: () =>
        successfulProbe({
          initialize: async () => ({
            serverInfo: { name: 'pimpampum' },
            stderr: '/Users/synthetic/private\nwarning',
            diagnostics: ['/Users/synthetic/private\nwarning', '/home/synthetic/cache'],
          }),
          listTools: async () => ({
            tools: [{ name: 'project_list' }, { name: 'extra' }],
            diagnostics: Array.from({ length: 12 }, (_, index) => `safe diagnostic ${index}`),
          }),
          diagnostics: () => ['final\tdiagnostic', 'final\tdiagnostic'],
        }),
    });
    expect(result.tools).toEqual(['project_list', 'extra']);
    expect(result.diagnostics.length).toBeLessThanOrEqual(8);
    expect(result.diagnostics.join(' ')).not.toMatch(/Users|home\/synthetic|\n|\t/u);
  });

  it('fails closed for initialization leaks, diagnostic overflow, and close failures/timeouts', async () => {
    await expect(
      verifyMcpRoute({
        ...route,
        spawn: () =>
          successfulProbe({
            initialize: async () => ({
              serverInfo: { name: 'pimpampum' },
              diagnostics: 'api_key=synthetic-private',
            }),
          }),
      }),
    ).rejects.toThrow(/secret/iu);
    await expect(
      verifyMcpRoute({
        ...route,
        spawn: () => successfulProbe({ diagnosticsOverflowed: () => true }),
      }),
    ).rejects.toThrow(/oversized|leakage/iu);
    await expect(
      verifyMcpRoute({
        ...route,
        spawn: () => successfulProbe({ close: async () => Promise.reject(new Error('close')) }),
      }),
    ).rejects.toThrow(/reap/iu);
    await expect(
      verifyMcpRoute({
        ...route,
        timeoutMilliseconds: 5,
        spawn: () => successfulProbe({ close: async () => new Promise(() => undefined) }),
      }),
    ).rejects.toThrow(/reap/iu);
  });

  it('cancels a stalled catalog after initialization and still reaps the probe', async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => undefined);
    const verification = verifyMcpRoute({
      ...route,
      signal: controller.signal,
      spawn: () => ({
        initialize: async () => ({ serverInfo: { name: 'pimpampum' } }),
        listTools: async () => new Promise(() => undefined),
        close,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(verification).rejects.toThrow(/cancelled/iu);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('receipt and ownership edge contracts', () => {
  const expected: HostEntry = {
    command: '/synthetic/runtime/bin/pimpampum-mcp',
    arguments: [],
    scope: 'global',
  };
  const proof: ConnectionReceipt = {
    schemaVersion: 1,
    connectorId: 'codex',
    scope: 'global',
    commandFingerprint: fingerprintCommand(expected),
    configuredAt: '2026-08-31T00:00:00.000Z',
    lastVerifiedAt: null,
  };

  it('distinguishes missing, equivalent, wrong-scope, legacy, and opaque ownership', () => {
    expect(
      classifyConnectorOwnership({
        entry: null,
        receipt: proof,
        expected,
        recognizedLegacyEntries: [],
      }),
    ).toBe('notConnected');
    expect(
      classifyConnectorOwnership({
        entry: expected,
        receipt: { ...proof, scope: 'user' },
        expected,
        recognizedLegacyEntries: [],
      }),
    ).toBe('equivalentUnowned');
    const legacy: HostEntry = { command: 'npx', arguments: ['pimpampum'], scope: 'global' };
    expect(
      classifyConnectorOwnership({
        entry: legacy,
        receipt: { ...proof, commandFingerprint: fingerprintCommand(legacy) },
        expected,
        recognizedLegacyEntries: [legacy],
      }),
    ).toBe('ownedStale');
    expect(fingerprintCommand({ ...expected, arguments: ['--different'] })).not.toBe(
      proof.commandFingerprint,
    );
  });
});
