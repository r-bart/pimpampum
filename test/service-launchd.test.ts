import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createLaunchdAdapter,
  LAUNCH_AGENT_LABEL,
  renderLaunchAgent,
  type LaunchAgentInput,
} from '../src/service/launchd.js';
import type {
  CommandResult,
  RunCommand,
  ServiceAdapterContext,
  ServiceArtifact,
} from '../src/service/types.js';

function launchAgentInput(overrides: Partial<LaunchAgentInput> = {}): LaunchAgentInput {
  return {
    nodePath: '/opt/Pimpampum & Runtime/bin/node',
    cliPath: '/opt/Pimpampum Runtime/dist/<cli> "quoted" \'single\'.js',
    dataDirectory: '/Users/example/Pimpampum Data ñ',
    host: '127.0.0.1',
    port: 7337,
    logDirectory: '/Users/example/Pimpampum Data ñ/logs & private',
    ...overrides,
  };
}

function commandResult(exitCode = 0, stderr = '', stdout = ''): CommandResult {
  return { exitCode, stdout, stderr };
}

function context(runCommand: RunCommand): ServiceAdapterContext {
  return {
    homeDirectory: '/Users/example/Home With Spaces ü',
    dataDirectory: '/Users/example/Pimpampum Data ñ',
    nodePath: '/opt/Pimpampum Runtime/bin/node',
    cliPath: '/opt/Pimpampum Runtime/dist/cli.js',
    version: '1.0.0',
    host: '127.0.0.1',
    port: 7337,
    logDirectory: '/Users/example/Pimpampum Data ñ/logs',
    runCommand,
  };
}

describe('LaunchAgent rendering', () => {
  it('renders a valid, shell-free plist with escaped paths and abnormal-only restart', () => {
    const plist = renderLaunchAgent(launchAgentInput());

    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toMatch(/<key>ProgramArguments<\/key>\s*<array>/);
    expect(plist).toContain('/opt/Pimpampum &amp; Runtime/bin/node');
    expect(plist).toContain('&lt;cli&gt; &quot;quoted&quot; &apos;single&apos;.js');
    expect(plist).toContain('/logs &amp; private/daemon.stdout.log');
    expect(plist).toContain('/logs &amp; private/daemon.stderr.log');
    expect(plist).toContain('<key>PIMPAMPUM_HOST</key>');
    expect(plist).toContain('<string>127.0.0.1</string>');
    expect(plist).toContain('<key>PIMPAMPUM_PORT</key>');
    expect(plist).toContain('<string>7337</string>');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
    );
    expect(plist).not.toMatch(/\/bin\/(?:ba)?sh|sh -c|PIMPAMPUM_TOKEN|Bearer/);
    if (process.platform === 'darwin') {
      expect(() =>
        execFileSync('/usr/bin/plutil', ['-lint', '-'], { input: plist, stdio: 'pipe' }),
      ).not.toThrow();
    }
  });

  it('supports every loopback representation', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(renderLaunchAgent(launchAgentInput({ host }))).toContain(`<string>${host}</string>`);
    }
  });

  it('rejects unsafe paths, hosts, ports, and log locations', () => {
    for (const [field, value] of [
      ['nodePath', 'relative-node'],
      ['cliPath', 'relative-cli'],
      ['dataDirectory', 'relative-data'],
      ['logDirectory', 'relative-logs'],
    ] as const) {
      expect(() => renderLaunchAgent(launchAgentInput({ [field]: value }))).toThrow(/absolute/);
    }
    expect(() => renderLaunchAgent(launchAgentInput({ nodePath: '/node\0unsafe' }))).toThrow(
      /null bytes/,
    );
    expect(() => renderLaunchAgent(launchAgentInput({ host: '0.0.0.0' }))).toThrow(/loopback/);
    expect(() => renderLaunchAgent(launchAgentInput({ port: 1.5 }))).toThrow(/integer/);
    expect(() => renderLaunchAgent(launchAgentInput({ port: 0 }))).toThrow(/between/);
    expect(() => renderLaunchAgent(launchAgentInput({ port: 65_536 }))).toThrow(/between/);
    expect(() =>
      renderLaunchAgent(launchAgentInput({ logDirectory: '/Users/example/Pimpampum Data ñ' })),
    ).toThrow(/inside the data/);
    expect(() =>
      renderLaunchAgent(launchAgentInput({ logDirectory: '/Users/example/Other/logs' })),
    ).toThrow(/inside the data/);
  });
});

describe('launchctl adapter', () => {
  it('renders its owned artifact and uses exact argument arrays for the full lifecycle', async () => {
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[0] === 'print'
        ? commandResult(0, '', 'state = running\npid = 123\n')
        : commandResult(),
    );
    const adapter = createLaunchdAdapter({
      guiDomain: 'gui/501',
      launchctlPath: '/custom path/launchctl',
    });
    const adapterContext = context(runCommand);
    const artifacts = adapter.artifacts(adapterContext);
    const expectedPath = join(
      adapterContext.homeDirectory,
      'Library',
      'LaunchAgents',
      `${LAUNCH_AGENT_LABEL}.plist`,
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ path: expectedPath, mode: 0o644 });
    expect(String(artifacts[0]?.content)).toContain(adapterContext.dataDirectory);
    await adapter.activate(adapterContext, artifacts);
    await expect(adapter.isRunning(adapterContext, artifacts)).resolves.toBe(true);
    await adapter.deactivate(adapterContext, artifacts);

    expect(runCommand.mock.calls).toEqual([
      ['/custom path/launchctl', ['bootstrap', 'gui/501', expectedPath]],
      ['/custom path/launchctl', ['kickstart', '-k', `gui/501/${LAUNCH_AGENT_LABEL}`]],
      ['/custom path/launchctl', ['print', `gui/501/${LAUNCH_AGENT_LABEL}`]],
      ['/custom path/launchctl', ['bootout', 'gui/501', expectedPath]],
    ]);
  });

  it('uses the current UID and standard launchctl path by default', () => {
    const adapter = createLaunchdAdapter();
    const runCommand = vi.fn<RunCommand>(async () => commandResult());
    const adapterContext = context(runCommand);
    const artifacts = adapter.artifacts(adapterContext);

    return adapter.activate(adapterContext, artifacts).then(() => {
      expect(runCommand.mock.calls[0]).toEqual([
        '/bin/launchctl',
        ['bootstrap', `gui/${userInfo().uid}`, artifacts[0]!.path],
      ]);
    });
  });

  it('distinguishes running, loaded-but-inactive, missing, and diagnostic errors', async () => {
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/502' });
    for (const [result, expected] of [
      [commandResult(0, '', 'state = running\npid = 123\n'), true],
      [commandResult(0, '', 'state = exited\nlast exit code = 1\n'), false],
      [commandResult(113, 'service not found'), false],
    ] as const) {
      const runCommand = vi.fn<RunCommand>(async () => result);
      await expect(adapter.isRunning(context(runCommand), [])).resolves.toBe(expected);
      expect(runCommand).toHaveBeenCalledWith('/bin/launchctl', [
        'print',
        `gui/502/${LAUNCH_AGENT_LABEL}`,
      ]);
    }
    const denied = vi.fn<RunCommand>(async () => commandResult(13, 'permission denied'));
    await expect(adapter.isRunning(context(denied), [])).rejects.toThrow(
      /launchctl print failed.*permission denied/,
    );
  });

  it('surfaces bootstrap, kickstart, and bootout failures and rolls out partial activation', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    const bootstrapRunner = vi.fn<RunCommand>(async () => commandResult(5, 'bootstrap denied'));
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/503' });
    await expect(adapter.activate(context(bootstrapRunner), [artifact])).rejects.toThrow(
      'launchctl bootstrap failed with exit code 5: bootstrap denied',
    );

    const kickstartRunner = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[0] === 'kickstart' ? commandResult(9) : commandResult(),
    );
    await expect(adapter.activate(context(kickstartRunner), [artifact])).rejects.toThrow(
      'launchctl kickstart failed with exit code 9',
    );
    expect(kickstartRunner.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
      'bootstrap',
      'kickstart',
      'bootout',
    ]);

    const bootoutRunner = vi.fn<RunCommand>(async () => commandResult(4, 'bootout denied'));
    await expect(adapter.deactivate(context(bootoutRunner), [artifact])).rejects.toThrow(
      'launchctl bootout failed with exit code 4: bootout denied',
    );
  });

  it('reconciles a changed plist when the stable label is already loaded', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: 'changed-plist',
      mode: 0o644,
    };
    let bootstrapAttempts = 0;
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'bootstrap') {
        bootstrapAttempts += 1;
        return bootstrapAttempts === 1
          ? commandResult(5, 'service already loaded')
          : commandResult();
      }
      return commandResult();
    });
    const adapter = createLaunchdAdapter({
      guiDomain: 'gui/505',
      launchctlPath: '/custom/launchctl',
    });

    await expect(adapter.activate(context(runCommand), [artifact])).resolves.toBeUndefined();
    await expect(adapter.afterRollback!(context(runCommand), [artifact])).resolves.toBeUndefined();
    expect(runCommand.mock.calls).toEqual([
      ['/custom/launchctl', ['bootstrap', 'gui/505', artifact.path]],
      ['/custom/launchctl', ['print', `gui/505/${LAUNCH_AGENT_LABEL}`]],
      ['/custom/launchctl', ['bootout', 'gui/505', artifact.path]],
      ['/custom/launchctl', ['bootstrap', 'gui/505', artifact.path]],
      ['/custom/launchctl', ['kickstart', '-k', `gui/505/${LAUNCH_AGENT_LABEL}`]],
    ]);
  });

  it('does not unload anything when bootstrap fails and the label is not loaded', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) =>
      arguments_[0] === 'bootstrap'
        ? commandResult(13, 'permission denied')
        : commandResult(113, 'service not found'),
    );
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/506' });

    await expect(adapter.activate(context(runCommand), [artifact])).rejects.toThrow(
      'launchctl bootstrap failed with exit code 13: permission denied',
    );
    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
      'bootstrap',
      'print',
    ]);
    await expect(adapter.afterRollback!(context(runCommand), [artifact])).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('restarts the restored registration after a displaced service fails reconciliation', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: 'new-plist',
      mode: 0o644,
    };
    let bootstrapAttempts = 0;
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'bootstrap') {
        bootstrapAttempts += 1;
        if (bootstrapAttempts === 1) return commandResult(5, 'already loaded');
        if (bootstrapAttempts === 2) return commandResult(78, 'new definition invalid');
      }
      return commandResult();
    });
    const adapter = createLaunchdAdapter({
      guiDomain: 'gui/510',
      launchctlPath: '/custom/launchctl',
    });
    const adapterContext = context(runCommand);

    await expect(adapter.activate(adapterContext, [artifact])).rejects.toThrow(
      'launchctl reconciliation bootstrap failed with exit code 78: new definition invalid',
    );
    await expect(adapter.activate(adapterContext, [artifact])).rejects.toThrow(
      'pending external rollback',
    );
    await expect(adapter.afterRollback!(adapterContext, [artifact])).resolves.toBeUndefined();
    await expect(adapter.afterRollback!(adapterContext, [artifact])).resolves.toBeUndefined();

    expect(runCommand.mock.calls).toEqual([
      ['/custom/launchctl', ['bootstrap', 'gui/510', artifact.path]],
      ['/custom/launchctl', ['print', `gui/510/${LAUNCH_AGENT_LABEL}`]],
      ['/custom/launchctl', ['bootout', 'gui/510', artifact.path]],
      ['/custom/launchctl', ['bootstrap', 'gui/510', artifact.path]],
      ['/custom/launchctl', ['bootstrap', 'gui/510', artifact.path]],
      ['/custom/launchctl', ['kickstart', '-k', `gui/510/${LAUNCH_AGENT_LABEL}`]],
    ]);
  });

  it('restores the displaced registration after a reconciled kickstart failure', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: 'new-plist',
      mode: 0o644,
    };
    let bootstrapAttempts = 0;
    let kickstartAttempts = 0;
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'bootstrap') {
        bootstrapAttempts += 1;
        return bootstrapAttempts === 1 ? commandResult(5, 'already loaded') : commandResult();
      }
      if (arguments_[0] === 'kickstart') {
        kickstartAttempts += 1;
        return kickstartAttempts === 1 ? commandResult(9, 'new service crashed') : commandResult();
      }
      return commandResult();
    });
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/511' });
    const adapterContext = context(runCommand);

    await expect(adapter.activate(adapterContext, [artifact])).rejects.toThrow(
      'launchctl kickstart failed with exit code 9: new service crashed',
    );
    await expect(adapter.afterRollback!(adapterContext, [artifact])).resolves.toBeUndefined();

    expect(
      runCommand.mock.calls.map(([executable, arguments_]) => [executable, arguments_]),
    ).toEqual([
      ['/bin/launchctl', ['bootstrap', 'gui/511', artifact.path]],
      ['/bin/launchctl', ['print', `gui/511/${LAUNCH_AGENT_LABEL}`]],
      ['/bin/launchctl', ['bootout', 'gui/511', artifact.path]],
      ['/bin/launchctl', ['bootstrap', 'gui/511', artifact.path]],
      ['/bin/launchctl', ['kickstart', '-k', `gui/511/${LAUNCH_AGENT_LABEL}`]],
      ['/bin/launchctl', ['bootout', 'gui/511', artifact.path]],
      ['/bin/launchctl', ['bootstrap', 'gui/511', artifact.path]],
      ['/bin/launchctl', ['kickstart', '-k', `gui/511/${LAUNCH_AGENT_LABEL}`]],
    ]);
  });

  it('keeps rollback pending across restoration failures and combines cleanup errors', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: 'new-plist',
      mode: 0o644,
    };
    let call = 0;
    const results: Array<CommandResult | Error> = [
      commandResult(5, 'already loaded'),
      commandResult(),
      commandResult(),
      commandResult(78, 'new definition invalid'),
      commandResult(79, 'restored definition rejected'),
      commandResult(),
      new Error('rollback runner exploded'),
      commandResult(10, 'rollback cleanup failed'),
      commandResult(),
      commandResult(11, 'restored service crashed'),
      commandResult(),
      commandResult(),
      commandResult(),
    ];
    const runCommand = vi.fn<RunCommand>(async () => {
      const result = results[call++];
      if (result instanceof Error) throw result;
      return result ?? commandResult();
    });
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/512' });
    const adapterContext = context(runCommand);

    await expect(adapter.activate(adapterContext, [artifact])).rejects.toThrow(
      /reconciliation bootstrap.*new definition invalid/,
    );
    await expect(adapter.afterRollback!(adapterContext, [artifact])).rejects.toThrow(
      /rollback bootstrap.*restored definition rejected/,
    );
    await expect(adapter.afterRollback!(adapterContext, [artifact])).rejects.toThrow(
      /rollback runner exploded.*partial-registration cleanup also failed.*rollback cleanup failed/s,
    );
    await expect(adapter.afterRollback!(adapterContext, [artifact])).rejects.toThrow(
      /rollback kickstart failed.*restored service crashed/,
    );
    await expect(adapter.afterRollback!(adapterContext, [artifact])).resolves.toBeUndefined();

    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ['bootstrap', 'gui/512', artifact.path],
      ['print', `gui/512/${LAUNCH_AGENT_LABEL}`],
      ['bootout', 'gui/512', artifact.path],
      ['bootstrap', 'gui/512', artifact.path],
      ['bootstrap', 'gui/512', artifact.path],
      ['bootstrap', 'gui/512', artifact.path],
      ['kickstart', '-k', `gui/512/${LAUNCH_AGENT_LABEL}`],
      ['bootout', 'gui/512', artifact.path],
      ['bootstrap', 'gui/512', artifact.path],
      ['kickstart', '-k', `gui/512/${LAUNCH_AGENT_LABEL}`],
      ['bootout', 'gui/512', artifact.path],
      ['bootstrap', 'gui/512', artifact.path],
      ['kickstart', '-k', `gui/512/${LAUNCH_AGENT_LABEL}`],
    ]);
  });

  it('stops reconciliation if the loaded service cannot be booted out or re-bootstrapped', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    const bootoutFailure = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'bootstrap') return commandResult(5, 'loaded');
      if (arguments_[0] === 'bootout') return commandResult(77, 'cannot unload');
      return commandResult();
    });
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/507' });
    await expect(adapter.activate(context(bootoutFailure), [artifact])).rejects.toThrow(
      'launchctl reconciliation bootout failed with exit code 77: cannot unload',
    );
    expect(bootoutFailure.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
      'bootstrap',
      'print',
      'bootout',
    ]);

    let bootstrapAttempts = 0;
    const retryFailure = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'bootstrap') {
        bootstrapAttempts += 1;
        return bootstrapAttempts === 1
          ? commandResult(5, 'loaded')
          : commandResult(78, 'new definition invalid');
      }
      return commandResult();
    });
    await expect(adapter.activate(context(retryFailure), [artifact])).rejects.toThrow(
      'launchctl reconciliation bootstrap failed with exit code 78: new definition invalid',
    );
    expect(retryFailure.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
      'bootstrap',
      'print',
      'bootout',
      'bootstrap',
    ]);
  });

  it('reports both activation and cleanup failures after a partial registration', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'kickstart') return commandResult(9, 'kickstart failed');
      if (arguments_[0] === 'bootout') return commandResult(10, 'cleanup failed');
      return commandResult();
    });
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/508' });

    await expect(adapter.activate(context(runCommand), [artifact])).rejects.toThrow(
      /kickstart failed.*cleanup also failed.*bootout failed/s,
    );
    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
      'bootstrap',
      'kickstart',
      'bootout',
    ]);

    const cleanupRejection = vi.fn<RunCommand>(async (_executable, arguments_) => {
      if (arguments_[0] === 'kickstart') return commandResult(9, 'kickstart failed');
      if (arguments_[0] === 'bootout') throw new Error('cleanup runner rejected');
      return commandResult();
    });
    await expect(adapter.activate(context(cleanupRejection), [artifact])).rejects.toThrow(
      /kickstart failed.*cleanup also failed.*cleanup runner rejected/s,
    );
  });

  it('treats only recognized missing registrations as an idempotent bootout', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    for (const stderr of [
      'Boot-out failed: 3: No such process',
      'Could not find service dev.pimpampum.daemon',
      'service is not loaded',
      'service not found',
    ]) {
      const missingRunner = vi.fn<RunCommand>(async () => commandResult(1, stderr));
      const adapter = createLaunchdAdapter({ guiDomain: 'gui/513' });
      await expect(adapter.deactivate(context(missingRunner), [artifact])).resolves.toBeUndefined();
    }

    for (const stderr of ['permission denied', '', 'input/output error']) {
      const errorRunner = vi.fn<RunCommand>(async () => commandResult(1, stderr));
      const adapter = createLaunchdAdapter({ guiDomain: 'gui/513' });
      await expect(adapter.deactivate(context(errorRunner), [artifact])).rejects.toThrow(
        'launchctl bootout failed with exit code 1',
      );
    }
  });

  it('cleans up partial registration when the kickstart runner rejects', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    for (const rejection of [new Error('runner exploded'), 'non-error rejection']) {
      const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
        if (arguments_[0] === 'kickstart') throw rejection;
        return commandResult();
      });
      const adapter = createLaunchdAdapter({ guiDomain: 'gui/509' });

      await expect(adapter.activate(context(runCommand), [artifact])).rejects.toThrow(
        String(rejection instanceof Error ? rejection.message : rejection),
      );
      expect(runCommand.mock.calls.map(([, arguments_]) => arguments_[0])).toEqual([
        'bootstrap',
        'kickstart',
        'bootout',
      ]);
    }
  });

  it('rejects invalid adapter configuration and missing lifecycle artifacts', async () => {
    expect(() => createLaunchdAdapter({ guiDomain: 'user/501' })).toThrow(/GUI domain/);
    expect(() => createLaunchdAdapter({ launchctlPath: 'launchctl' })).toThrow(/absolute/);
    expect(() => createLaunchdAdapter({ launchctlPath: '/launchctl\0unsafe' })).toThrow(
      /null bytes/,
    );
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/504' });
    const adapterContext = context(vi.fn<RunCommand>());
    await expect(adapter.activate(adapterContext, [])).rejects.toThrow(/requires.*artifact/);
    await expect(adapter.deactivate(adapterContext, [])).rejects.toThrow(/requires.*artifact/);
  });

  it.each([
    {
      label: 'running',
      state: commandResult(0, '', 'state = running\n'),
      restore: ['kickstart', '-k', `gui/520/${LAUNCH_AGENT_LABEL}`],
    },
    {
      label: 'loaded but inactive',
      state: commandResult(0, '', 'state = exited\n'),
      restore: ['kill', 'SIGTERM', `gui/520/${LAUNCH_AGENT_LABEL}`],
    },
    {
      label: 'not loaded',
      state: commandResult(113, 'service not found'),
      restore: null,
    },
  ])('restores the exact prior launchd state: $label', async ({ state, restore }) => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    let calls = 0;
    const runCommand = vi.fn<RunCommand>(async (_executable, arguments_) => {
      calls += 1;
      if (calls === 1) return state;
      if (!restore && arguments_[0] === 'bootout') return commandResult(113, 'service not found');
      return commandResult();
    });
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/520' });
    const adapterContext = context(runCommand);

    const rollback = await adapter.prepareDeactivationRollback!(adapterContext, [artifact]);
    await adapter.deactivate(adapterContext, [artifact]);
    await rollback();

    expect(runCommand.mock.calls.map(([, arguments_]) => arguments_)).toEqual([
      ['print', `gui/520/${LAUNCH_AGENT_LABEL}`],
      ['bootout', 'gui/520', artifact.path],
      ['bootout', 'gui/520', artifact.path],
      ...(restore ? [['bootstrap', 'gui/520', artifact.path], restore] : []),
    ]);
  });

  it('surfaces every exact-state launchd snapshot and restoration failure', async () => {
    const artifact: ServiceArtifact = {
      path: '/Users/example/Library/LaunchAgents/dev.pimpampum.daemon.plist',
      content: '',
      mode: 0o644,
    };
    const adapter = createLaunchdAdapter({ guiDomain: 'gui/521' });
    const deniedSnapshot = vi.fn<RunCommand>(async () => commandResult(13, 'permission denied'));
    await expect(
      adapter.prepareDeactivationRollback!(context(deniedSnapshot), [artifact]),
    ).rejects.toThrow(/print before deactivation.*permission denied/);

    for (const [label, failingCall, expected] of [
      ['bootout', 2, /rollback bootout/],
      ['bootstrap', 3, /rollback bootstrap/],
      ['restart', 4, /rollback kickstart/],
    ] as const) {
      let call = 0;
      const runCommand = vi.fn<RunCommand>(async () => {
        call += 1;
        if (call === 1) return commandResult(0, '', 'state = running\n');
        return call === failingCall ? commandResult(77, `${label} denied`) : commandResult();
      });
      const rollback = await adapter.prepareDeactivationRollback!(context(runCommand), [artifact]);
      await expect(rollback()).rejects.toThrow(expected);
    }

    let inactiveCall = 0;
    const inactiveRunner = vi.fn<RunCommand>(async () => {
      inactiveCall += 1;
      if (inactiveCall === 1) return commandResult(0, '', 'state = exited\n');
      return inactiveCall === 4 ? commandResult(78, 'stop denied') : commandResult();
    });
    const inactiveRollback = await adapter.prepareDeactivationRollback!(context(inactiveRunner), [
      artifact,
    ]);
    await expect(inactiveRollback()).rejects.toThrow(/rollback stop.*stop denied/);
  });
});
