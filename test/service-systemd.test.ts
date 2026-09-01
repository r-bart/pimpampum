import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPlatformServiceManager } from '../src/service/manager.js';
import {
  createSystemdAdapter,
  renderSystemdUnit,
  SYSTEMD_UNIT_NAME,
  type SystemdUnitInput,
} from '../src/service/systemd.js';
import type { CommandResult, RunCommand, ServiceAdapterContext } from '../src/service/types.js';

function success(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function serviceState(
  loadState = 'loaded',
  unitFileState = 'disabled',
  activeState = 'inactive',
): CommandResult {
  return success(
    `LoadState=${loadState}\nUnitFileState=${unitFileState}\nActiveState=${activeState}\n`,
  );
}

function unitInput(overrides: Partial<SystemdUnitInput> = {}): SystemdUnitInput {
  return {
    nodePath: '/home/dev/Pimpampum Runtime ü/bin/node',
    cliPath: '/home/dev/Pimpampum Runtime ü/dist/cli.js',
    dataDirectory: '/home/dev/Pimpampum Data ñ',
    host: '127.0.0.1',
    port: 7337,
    ...overrides,
  };
}

function context(runCommand: RunCommand): ServiceAdapterContext {
  return {
    homeDirectory: '/home/dev Space ü',
    dataDirectory: '/home/dev Space ü/Pimpampum Data',
    nodePath: '/opt/Pimpampum Runtime/bin/node',
    cliPath: '/opt/Pimpampum Runtime/dist/cli.js',
    version: '1.0.0',
    host: '127.0.0.1',
    port: 7337,
    logDirectory: '/home/dev Space ü/Pimpampum Data/logs',
    runCommand,
  };
}

describe('systemd user service', () => {
  it('renders an exact non-root unit with private journal logging and failure backoff', () => {
    const unit = renderSystemdUnit(unitInput());

    expect(unit).toMatch(
      /^ExecStart="\/home\/dev\/Pimpampum Runtime ü\/bin\/node" "\/home\/dev\/Pimpampum Runtime ü\/dist\/cli\.js" serve$/mu,
    );
    expect(unit).toContain('Environment="PIMPAMPUM_DATA_DIR=/home/dev/Pimpampum Data ñ"');
    expect(unit).toContain('Environment="PIMPAMPUM_HOST=127.0.0.1"');
    expect(unit).toContain('Environment="PIMPAMPUM_PORT=7337"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5s');
    expect(unit).toContain('StandardOutput=journal');
    expect(unit).toContain('StandardError=journal');
    expect(unit).toContain('UMask=0077');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/PIMPAMPUM_TOKEN|Bearer|User=root|\/bin\/(?:ba)?sh|sh -c/u);
  });

  it('escapes quotes, backslashes, percent specifiers, dollars and tabs as one argument', () => {
    const unit = renderSystemdUnit(
      unitInput({
        nodePath: '/home/dev/Pim "pam" % $ \\ Runtime\tü/bin/node',
        cliPath: "/home/dev/cli's % \\ path.js",
        dataDirectory: '/home/dev/Data % $ \\ ñ',
      }),
    );

    expect(unit).toContain('Pim \\"pam\\" %% $$ \\\\ Runtime\\tü/bin/node');
    expect(unit).toContain("cli's %% \\\\ path.js");
    // Environment= resolves specifiers but never expands variables, so `$` stays single there.
    expect(unit).toContain('Environment="PIMPAMPUM_DATA_DIR=/home/dev/Data %% $ \\\\ ñ"');
    expect(unit).not.toContain('PIMPAMPUM_DATA_DIR=/home/dev/Data %% $$');
  });

  it('keeps a literal dollar in the data directory intact for the daemon environment', () => {
    const unit = renderSystemdUnit(unitInput({ dataDirectory: '/home/dev/$HOME data/${X}' }));

    expect(unit).toContain('Environment="PIMPAMPUM_DATA_DIR=/home/dev/$HOME data/${X}"');
    expect(unit.match(/^Environment=.*\$\$/mu)).toBeNull();
    expect(unit).toMatch(/^ExecStart=.*bin\/node" ".*cli\.js" serve$/mu);
  });

  it('rejects unsafe paths, non-loopback hosts and invalid ports', () => {
    expect(() => renderSystemdUnit(unitInput({ nodePath: 'relative/node' }))).toThrow(
      'Node path must be absolute',
    );
    expect(() => renderSystemdUnit(unitInput({ cliPath: 'relative/cli' }))).toThrow(
      'CLI path must be absolute',
    );
    expect(() => renderSystemdUnit(unitInput({ dataDirectory: 'relative/data' }))).toThrow(
      'Data directory must be absolute',
    );
    expect(() => renderSystemdUnit(unitInput({ dataDirectory: '/data\nInjected=yes' }))).toThrow(
      /line breaks/u,
    );
    expect(() => renderSystemdUnit(unitInput({ host: '0.0.0.0' }))).toThrow(/loopback/u);
    expect(() => renderSystemdUnit(unitInput({ port: 1.5 }))).toThrow(/integer/u);
    expect(() => renderSystemdUnit(unitInput({ port: 0 }))).toThrow(/between/u);
    expect(() => renderSystemdUnit(unitInput({ port: 65_536 }))).toThrow(/between/u);
    expect(renderSystemdUnit(unitInput({ host: 'localhost' }))).toContain(
      'Environment="PIMPAMPUM_HOST=localhost"',
    );
    expect(renderSystemdUnit(unitInput({ host: '::1' }))).toContain(
      'Environment="PIMPAMPUM_HOST=::1"',
    );
  });

  it('returns the one private per-user unit artifact', () => {
    const adapter = createSystemdAdapter();
    const artifacts = adapter.artifacts(context(async () => success()));

    expect(adapter).toMatchObject({ id: 'systemd', platform: 'linux' });
    expect(artifacts).toEqual([
      expect.objectContaining({
        path: join('/home/dev Space ü', '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME),
        mode: 0o600,
      }),
    ]);
    expect(String(artifacts[0]?.content)).toContain('ExecStart=');
    expect(() => createSystemdAdapter({ systemctlPath: 'systemctl' })).toThrow(/absolute/u);
  });

  it('activates using exact systemctl user argument arrays', async () => {
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[1] === 'show' ? serviceState() : success(),
    );
    const adapter = createSystemdAdapter({ systemctlPath: '/custom/systemctl' });

    await adapter.activate(context(runCommand), []);

    expect(runCommand.mock.calls).toEqual([
      ['/custom/systemctl', ['--user', 'daemon-reload']],
      [
        '/custom/systemctl',
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=UnitFileState',
          '--property=ActiveState',
          '--no-pager',
        ],
      ],
      ['/custom/systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]],
    ]);
    // An inactive unit starts fresh from the new ExecStart; nothing to restart.
    expect(runCommand.mock.calls.some(([, arguments_]) => arguments_[1] === 'restart')).toBe(false);
  });

  it('restarts an already running unit after enable --now so the new ExecStart serves', async () => {
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[1] === 'show' ? serviceState('loaded', 'enabled', 'active') : success(),
    );
    const adapter = createSystemdAdapter({ systemctlPath: '/custom/systemctl' });

    await adapter.activate(context(runCommand), []);

    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ['--user', 'daemon-reload'],
      [
        '--user',
        'show',
        SYSTEMD_UNIT_NAME,
        '--property=LoadState',
        '--property=UnitFileState',
        '--property=ActiveState',
        '--no-pager',
      ],
      ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'restart', SYSTEMD_UNIT_NAME],
    ]);
  });

  it('compensates a failed restart and restores the prior running state on rollback', async () => {
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[1] === 'show') return serviceState('loaded', 'enabled', 'active');
      if (arguments_[1] === 'restart') return { exitCode: 1, stdout: '', stderr: 'restart failed' };
      return success();
    });
    const adapter = createSystemdAdapter();
    const serviceContext = context(runCommand);

    await expect(adapter.activate(serviceContext, [])).rejects.toThrow(
      'systemctl restart failed with exit code 1; stderr="restart failed"',
    );
    await adapter.afterRollback?.(serviceContext, []);

    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ['--user', 'daemon-reload'],
      [
        '--user',
        'show',
        SYSTEMD_UNIT_NAME,
        '--property=LoadState',
        '--property=UnitFileState',
        '--property=ActiveState',
        '--no-pager',
      ],
      ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'restart', SYSTEMD_UNIT_NAME],
      ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
      ['--user', 'daemon-reload'],
      ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
    ]);
  });

  it('surfaces activation failures and missing systemctl without using a shell', async () => {
    const reloadFailure = vi.fn<RunCommand>(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: ' manager unavailable ',
    }));
    await expect(createSystemdAdapter().activate(context(reloadFailure), [])).rejects.toThrow(
      'systemctl daemon-reload failed with exit code 1; stderr="manager unavailable"',
    );
    expect(reloadFailure).toHaveBeenCalledWith('/usr/bin/systemctl', ['--user', 'daemon-reload']);

    const enableFailure = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(serviceState())
      .mockResolvedValueOnce({ exitCode: 5, stdout: '', stderr: '' })
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success());
    await expect(createSystemdAdapter().activate(context(enableFailure), [])).rejects.toThrow(
      'systemctl enable --now failed with exit code 5; stderr=""',
    );
    expect(enableFailure.mock.calls).toEqual([
      ['/usr/bin/systemctl', ['--user', 'daemon-reload']],
      [
        '/usr/bin/systemctl',
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=UnitFileState',
          '--property=ActiveState',
          '--no-pager',
        ],
      ],
      ['/usr/bin/systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]],
      ['/usr/bin/systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]],
      ['/usr/bin/systemctl', ['--user', 'reset-failed', SYSTEMD_UNIT_NAME]],
    ]);

    const nonErrorFailure = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(serviceState())
      .mockRejectedValueOnce('raw enable failure')
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success());
    await expect(createSystemdAdapter().activate(context(nonErrorFailure), [])).rejects.toThrow(
      'raw enable failure',
    );

    const missing = vi.fn<RunCommand>(async () => {
      throw new Error('spawn /usr/bin/systemctl ENOENT');
    });
    await expect(createSystemdAdapter().activate(context(missing), [])).rejects.toThrow('ENOENT');

    const malformedState = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success('LoadState=loaded\n'));
    await expect(createSystemdAdapter().activate(context(malformedState), [])).rejects.toThrow(
      'systemctl show did not return UnitFileState',
    );
  });

  it('preserves activation and compensation failures while attempting every cleanup step', async () => {
    const runCommand = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(serviceState('not-found'))
      .mockResolvedValueOnce({ exitCode: 5, stdout: '', stderr: 'enable failed' })
      .mockResolvedValueOnce({ exitCode: 6, stdout: '', stderr: 'disable failed' })
      .mockResolvedValueOnce({ exitCode: 7, stdout: '', stderr: 'reset failed' });

    const failure = await createSystemdAdapter()
      .activate(context(runCommand), [])
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message:
        'systemd activation compensation failed after: systemctl enable --now failed with exit code 5; stderr="enable failed"',
    });
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('enable --now failed') }),
      expect.objectContaining({ message: expect.stringContaining('disable --now failed') }),
      expect.objectContaining({ message: expect.stringContaining('reset-failed failed') }),
    ]);
    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ['--user', 'daemon-reload'],
      [
        '--user',
        'show',
        SYSTEMD_UNIT_NAME,
        '--property=LoadState',
        '--property=UnitFileState',
        '--property=ActiveState',
        '--no-pager',
      ],
      ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
    ]);
  });

  it('reloads systemd only after the manager has restored filesystem bytes', async () => {
    const runCommand = vi.fn<RunCommand>(async () => success());
    const adapter = createSystemdAdapter({ systemctlPath: '/custom/systemctl' });

    await adapter.afterRollback?.(context(runCommand), []);

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith('/custom/systemctl', ['--user', 'daemon-reload']);
  });

  it.each([
    {
      description: 'enabled but inactive',
      unitFileState: 'enabled',
      activeState: 'inactive',
      restoration: ['--user', 'enable', SYSTEMD_UNIT_NAME],
    },
    {
      description: 'disabled but active',
      unitFileState: 'disabled',
      activeState: 'active',
      restoration: ['--user', 'start', SYSTEMD_UNIT_NAME],
    },
    {
      description: 'disabled and inactive',
      unitFileState: 'disabled',
      activeState: 'inactive',
      restoration: null,
    },
  ])(
    'restores a prior $description service state after failed activation',
    async ({ unitFileState, activeState, restoration }) => {
      let enableAttempts = 0;
      const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
        if (arguments_[1] === 'show') {
          return serviceState('loaded', unitFileState, activeState);
        }
        if (arguments_[1] === 'enable' && arguments_[2] === '--now') {
          enableAttempts += 1;
          if (enableAttempts === 1) {
            return { exitCode: 1, stdout: '', stderr: 'new unit failed' };
          }
        }
        return success();
      });
      const adapter = createSystemdAdapter();
      const serviceContext = context(runCommand);

      await expect(adapter.activate(serviceContext, [])).rejects.toThrow(/enable --now failed/u);
      await expect(adapter.afterRollback?.(serviceContext, [])).resolves.toBeUndefined();

      expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
        ['--user', 'daemon-reload'],
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=UnitFileState',
          '--property=ActiveState',
          '--no-pager',
        ],
        ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
        ['--user', 'daemon-reload'],
        ...(restoration ? [restoration] : []),
      ]);
    },
  );

  it('reports running only for a loaded active user unit', async () => {
    const responses = [
      success('LoadState=loaded\nActiveState=active\n'),
      success('LoadState=not-found\nActiveState=inactive\n'),
      success('LoadState=loaded\nActiveState=inactive\n'),
    ];
    const runCommand = vi.fn<RunCommand>(async () => responses.shift() ?? success());
    const adapter = createSystemdAdapter();
    const serviceContext = context(runCommand);

    await expect(adapter.isRunning(serviceContext, [])).resolves.toBe(true);
    await expect(adapter.isRunning(serviceContext, [])).resolves.toBe(false);
    await expect(adapter.isRunning(serviceContext, [])).resolves.toBe(false);
    expect(runCommand).toHaveBeenLastCalledWith('/usr/bin/systemctl', [
      '--user',
      'show',
      SYSTEMD_UNIT_NAME,
      '--property=LoadState',
      '--property=ActiveState',
      '--no-pager',
    ]);

    const failure = vi.fn<RunCommand>(async () => ({
      exitCode: 4,
      stdout: '',
      stderr: 'not found',
    }));
    await expect(createSystemdAdapter().isRunning(context(failure), [])).rejects.toThrow(
      /systemctl show failed/u,
    );
  });

  it('disables and resets only the named user unit', async () => {
    const runCommand = vi.fn<RunCommand>(async () => success());
    const adapter = createSystemdAdapter();

    await adapter.deactivate(context(runCommand), []);

    expect(runCommand.mock.calls).toEqual([
      ['/usr/bin/systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]],
      ['/usr/bin/systemctl', ['--user', 'reset-failed', SYSTEMD_UNIT_NAME]],
    ]);
  });

  it('surfaces failures from either systemd deactivation step', async () => {
    const disableFailure = vi.fn<RunCommand>(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'denied',
    }));
    await expect(createSystemdAdapter().deactivate(context(disableFailure), [])).rejects.toThrow(
      /disable --now failed/u,
    );

    const resetFailure = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'still failed' });
    await expect(createSystemdAdapter().deactivate(context(resetFailure), [])).rejects.toThrow(
      /reset-failed failed/u,
    );
  });

  it('tolerates only exact unit-absent results during idempotent deactivation', async () => {
    const absent = vi
      .fn<RunCommand>()
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: `Failed to disable unit: Unit file ${SYSTEMD_UNIT_NAME} does not exist.\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: `Failed to reset failed state of unit ${SYSTEMD_UNIT_NAME}: Unit ${SYSTEMD_UNIT_NAME} not loaded.\n`,
      });

    await expect(createSystemdAdapter().deactivate(context(absent), [])).resolves.toBeUndefined();
    expect(absent.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
    ]);

    const misleadingPermissionFailure = vi.fn<RunCommand>(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: `Access denied; Unit file ${SYSTEMD_UNIT_NAME} does not exist.`,
    }));
    await expect(
      createSystemdAdapter().deactivate(context(misleadingPermissionFailure), []),
    ).rejects.toThrow(/disable --now failed/u);

    const executionFailure = vi.fn<RunCommand>(async () => {
      throw new Error('spawn systemctl EACCES');
    });
    await expect(createSystemdAdapter().deactivate(context(executionFailure), [])).rejects.toThrow(
      'EACCES',
    );
  });

  it('reconciles a repeated real-manager install without duplicate activation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-systemd-repeat-'));
    const homeDirectory = join(root, 'Home Space ü');
    const dataDirectory = join(root, 'Data Space ñ');
    mkdirSync(homeDirectory, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[1] === 'show' ? serviceState('loaded', 'enabled', 'active') : success(),
    );
    const adapter = createSystemdAdapter();
    const manager = createPlatformServiceManager({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      nodePath: '/opt/Pimpampum Runtime/bin/node',
      cliPath: '/opt/Pimpampum Runtime/dist/cli.js',
      version: '1.0.0',
      runCommand,
      adapters: { linux: adapter },
    });
    const unitPath = join(homeDirectory, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
    try {
      await expect(manager.install()).resolves.toMatchObject({
        installed: true,
        reconciled: false,
      });
      const installedBytes = readFileSync(unitPath);
      await expect(manager.install()).resolves.toMatchObject({
        installed: true,
        reconciled: true,
      });
      expect(readFileSync(unitPath)).toEqual(installedBytes);
      expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
        ['--user', 'daemon-reload'],
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=UnitFileState',
          '--property=ActiveState',
          '--no-pager',
        ],
        ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'restart', SYSTEMD_UNIT_NAME],
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=ActiveState',
          '--no-pager',
        ],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores a pre-existing user unit when systemd activation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-systemd-rollback-'));
    const homeDirectory = join(root, 'Home Space ü');
    const dataDirectory = join(root, 'Data Space ñ');
    const unitPath = join(homeDirectory, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
    mkdirSync(join(homeDirectory, '.config', 'systemd', 'user'), { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    writeFileSync(unitPath, 'original-user-unit');
    const reloadObservedBytes: string[] = [];
    let enableAttempts = 0;
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[1] === 'daemon-reload') {
        reloadObservedBytes.push(readFileSync(unitPath, 'utf8'));
        return success();
      }
      if (arguments_[1] === 'show') return serviceState('loaded', 'enabled', 'active');
      if (arguments_[1] === 'enable') {
        enableAttempts += 1;
        return enableAttempts === 1
          ? { exitCode: 1, stdout: '', stderr: 'enable failed' }
          : success();
      }
      return success();
    });
    const manager = createPlatformServiceManager({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      nodePath: '/opt/Pimpampum Runtime/bin/node',
      cliPath: '/opt/Pimpampum Runtime/dist/cli.js',
      version: '1.0.0',
      runCommand,
      adapters: { linux: createSystemdAdapter() },
    });
    try {
      await expect(manager.install()).rejects.toThrow(/enable --now failed/u);
      expect(readFileSync(unitPath, 'utf8')).toBe('original-user-unit');
      expect(existsSync(join(dataDirectory, 'install-receipt.json'))).toBe(false);
      expect(reloadObservedBytes).toEqual([
        expect.stringContaining('ExecStart='),
        'original-user-unit',
      ]);
      expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
        ['--user', 'daemon-reload'],
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=UnitFileState',
          '--property=ActiveState',
          '--no-pager',
        ],
        ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
        ['--user', 'daemon-reload'],
        ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores the prior enabled and running service after changed-install reconciliation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-systemd-reconcile-rollback-'));
    const homeDirectory = join(root, 'Home Space ü');
    const dataDirectory = join(root, 'Data Space ñ');
    const unitPath = join(homeDirectory, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
    const receiptPath = join(dataDirectory, 'install-receipt.json');
    mkdirSync(homeDirectory, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    let showAttempts = 0;
    let enableAttempts = 0;
    const reloadObservedBytes: string[] = [];
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[1] === 'daemon-reload') {
        reloadObservedBytes.push(readFileSync(unitPath, 'utf8'));
        return success();
      }
      if (arguments_[1] === 'show') {
        showAttempts += 1;
        return showAttempts === 1
          ? serviceState('loaded', 'disabled', 'inactive')
          : serviceState('loaded', 'enabled', 'active');
      }
      if (arguments_[1] === 'enable') {
        enableAttempts += 1;
        return enableAttempts === 2
          ? { exitCode: 1, stdout: '', stderr: 'replacement failed' }
          : success();
      }
      return success();
    });
    const adapter = createSystemdAdapter();
    const baseInput = {
      platform: 'linux' as const,
      homeDirectory,
      dataDirectory,
      nodePath: '/opt/Pimpampum Runtime/bin/node',
      version: '1.0.0',
      runCommand,
      adapters: { linux: adapter },
    };
    const originalManager = createPlatformServiceManager({
      ...baseInput,
      cliPath: '/opt/Pimpampum Runtime/dist/cli-v1.js',
    });
    const replacementManager = createPlatformServiceManager({
      ...baseInput,
      version: '0.2.0',
      cliPath: '/opt/Pimpampum Runtime/dist/cli-v2.js',
    });
    try {
      await originalManager.install();
      const originalUnit = readFileSync(unitPath);
      const originalReceipt = readFileSync(receiptPath);

      await expect(replacementManager.install()).rejects.toThrow(/replacement failed/u);

      expect(readFileSync(unitPath)).toEqual(originalUnit);
      expect(readFileSync(receiptPath)).toEqual(originalReceipt);
      expect(reloadObservedBytes).toHaveLength(3);
      expect(reloadObservedBytes[0]).toContain('cli-v1.js');
      expect(reloadObservedBytes[1]).toContain('cli-v2.js');
      expect(reloadObservedBytes[2]).toContain('cli-v1.js');
      expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
        ['--user', 'daemon-reload'],
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=UnitFileState',
          '--property=ActiveState',
          '--no-pager',
        ],
        ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'daemon-reload'],
        [
          '--user',
          'show',
          SYSTEMD_UNIT_NAME,
          '--property=LoadState',
          '--property=UnitFileState',
          '--property=ActiveState',
          '--no-pager',
        ],
        ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
        ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
        ['--user', 'daemon-reload'],
        ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'enabled and running',
      state: serviceState('loaded', 'enabled', 'active'),
      restore: ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
    },
    {
      label: 'enabled but stopped',
      state: serviceState('loaded', 'enabled', 'inactive'),
      restore: ['--user', 'enable', SYSTEMD_UNIT_NAME],
    },
    {
      label: 'disabled but running',
      state: serviceState('loaded', 'disabled', 'active'),
      restore: ['--user', 'start', SYSTEMD_UNIT_NAME],
    },
    {
      label: 'disabled and stopped',
      state: serviceState('loaded', 'disabled', 'inactive'),
      restore: null,
    },
  ])('restores the exact prior systemd state: $label', async ({ state, restore }) => {
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[1] === 'show' ? state : success(),
    );
    const adapter = createSystemdAdapter({ systemctlPath: '/custom/systemctl' });
    const adapterContext = context(runCommand);

    const rollback = await adapter.prepareDeactivationRollback!(adapterContext, []);
    await adapter.deactivate(adapterContext, []);
    await rollback();

    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      [
        '--user',
        'show',
        SYSTEMD_UNIT_NAME,
        '--property=LoadState',
        '--property=UnitFileState',
        '--property=ActiveState',
        '--no-pager',
      ],
      ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
      ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME],
      ['--user', 'reset-failed', SYSTEMD_UNIT_NAME],
      ['--user', 'daemon-reload'],
      ...(restore ? [restore] : []),
    ]);
  });
});
