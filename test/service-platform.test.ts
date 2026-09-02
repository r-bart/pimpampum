import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  createServiceCommandRunner,
  DEFAULT_SERVICE_COMMAND_TIMEOUT_MILLISECONDS,
  findExecutable,
  runServiceCommand,
  SERVICE_COMMAND_MAX_OUTPUT_BYTES,
  serviceCommandEnvironment,
  ServiceCommandBoundError,
} from '../src/service/platform.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HANG_FOREVER = 'setInterval(() => {}, 1000)';
const IGNORE_SIGTERM_AND_HANG = `process.on('SIGTERM', () => {}); ${HANG_FOREVER}`;

/** Resolves once the process is gone. `signal 0` throws `ESRCH` for a pid that no longer exists. */
async function waitForExit(pid: number, deadlineMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMilliseconds;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error(`process ${String(pid)} outlived the escalation`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('service command runner', () => {
  it('executes argument arrays without a shell and captures success', async () => {
    await expect(
      runServiceCommand(process.execPath, [
        '--eval',
        "process.stdout.write(process.argv[1]); process.stderr.write('warning')",
        'value with spaces; $(not-a-shell)',
      ]),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: 'value with spaces; $(not-a-shell)',
      stderr: 'warning',
    });
  });

  it('returns nonzero process exits and rejects missing executables', async () => {
    await expect(
      runServiceCommand(process.execPath, [
        '--eval',
        "process.stderr.write('failed'); process.exit(7)",
      ]),
    ).resolves.toEqual({ exitCode: 7, stdout: '', stderr: 'failed' });
    await expect(runServiceCommand('/definitely/missing/pimpampum-command', [])).rejects.toThrow();
  });

  it('stops a command at its deadline with a typed error that names the executable', async () => {
    const startedAt = Date.now();
    const failure = await runServiceCommand(process.execPath, ['--eval', HANG_FOREVER], {
      timeoutMilliseconds: 200,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceCommandBoundError);
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: 'unavailable',
      status: 503,
      retryable: true,
      bound: 'timeout',
      executable: process.execPath,
      details: { executable: process.execPath, timeoutMilliseconds: 200 },
    });
    expect((failure as Error).message).toContain('node');
    expect((failure as Error).message).toContain('0.2 s');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('escalates from SIGTERM to SIGKILL for a child that ignores the first signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-escalation-'));
    roots.push(root);
    const pidPath = join(root, 'pid');
    const startedAt = Date.now();
    const failure = await runServiceCommand(
      process.execPath,
      [
        '--eval',
        `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); ` +
          IGNORE_SIGTERM_AND_HANG,
      ],
      { timeoutMilliseconds: 200, terminationGraceMilliseconds: 100 },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'unavailable', bound: 'timeout' });
    // The child ignores SIGTERM, so only the SIGKILL escalation can end it. Waiting for it to
    // disappear is what proves the escalation ran: asserting the rejection alone left that branch
    // covered by timing luck, and a loaded machine could finish the test before the unref'd
    // grace timer fired.
    expect(existsSync(pidPath)).toBe(true);
    await waitForExit(Number(readFileSync(pidPath, 'utf8')));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('defaults to a sixty second deadline and rejects non-positive bounds', async () => {
    expect(DEFAULT_SERVICE_COMMAND_TIMEOUT_MILLISECONDS).toBe(60_000);
    await expect(
      runServiceCommand(process.execPath, ['--version'], { timeoutMilliseconds: 0 }),
    ).rejects.toThrow(/timeout must be positive/u);
    await expect(
      runServiceCommand(process.execPath, ['--version'], { maxOutputBytes: -1 }),
    ).rejects.toThrow(/output limit must be positive/u);
    await expect(
      runServiceCommand(process.execPath, ['--version'], { terminationGraceMilliseconds: 1.5 }),
    ).rejects.toThrow(/termination grace must be positive/u);
  });

  it('accepts more output than the largest parser cap and stops a flood beyond its own', async () => {
    expect(SERVICE_COMMAND_MAX_OUTPUT_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    const aboveOldCap = 1_500_000;
    const result = await runServiceCommand(process.execPath, [
      '--eval',
      `process.stdout.write('x'.repeat(${aboveOldCap}))`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toHaveLength(aboveOldCap);

    const flood = await runServiceCommand(
      process.execPath,
      ['--eval', "process.stdout.write('y'.repeat(200_000))"],
      { maxOutputBytes: 64 * 1024 },
    ).catch((error: unknown) => error);
    expect(flood).toBeInstanceOf(ServiceCommandBoundError);
    expect(flood).toMatchObject({
      code: 'unavailable',
      retryable: false,
      bound: 'output',
      details: { executable: process.execPath, maxOutputBytes: 64 * 1024 },
    });
    expect((flood as Error).message).toContain('65536 bytes');
  });

  it('forwards only the allow-listed environment to the child', async () => {
    const source: NodeJS.ProcessEnv = {
      PATH: `relative${delimiter}/usr/bin${delimiter}/bin${delimiter}/usr/bin`,
      HOME: '/home/dev',
      USER: 'dev',
      LOGNAME: 'dev',
      SHELL: '/bin/zsh',
      TMPDIR: '/tmp/dev',
      LANG: 'es_ES.UTF-8',
      LC_ALL: 'C.UTF-8',
      LC_MESSAGES: 'C',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CONFIG_HOME: '/home/dev/.config',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SSH_AUTH_SOCK: '/run/user/1000/agent.sock',
      WAYLAND_DISPLAY: 'wayland-1',
      DISPLAY: ':0',
      HYPRLAND_INSTANCE_SIGNATURE: 'abc123',
      OMARCHY_PATH: '/home/dev/.local/share/omarchy',
      PIMPAMPUM_TOKEN: 'secret-bearer',
      PIMPAMPUM_DATA_DIR: '/home/dev/.pimpampum',
      NODE_OPTIONS: '--require /tmp/evil.js',
      NPM_TOKEN: 'npm-secret',
      npm_config_registry: 'https://example.invalid',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NUL_CARRIER: 'bad\0value',
    };

    expect(serviceCommandEnvironment(source)).toEqual({
      PATH: `/usr/bin${delimiter}/bin`,
      HOME: '/home/dev',
      USER: 'dev',
      LOGNAME: 'dev',
      TMPDIR: '/tmp/dev',
      LANG: 'es_ES.UTF-8',
      LC_ALL: 'C.UTF-8',
      LC_MESSAGES: 'C',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_CONFIG_HOME: '/home/dev/.config',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SSH_AUTH_SOCK: '/run/user/1000/agent.sock',
      WAYLAND_DISPLAY: 'wayland-1',
      DISPLAY: ':0',
      HYPRLAND_INSTANCE_SIGNATURE: 'abc123',
      OMARCHY_PATH: '/home/dev/.local/share/omarchy',
    });
    expect(serviceCommandEnvironment({})).toEqual({ PATH: '' });

    const child = await runServiceCommand(
      process.execPath,
      ['--eval', 'process.stdout.write(JSON.stringify(process.env))'],
      { environment: { ...source, PATH: process.env.PATH ?? '' } },
    );
    expect(child.exitCode).toBe(0);
    const observed = JSON.parse(child.stdout) as Record<string, string>;
    expect(Object.keys(observed).filter((key) => key.startsWith('PIMPAMPUM_'))).toEqual([]);
    expect(observed).not.toHaveProperty('NODE_OPTIONS');
    expect(observed).not.toHaveProperty('NPM_TOKEN');
    expect(observed).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(observed).not.toHaveProperty('SHELL');
    expect(observed).toMatchObject({
      HOME: '/home/dev',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
    expect(JSON.stringify(observed)).not.toContain('secret');
  });

  it('never leaks the daemon token from the real process environment', async () => {
    const previous = process.env.PIMPAMPUM_TOKEN;
    process.env.PIMPAMPUM_TOKEN = 'live-bearer-token';
    try {
      const child = await runServiceCommand(process.execPath, [
        '--eval',
        "process.stdout.write(String('PIMPAMPUM_TOKEN' in process.env))",
      ]);
      expect(child).toEqual({ exitCode: 0, stdout: 'false', stderr: '' });
    } finally {
      if (previous === undefined) delete process.env.PIMPAMPUM_TOKEN;
      else process.env.PIMPAMPUM_TOKEN = previous;
    }
  });

  it('builds a RunCommand with fixed bounds for callers that need a longer deadline', async () => {
    const patient = createServiceCommandRunner({ timeoutMilliseconds: 10_000 });
    await expect(
      patient(process.execPath, ['--eval', 'process.stdout.write("ok")']),
    ).resolves.toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    const impatient = createServiceCommandRunner({ timeoutMilliseconds: 100 });
    await expect(impatient(process.execPath, ['--eval', HANG_FOREVER])).rejects.toMatchObject({
      code: 'unavailable',
      bound: 'timeout',
    });
  });

  it('lets a per-call bound override the fixed one in both directions', async () => {
    const patient = createServiceCommandRunner({ timeoutMilliseconds: 10_000 });
    await expect(
      patient(process.execPath, ['--eval', HANG_FOREVER], { timeoutMilliseconds: 100 }),
    ).rejects.toMatchObject({ code: 'unavailable', bound: 'timeout' });
    const impatient = createServiceCommandRunner({ timeoutMilliseconds: 100 });
    await expect(
      impatient(
        process.execPath,
        ['--eval', 'setTimeout(() => process.stdout.write("late"), 300)'],
        {
          timeoutMilliseconds: 10_000,
        },
      ),
    ).resolves.toEqual({ exitCode: 0, stdout: 'late', stderr: '' });
  });
});

describe('service executable discovery', () => {
  it('returns the canonical executable from the first usable absolute PATH entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-path-'));
    roots.push(root);
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'omarchy'), 'not executable');
    writeFileSync(join(second, 'omarchy-real'), '#!/bin/sh\n');
    chmodSync(join(second, 'omarchy-real'), 0o755);
    symlinkSync(join(second, 'omarchy-real'), join(second, 'omarchy'));

    expect(findExecutable('omarchy', `relative${delimiter}${first}${delimiter}${second}`)).toBe(
      realpathSync(join(second, 'omarchy-real')),
    );
  });

  it('returns null for absent executables and an empty PATH', () => {
    expect(findExecutable('missing-pimpampum-command', undefined)).toBeNull();
    expect(findExecutable('missing-pimpampum-command', '')).toBeNull();
    const previousPath = process.env.PATH;
    try {
      delete process.env.PATH;
      expect(findExecutable('missing-pimpampum-command')).toBeNull();
    } finally {
      if (previousPath !== undefined) process.env.PATH = previousPath;
    }
  });

  it('rejects path-like and empty executable names', () => {
    for (const name of ['', '../omarchy', 'bin\\omarchy', `omarchy\0bad`]) {
      expect(() => findExecutable(name, '')).toThrow(/simple file name/u);
    }
  });
});
