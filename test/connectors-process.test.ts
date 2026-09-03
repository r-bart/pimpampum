import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configurationRevision,
  detectExecutable,
  payloadJson,
  payloadVersionLine,
  readHostConfiguration,
  replaceHostConfigurationEntry,
  runBoundedHostCommand,
  sanitizedHostEnvironment,
} from '../src/connectors/process.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-process-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('bounded connector process and configuration primitives', () => {
  it('discovers only explicit locations and absolute sanitized PATH entries', async () => {
    const root = temporaryDirectory('detect');
    const bounded = join(root, 'bounded');
    mkdirSync(bounded);
    const executable = join(bounded, 'codex');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const run = vi.fn(async () => ({ exitCode: 0, stdout: 'codex-cli 0.151.0', stderr: '' }));
    await expect(
      detectExecutable({
        id: 'codex',
        names: ['codex'],
        boundedLocations: [bounded],
        path: ['relative-bin', bounded, '', bounded].join(delimiter),
        timeoutMilliseconds: 1_000,
        run,
      }),
    ).resolves.toEqual({ executable, supported: true, versionOutput: 'codex-cli 0.151.0' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('drops unrelated environment fields and rejects credential arguments', async () => {
    expect(
      sanitizedHostEnvironment({
        PATH: `${join(tmpdir(), 'bin')}${delimiter}relative`,
        HOME: '/Users/example',
        PIMPAMPUM_TOKEN: 'synthetic-private-value',
      }),
    ).toEqual({ PATH: join(tmpdir(), 'bin'), HOME: '/Users/example' });
    await expect(
      runBoundedHostCommand(
        {
          executable: process.execPath,
          arguments: ['Authorization: Bearer synthetic-private-value'],
        },
        { timeoutMilliseconds: 1_000 },
      ),
    ).rejects.toThrow(/credentials|arguments/i);
  });

  it('caps output and terminates a timed-out process group', async () => {
    await expect(
      runBoundedHostCommand(
        {
          executable: process.execPath,
          arguments: ['-e', 'process.stdout.write("x".repeat(200))'],
        },
        { timeoutMilliseconds: 1_000, maxOutputBytes: 32 },
      ),
    ).rejects.toThrow(/output exceeded/i);
    await expect(
      runBoundedHostCommand(
        { executable: process.execPath, arguments: ['-e', 'setInterval(() => {}, 1000)'] },
        { timeoutMilliseconds: 20 },
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it('atomically preserves unrelated JSON, mode, and revision checks', async () => {
    const root = temporaryDirectory('replace');
    const path = join(root, '.claude.json');
    writeFileSync(path, JSON.stringify({ theme: 'dark', mcpServers: {} }), { mode: 0o600 });
    const revision = configurationRevision(path);
    const result = await replaceHostConfigurationEntry({
      path,
      expectedRevision: revision,
      mode: 0o600,
      update: (value) => ({
        ...(value as Record<string, unknown>),
        mcpServers: { pimpampum: { command: '/synthetic/pimpampum-mcp', args: [] } },
      }),
    });
    expect(result.revision).toBe(configurationRevision(path));
    expect(readHostConfiguration(path).value).toMatchObject({ theme: 'dark' });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, '{"concurrent":true}');
    await expect(
      replaceHostConfigurationEntry({
        path,
        expectedRevision: revision,
        mode: 0o600,
        update: () => ({}),
      }),
    ).rejects.toThrow(/revision|concurrent/i);
    expect(readFileSync(path, 'utf8')).toBe('{"concurrent":true}');
  });

  it('creates a private minimum config and rejects read-only files and symlinks', async () => {
    const root = temporaryDirectory('boundaries');
    const missing = join(root, 'new-home', '.claude.json');
    await replaceHostConfigurationEntry({
      path: missing,
      expectedRevision: null,
      mode: 0o600,
      update: () => ({ mcpServers: { pimpampum: { command: '/synthetic/pimpampum-mcp' } } }),
    });
    expect(statSync(missing).mode & 0o777).toBe(0o600);

    const readOnly = join(root, 'managed.json');
    writeFileSync(readOnly, '{"managed":true}', { mode: 0o400 });
    await expect(
      replaceHostConfigurationEntry({
        path: readOnly,
        expectedRevision: null,
        mode: 0o600,
        update: () => ({ managed: false }),
      }),
    ).rejects.toThrow(/read-only|managed|permission/i);
    chmodSync(readOnly, 0o600);

    const victim = join(root, 'victim.json');
    const link = join(root, 'link.json');
    writeFileSync(victim, '{"untouched":true}');
    symlinkSync(victim, link);
    expect(() => configurationRevision(link)).toThrow(/symlink|regular file/i);
    expect(readFileSync(victim, 'utf8')).toBe('{"untouched":true}');

    const dangling = join(root, 'dangling.json');
    symlinkSync(join(root, 'missing-target.json'), dangling);
    await expect(
      replaceHostConfigurationEntry({
        path: dangling,
        expectedRevision: null,
        mode: 0o600,
        update: () => ({ shouldNotReplace: true }),
      }),
    ).rejects.toThrow(/symlink|regular file/i);
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
  });
});

describe('bounded wrapper preamble readers', () => {
  // `~/.local/bin/claude` and `~/.local/bin/codex` are mise wrappers on a machine managed by a
  // version manager, and they print `mise ... tools: claude@2.1.257` to stdout before the payload.
  // Reading only the first line reported a working Claude Code as an unsupported version, and
  // parsing the whole stdout made every Codex inspection fail as invalid JSON.
  const VERSION = /^\d+\.\d+\.\d+(?: \(Claude Code\))?$/u;

  it('finds a version behind a wrapper notice and keeps the pattern strict', () => {
    expect(
      payloadVersionLine(
        'mise ~/.config/mise/config.toml tools: claude@2.1.257\n2.1.257 (Claude Code)\n',
        VERSION,
      ),
    ).toBe('2.1.257 (Claude Code)');
    expect(payloadVersionLine('2.1.257\n', VERSION)).toBe('2.1.257');
    expect(payloadVersionLine('claude version 2.1.257\n', VERSION)).toBeNull();
    expect(payloadVersionLine('', VERSION)).toBeNull();
  });

  it('stops looking past the bounded preamble', () => {
    const buried = `${'notice\n'.repeat(5)}2.1.257\n`;
    expect(payloadVersionLine(buried, VERSION)).toBeNull();
    expect(payloadVersionLine(`${'notice\n'.repeat(4)}2.1.257\n`, VERSION)).toBe('2.1.257');
  });

  it('starts JSON at the document a wrapper notice precedes, and is otherwise a no-op', () => {
    expect(payloadJson('mise tools: codex@0.151.0\n{"name":"pimpampum"}')).toBe(
      '{"name":"pimpampum"}',
    );
    expect(payloadJson('  [1]')).toBe('  [1]');
    expect(payloadJson('not json at all')).toBe('not json at all');
    expect(payloadJson(`${'notice\n'.repeat(5)}{"late":true}`)).toBe(
      `${'notice\n'.repeat(5)}{"late":true}`,
    );
  });
});
