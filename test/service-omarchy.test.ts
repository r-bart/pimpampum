import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformServiceManager } from '../src/service/manager.js';
import {
  createOmarchyAdapter,
  isCompatibleOmarchyVersion,
  OMARCHY_PLUGIN_ID,
} from '../src/service/omarchy.js';
import type {
  CommandResult,
  PlatformServiceAdapter,
  PlatformServiceManagerInput,
  RunCommand,
  ServiceAdapterContext,
} from '../src/service/types.js';

const roots: string[] = [];
const repositoryPlugin = join(process.cwd(), 'integrations', 'omarchy', 'pimpampum-status');

interface Fixture {
  root: string;
  home: string;
  data: string;
  source: string;
  target: string;
  unit: string;
}

interface FakeQuattro {
  runCommand: ReturnType<typeof vi.fn<RunCommand>>;
  commands: Array<[string, string[]]>;
  backups: string[];
  state: {
    installed: boolean;
    enabled: boolean;
    fail: string | null;
    invalidList: string | null;
    invalidShellConfig: string | null;
    enableReadinessResponses: string[];
    ignoredRescans: number;
    ignoreWidgetSettings: boolean;
    layout: Record<'left' | 'center' | 'right', Array<Record<string, unknown>>>;
  };
}

interface FakeDaemonState {
  enabled: boolean;
  running: boolean;
}

function fixture(label: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-omarchy-service-${label}-`));
  roots.push(root);
  const home = join(root, 'Home With Spaces ü');
  const data = join(root, "Data 'ñ");
  const source = join(root, 'package', 'pimpampum-status');
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  cpSync(repositoryPlugin, source, { recursive: true });
  writeFileSync(join(data, 'token'), 'preserve-me');
  return {
    root,
    home,
    data,
    source,
    target: join(home, '.config', 'omarchy', 'plugins', OMARCHY_PLUGIN_ID),
    unit: join(home, '.config', 'systemd', 'user', 'pimpampum.service'),
  };
}

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fakeQuattro(root: Fixture): FakeQuattro {
  const commands: Array<[string, string[]]> = [];
  const backups: string[] = [];
  const state: FakeQuattro['state'] = {
    installed: false,
    enabled: false,
    fail: null as string | null,
    invalidList: null as string | null,
    invalidShellConfig: null as string | null,
    enableReadinessResponses: [],
    ignoredRescans: 0,
    ignoreWidgetSettings: false,
    layout: {
      left: [{ id: 'omarchy.menu' }],
      center: [{ id: 'omarchy.clock', format: 'HH:mm' }],
      right: [{ id: 'omarchy.tray' }],
    },
  };
  const removeWidget = (): void => {
    for (const entries of Object.values(state.layout)) {
      const index = entries.findIndex((entry) => entry.id === OMARCHY_PLUGIN_ID);
      if (index >= 0) entries.splice(index, 1);
    }
    state.enabled = false;
  };
  const widgetLocation = (): { section: 'left' | 'center' | 'right'; index: number } | null => {
    for (const section of ['left', 'center', 'right'] as const) {
      const index = state.layout[section].findIndex((entry) => entry.id === OMARCHY_PLUGIN_ID);
      if (index >= 0) return { section, index };
    }
    return null;
  };
  const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
    commands.push([executable, [...arguments_]]);
    const key = arguments_.join(' ');
    if (key === `plugin remove ${OMARCHY_PLUGIN_ID} --yes`) {
      const backup = join(
        dirname(root.target),
        `.${OMARCHY_PLUGIN_ID}.bak.20260826000000-${backups.length + 1}`,
      );
      renameSync(root.target, backup);
      backups.push(backup);
      state.installed = false;
      removeWidget();
      const stdout = `Removed ${OMARCHY_PLUGIN_ID}. Backup at: ${backup}\n`;
      return state.fail === key
        ? { exitCode: 72, stdout, stderr: 'simulated rescan failure' }
        : ok(stdout);
    }
    if (state.fail === key) return { exitCode: 72, stdout: '', stderr: 'simulated failure' };
    if (key === 'version' || key === '--version') return ok('Omarchy 4.0.0 Quattro\n');
    if (key === 'shell ping') return ok('ok\n');
    if (key === 'shell rescanPlugins') {
      if (state.ignoredRescans > 0) {
        state.ignoredRescans -= 1;
        return ok();
      }
      state.installed = existsSync(root.target) && state.enableReadinessResponses.length === 0;
      if (!state.installed) state.enabled = false;
      return ok();
    }
    if (key === 'shell listShellConfig') {
      if (state.invalidShellConfig !== null) return ok(state.invalidShellConfig);
      return ok(JSON.stringify({ version: 1, bar: { layout: state.layout } }));
    }
    if (arguments_[0] === 'shell' && arguments_[1] === 'setPluginEnabled') {
      if (arguments_[2] !== OMARCHY_PLUGIN_ID || arguments_[3] !== 'false') {
        return ok('unknown');
      }
      removeWidget();
      return ok('ok');
    }
    if (arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin') {
      const readinessResponse = state.enableReadinessResponses.shift();
      if (readinessResponse !== undefined) {
        return ok(readinessResponse);
      }
      if (arguments_[2] !== OMARCHY_PLUGIN_ID || !state.installed) return ok('unknown');
      removeWidget();
      const placement = JSON.parse(arguments_[3] ?? '{}') as { section?: unknown; index?: unknown };
      const section = ['left', 'center', 'right'].includes(String(placement.section))
        ? (placement.section as 'left' | 'center' | 'right')
        : 'right';
      const requested = typeof placement.index === 'number' ? Math.floor(placement.index) : 0;
      const index = Math.max(0, Math.min(requested, state.layout[section].length));
      state.layout[section].splice(index, 0, { id: OMARCHY_PLUGIN_ID });
      state.enabled = true;
      return ok('ok');
    }
    if (arguments_[0] === 'shell' && arguments_[1] === 'setBarWidget') {
      const selector = JSON.parse(arguments_[5] ?? '{}') as { section?: unknown; index?: unknown };
      const section = selector.section as 'left' | 'center' | 'right';
      const index = selector.index as number;
      const entry = state.layout[section]?.[index];
      if (!entry || entry.id !== arguments_[2]) return ok('unknown');
      if (state.ignoreWidgetSettings) return ok('ok');
      entry[arguments_[3]!] = JSON.parse(arguments_[4]!) as unknown;
      return ok('ok');
    }
    if (key === 'plugin list --json') {
      if (state.invalidList !== null) return ok(state.invalidList);
      return ok(
        JSON.stringify(
          state.installed
            ? [{ id: OMARCHY_PLUGIN_ID, enabled: state.enabled, active: state.enabled }]
            : [],
        ),
      );
    }
    if (key === 'plugin enable --help' || key === 'plugin remove --help') return ok('help');
    if (arguments_[0] === 'plugin' && arguments_[1] === 'validate') {
      if (!existsSync(arguments_[2]!)) return { exitCode: 2, stdout: '', stderr: 'missing' };
      return ok('valid');
    }
    if (key === `plugin enable ${OMARCHY_PLUGIN_ID}`) {
      state.installed = existsSync(root.target);
      state.enabled = state.installed;
      if (state.enabled && !widgetLocation()) {
        state.layout.right.push({ id: OMARCHY_PLUGIN_ID });
      }
      return state.installed ? ok() : { exitCode: 3, stdout: '', stderr: 'unknown' };
    }
    if (key === `plugin disable ${OMARCHY_PLUGIN_ID}`) {
      removeWidget();
      return ok();
    }
    throw new Error(`Unexpected command: ${executable} ${key}`);
  });
  return { runCommand, commands, backups, state };
}

function daemon(
  root: Fixture,
  events: string[],
  externalState?: FakeDaemonState,
): PlatformServiceAdapter {
  const state = externalState ?? { enabled: false, running: false };
  return {
    id: 'fake-systemd',
    platform: 'linux',
    artifacts: () => [{ path: root.unit, content: 'unit-v1', mode: 0o600 }],
    ownedArtifactRoots: () => [join(root.home, '.config', 'systemd', 'user')],
    async preflight(_context, _artifacts, operation) {
      events.push(`daemon-preflight-${operation}`);
    },
    async activate() {
      state.enabled = true;
      state.running = true;
      events.push('daemon-activate');
    },
    async rollbackActivation() {
      state.enabled = false;
      state.running = false;
      events.push('daemon-rollback-activation');
    },
    async afterRollback() {
      events.push('daemon-after-rollback');
    },
    async prepareDeactivationRollback() {
      const previous = { ...state };
      return async () => {
        state.enabled = previous.enabled;
        state.running = previous.running;
        events.push('daemon-restore-deactivation');
      };
    },
    async deactivate() {
      state.enabled = false;
      state.running = false;
      events.push('daemon-deactivate');
    },
    async isRunning() {
      return state.running;
    },
  };
}

function context(root: Fixture, runCommand: RunCommand): ServiceAdapterContext {
  return {
    homeDirectory: root.home,
    dataDirectory: root.data,
    nodePath: '/usr/bin/node',
    cliPath: '/opt/pimpampum/dist/cli.js',
    version: '1.0.0',
    host: '127.0.0.1',
    port: 7337,
    logDirectory: join(root.data, 'logs'),
    runCommand,
  };
}

function managerInput(
  root: Fixture,
  runCommand: RunCommand,
  adapter: PlatformServiceAdapter,
): PlatformServiceManagerInput {
  return {
    platform: 'linux',
    homeDirectory: root.home,
    dataDirectory: root.data,
    nodePath: '/usr/bin/node',
    cliPath: '/opt/pimpampum/dist/cli.js',
    version: '1.0.0',
    runCommand,
    adapters: { linux: adapter },
  };
}

function adapter(root: Fixture, daemonAdapter: PlatformServiceAdapter): PlatformServiceAdapter {
  return createOmarchyAdapter({
    pluginSourcePath: root.source,
    daemonAdapter,
    omarchyPath: '/usr/bin/omarchy',
    omarchyShellPath: '/usr/bin/omarchy-shell',
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Omarchy Quattro composite service adapter', () => {
  it('recognizes only explicit Quattro or Omarchy 4 version output', () => {
    expect(isCompatibleOmarchyVersion('Omarchy Quattro test')).toBe(true);
    expect(isCompatibleOmarchyVersion('Omarchy 4.0.0.r1333')).toBe(true);
    expect(isCompatibleOmarchyVersion(' 4 ')).toBe(true);
    expect(isCompatibleOmarchyVersion('Omarchy 3.9.2')).toBe(false);
    expect(isCompatibleOmarchyVersion('')).toBe(false);
  });

  it('automatically owns one transactional install, repeat status and uninstall lifecycle', async () => {
    const root = fixture('lifecycle');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const manager = createPlatformServiceManager(managerInput(root, quattro.runCommand, composite));

    await expect(manager.install()).resolves.toMatchObject({
      installed: true,
      reconciled: false,
      omarchyPlugin: 'enabled',
    });
    quattro.state.installed = true;
    await expect(manager.status()).resolves.toMatchObject({
      installed: true,
      running: true,
      adapter: 'systemd-omarchy-quattro',
      omarchyPlugin: 'enabled',
    });
    await expect(manager.install()).resolves.toMatchObject({ reconciled: true });
    expect(
      quattro.commands.filter(([, arguments_]) =>
        arguments_.join(' ').startsWith(`plugin enable ${OMARCHY_PLUGIN_ID}`),
      ),
    ).toHaveLength(1);
    expect(readFileSync(join(root.target, 'manifest.json'), 'utf8')).toContain(OMARCHY_PLUGIN_ID);
    expect(readFileSync(join(root.target, 'install.sh'), 'utf8')).toContain('pimpampum_cli');
    expect(events.slice(0, 2)).toEqual(['daemon-preflight-install', 'daemon-activate']);
    const unrelatedBackup = join(
      dirname(root.target),
      `.${OMARCHY_PLUGIN_ID}.bak.unrelated-existing`,
    );
    mkdirSync(unrelatedBackup);
    writeFileSync(join(unrelatedBackup, 'keep'), 'unrelated');

    await expect(manager.uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    expect(existsSync(root.target)).toBe(false);
    expect(quattro.backups).toHaveLength(1);
    expect(existsSync(quattro.backups[0]!)).toBe(false);
    expect(readFileSync(join(unrelatedBackup, 'keep'), 'utf8')).toBe('unrelated');
    expect(existsSync(root.unit)).toBe(false);
    expect(readFileSync(join(root.data, 'token'), 'utf8')).toBe('preserve-me');
    expect(quattro.commands).toContainEqual([
      '/usr/bin/omarchy',
      ['plugin', 'remove', OMARCHY_PLUGIN_ID, '--yes'],
    ]);
    await composite.afterUninstall!(context(root, quattro.runCommand), []);
  });

  it('runs every compatibility, IPC and candidate check before the first manager write', async () => {
    const root = fixture('preflight-order');
    const quattro = fakeQuattro(root);
    const targetObservations: boolean[] = [];
    const original = quattro.runCommand.getMockImplementation()!;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      targetObservations.push(existsSync(root.target));
      return original(executable, arguments_);
    });
    const composite = adapter(root, daemon(root, []));

    await createPlatformServiceManager(managerInput(root, quattro.runCommand, composite)).install();

    expect(targetObservations.slice(0, 5)).toEqual([false, false, false, false, false]);
    expect(quattro.commands.slice(0, 5).map(([, arguments_]) => arguments_.join(' '))).toEqual([
      'version',
      'shell ping',
      'plugin list --json',
      `plugin validate ${realpathSync(root.source)}`,
      'plugin enable --help',
    ]);
  });

  it('falls back to the legacy Omarchy version flag', async () => {
    const root = fixture('legacy-version');
    const quattro = fakeQuattro(root);
    quattro.state.fail = 'version';
    const composite = adapter(root, daemon(root, []));

    await createPlatformServiceManager(managerInput(root, quattro.runCommand, composite)).install();

    expect(quattro.commands.slice(0, 2).map(([, arguments_]) => arguments_.join(' '))).toEqual([
      'version',
      '--version',
    ]);
  });

  it('restores plugin files, enabled state and daemon state after a partial activation failure', async () => {
    const root = fixture('activation-rollback');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const original = quattro.runCommand.getMockImplementation()!;
    let rescans = 0;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      if (arguments_.join(' ') === 'shell rescanPlugins') {
        rescans += 1;
        if (rescans === 1) {
          return { exitCode: 72, stdout: '', stderr: 'simulated failure' };
        }
      }
      return original(executable, arguments_);
    });
    const composite = adapter(root, daemon(root, events));

    await expect(
      createPlatformServiceManager(managerInput(root, quattro.runCommand, composite)).install(),
    ).rejects.toThrow(/rescanPlugins/u);
    expect(existsSync(root.target)).toBe(false);
    expect(existsSync(root.unit)).toBe(false);
    expect(quattro.state.enabled).toBe(false);
    expect(events).toContain('daemon-after-rollback');
  });

  it('restores exact external state when plugin removal fails during uninstall', async () => {
    const root = fixture('uninstall-rollback');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const manager = createPlatformServiceManager(managerInput(root, quattro.runCommand, composite));
    await manager.install();
    quattro.state.installed = true;
    quattro.state.enabled = true;
    quattro.state.layout = {
      left: [
        { id: 'omarchy.menu', label: 'untouched-left' },
        {
          id: OMARCHY_PLUGIN_ID,
          density: 'compact',
          refreshSeconds: 17,
          nested: { badges: ['active', 'completed'] },
        },
        { id: 'community.weather', city: 'Madrid' },
      ],
      center: [{ id: 'omarchy.clock', format: 'HH:mm:ss' }],
      right: [{ id: 'omarchy.tray', iconSize: 19 }],
    };
    const exactLayoutBefore = structuredClone(quattro.state.layout);
    quattro.state.enableReadinessResponses = ['not ready'];
    quattro.state.ignoredRescans = 1;
    quattro.state.fail = `plugin remove ${OMARCHY_PLUGIN_ID} --yes`;
    const original = quattro.runCommand.getMockImplementation()!;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      const result = await original(executable, arguments_);
      return arguments_.join(' ') === `plugin remove ${OMARCHY_PLUGIN_ID} --yes`
        ? { ...result, stdout: '' }
        : result;
    });

    await expect(manager.uninstall()).rejects.toThrow(/plugin remove/u);

    expect(existsSync(join(root.target, 'manifest.json'))).toBe(true);
    expect(quattro.backups).toHaveLength(1);
    expect(existsSync(quattro.backups[0]!)).toBe(false);
    expect(quattro.state.enabled).toBe(true);
    expect(quattro.state.layout).toEqual(exactLayoutBefore);
    expect(quattro.commands.map(([, arguments_]) => arguments_.slice(0, 2).join(' '))).toContain(
      'shell listShellConfig',
    );
    expect(quattro.commands).toContainEqual([
      '/usr/bin/omarchy-shell',
      ['shell', 'enablePlugin', OMARCHY_PLUGIN_ID, JSON.stringify({ section: 'left', index: 1 })],
    ]);
    expect(
      quattro.commands.filter(
        ([, arguments_]) => arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin',
      ),
    ).toEqual(
      Array.from({ length: 3 }, () => [
        '/usr/bin/omarchy-shell',
        ['shell', 'enablePlugin', OMARCHY_PLUGIN_ID, JSON.stringify({ section: 'left', index: 1 })],
      ]),
    );
    expect(
      quattro.commands.filter(
        ([, arguments_]) => arguments_[0] === 'shell' && arguments_[1] === 'rescanPlugins',
      ),
    ).toHaveLength(3);
    expect(
      quattro.commands.some(
        ([, arguments_]) =>
          arguments_[0] === 'shell' &&
          arguments_[1] === 'setBarWidget' &&
          arguments_[3] === 'nested',
      ),
    ).toBe(true);
    expect(events).toContain('daemon-restore-deactivation');
    await expect(manager.status()).resolves.toMatchObject({ installed: true, running: true });
  });

  it('restores a previously running daemon after a downstream changed-install failure', async () => {
    const root = fixture('changed-install-daemon-rollback');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const manager = createPlatformServiceManager(managerInput(root, quattro.runCommand, composite));
    await manager.install();
    quattro.state.installed = true;
    quattro.state.enabled = true;
    writeFileSync(join(root.source, 'README.md'), '# changed candidate\n');
    const original = quattro.runCommand.getMockImplementation()!;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      if (
        arguments_[0] === 'plugin' &&
        arguments_[1] === 'validate' &&
        arguments_[2] === root.target
      ) {
        return { exitCode: 75, stdout: '', stderr: 'changed candidate failed' };
      }
      return original(executable, arguments_);
    });

    await expect(manager.install()).rejects.toThrow(/changed candidate failed/u);
    quattro.runCommand.mockImplementation(original);

    expect(events).toContain('daemon-restore-deactivation');
    await expect(manager.status()).resolves.toMatchObject({ installed: true, running: true });
  });

  it.each([
    { label: 'enabled-stopped', enabled: true },
    { label: 'disabled-stopped', enabled: false },
  ])('restores exact $label daemon state after a changed install fails', async (initial) => {
    const root = fixture(`changed-install-${initial.label}`);
    const quattro = fakeQuattro(root);
    const daemonState: FakeDaemonState = { enabled: false, running: false };
    const composite = adapter(root, daemon(root, [], daemonState));
    const manager = createPlatformServiceManager(managerInput(root, quattro.runCommand, composite));
    await manager.install();
    daemonState.enabled = initial.enabled;
    daemonState.running = false;
    writeFileSync(join(root.source, 'README.md'), '# changed candidate\n');
    const original = quattro.runCommand.getMockImplementation()!;
    quattro.runCommand.mockImplementation(async (executable, arguments_) =>
      arguments_[0] === 'plugin' && arguments_[1] === 'validate' && arguments_[2] === root.target
        ? { exitCode: 75, stdout: '', stderr: 'changed candidate failed' }
        : original(executable, arguments_),
    );

    await expect(manager.install()).rejects.toThrow(/changed candidate failed/u);
    expect(daemonState).toEqual({ enabled: initial.enabled, running: false });
  });

  it('uses the receipt adapter across runtime detection drift and reports a missing plugin', async () => {
    const root = fixture('receipt-continuity');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    const manager = createPlatformServiceManager(managerInput(root, quattro.runCommand, composite));
    await manager.install();
    quattro.state.installed = true;
    const plainSystemd = daemon(root, []);
    const unavailableInput = managerInput(root, quattro.runCommand, plainSystemd);
    await expect(createPlatformServiceManager(unavailableInput).status()).rejects.toThrow(
      /systemd-omarchy-quattro is unavailable/u,
    );
    await expect(
      createPlatformServiceManager({
        ...unavailableInput,
        receiptAdapters: {
          [composite.id]: { ...composite, platform: 'darwin' },
        },
      }).status(),
    ).rejects.toThrow(/platform mismatch/u);

    const continuationInput = {
      ...unavailableInput,
      receiptAdapters: { [composite.id]: composite },
    };
    await expect(createPlatformServiceManager(continuationInput).status()).resolves.toMatchObject({
      installed: true,
      adapter: composite.id,
      omarchyPlugin: 'enabled',
    });

    rmSync(root.target, { recursive: true });
    quattro.state.installed = false;
    quattro.state.enabled = false;
    await expect(createPlatformServiceManager(continuationInput).status()).resolves.toMatchObject({
      installed: false,
      running: false,
      adapter: composite.id,
      omarchyPlugin: 'missing',
    });
  });

  it('binds installed helpers to the canonical CLI and keeps backup paths as one argument', async () => {
    const root = fixture('canonical-helper');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    const cliPath = join(root.root, 'fake-cli.mjs');
    const outputPath = join(root.root, 'helper-output.json');
    writeFileSync(
      cliPath,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.HELPER_OUTPUT, JSON.stringify({ dataDirectory: process.env.PIMPAMPUM_DATA_DIR, host: process.env.PIMPAMPUM_HOST, port: process.env.PIMPAMPUM_PORT, arguments: process.argv.slice(2) }));
`,
    );
    const input = {
      ...managerInput(root, quattro.runCommand, composite),
      nodePath: process.execPath,
      cliPath,
    };
    await createPlatformServiceManager(input).install();

    const helper = join(root.target, 'pimpampum-overview');
    execFileSync(helper, [], {
      env: {
        ...process.env,
        HELPER_OUTPUT: outputPath,
        PIMPAMPUM_DATA_DIR: '/wrong/data/directory',
      },
    });
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
      dataDirectory: root.data,
      host: '127.0.0.1',
      port: '7337',
      arguments: ['overview'],
    });
    expect(readFileSync(helper, 'utf8')).toContain(process.execPath);

    const backupHelper = join(root.target, 'pimpampum-backup');
    const backupDirectory = join(root.root, "Dropbox ü ; $(touch nope) 'quoted'");
    execFileSync(backupHelper, ['configure', backupDirectory], {
      env: {
        ...process.env,
        HELPER_OUTPUT: outputPath,
        PIMPAMPUM_DATA_DIR: '/wrong/data/directory',
      },
    });
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
      dataDirectory: root.data,
      host: '127.0.0.1',
      port: '7337',
      arguments: ['backup', 'configure', backupDirectory],
    });
    expect(existsSync(join(root.root, 'nope'))).toBe(false);
    expect(readFileSync(backupHelper, 'utf8')).toContain('backup "$@"');
  });

  it('refuses to pass unreceipted plugin content to the destructive official remove command', async () => {
    const root = fixture('unreceipted-removal-content');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    const manager = createPlatformServiceManager(managerInput(root, quattro.runCommand, composite));
    await manager.install();
    quattro.state.installed = true;
    quattro.state.enabled = true;
    const personalFile = join(root.target, 'personal-file');
    writeFileSync(personalFile, 'do not remove');

    await expect(manager.uninstall()).rejects.toThrow(/unreceipted Omarchy plugin artifact/u);
    expect(readFileSync(personalFile, 'utf8')).toBe('do not remove');
    expect(quattro.backups).toEqual([]);
  });

  it('rejects unsafe removal trees before invoking the official destructive command', async () => {
    for (const variant of ['symlink', 'directory'] as const) {
      const root = fixture(`unsafe-removal-tree-${variant}`);
      const quattro = fakeQuattro(root);
      const composite = adapter(root, daemon(root, []));
      const manager = createPlatformServiceManager(
        managerInput(root, quattro.runCommand, composite),
      );
      await manager.install();
      quattro.state.installed = true;
      if (variant === 'symlink') symlinkSync('/tmp', join(root.target, 'unreceipted'));
      else mkdirSync(join(root.target, 'unreceipted'));

      await expect(manager.uninstall()).rejects.toThrow(
        variant === 'symlink' ? /containing a symlink/u : /unreceipted Omarchy plugin directory/u,
      );
      expect(quattro.backups).toEqual([]);
    }
  });

  it('rejects missing, non-directory, unsafe, and absent official backup reports safely', async () => {
    for (const variant of ['missing', 'file', 'unsafe', 'absent'] as const) {
      const root = fixture(`invalid-official-backup-${variant}`);
      const quattro = fakeQuattro(root);
      const composite = adapter(root, daemon(root, []));
      const manager = createPlatformServiceManager(
        managerInput(root, quattro.runCommand, composite),
      );
      await manager.install();
      quattro.state.installed = true;
      quattro.state.enabled = true;
      const preexisting = join(dirname(root.target), `.${OMARCHY_PLUGIN_ID}.bak.preexisting`);
      mkdirSync(preexisting);
      const original = quattro.runCommand.getMockImplementation()!;
      quattro.runCommand.mockImplementation(async (executable, arguments_) => {
        const result = await original(executable, arguments_);
        if (arguments_.join(' ') !== `plugin remove ${OMARCHY_PLUGIN_ID} --yes`) return result;
        const backup = quattro.backups.at(-1)!;
        if (variant === 'missing' || variant === 'absent') rmSync(backup, { recursive: true });
        if (variant === 'file') {
          rmSync(backup, { recursive: true });
          writeFileSync(backup, 'not a directory');
        }
        if (variant === 'unsafe') {
          return ok(`Removed ${OMARCHY_PLUGIN_ID}. Backup at: ${preexisting}\n`);
        }
        if (variant === 'absent') return ok('Removed without a backup\n');
        return result;
      });

      await expect(manager.uninstall()).rejects.toThrow(
        variant === 'file'
          ? AggregateError
          : variant === 'missing' || variant === 'unsafe'
            ? /unsafe or pre-existing backup/u
            : /did not report its owned backup/u,
      );
      expect(existsSync(join(root.target, 'manifest.json'))).toBe(true);
      expect(existsSync(preexisting)).toBe(true);
      if (variant === 'unsafe') expect(existsSync(quattro.backups.at(-1)!)).toBe(false);
    }
  });

  it('rejects malformed, duplicate and unbounded shell layout snapshots before removal', async () => {
    const cases = [
      { label: 'invalid-json', output: 'not json', error: /invalid JSON/u },
      { label: 'primitive-config', output: '[]', error: /incompatible/u },
      { label: 'primitive-bar', output: JSON.stringify({ bar: [] }), error: /incompatible/u },
      { label: 'missing-layout', output: JSON.stringify({ bar: {} }), error: /incompatible/u },
      {
        label: 'primitive-widget-entry',
        output: JSON.stringify({
          bar: {
            layout: { left: [OMARCHY_PLUGIN_ID], center: ['other-widget'], right: [] },
          },
        }),
        error: /must be an object/u,
      },
      {
        label: 'duplicate',
        output: JSON.stringify({
          bar: {
            layout: {
              left: [{ id: OMARCHY_PLUGIN_ID }],
              center: [],
              right: [{ id: OMARCHY_PLUGIN_ID }],
            },
          },
        }),
        error: /multiple unsupported/u,
      },
      {
        label: 'too-many-entries',
        output: JSON.stringify({
          bar: {
            layout: {
              left: Array.from({ length: 1025 }, () => ({ id: 'other' })),
              center: [],
              right: [],
            },
          },
        }),
        error: /incompatible/u,
      },
      {
        label: 'too-many-settings',
        output: JSON.stringify({
          bar: {
            layout: {
              left: [
                Object.fromEntries([
                  ['id', OMARCHY_PLUGIN_ID],
                  ...Array.from({ length: 64 }, (_, index) => [`setting${index}`, index]),
                ]),
              ],
              center: [],
              right: [],
            },
          },
        }),
        error: /entry exceeded/u,
      },
      {
        label: 'large-widget-entry',
        output: JSON.stringify({
          bar: {
            layout: {
              left: [{ id: OMARCHY_PLUGIN_ID, payload: 'x'.repeat(65 * 1024) }],
              center: [],
              right: [],
            },
          },
        }),
        error: /entry exceeded/u,
      },
      {
        label: 'oversized',
        output: ' '.repeat(1024 * 1024 + 1),
        error: /size limit/u,
      },
    ];
    for (const testCase of cases) {
      const root = fixture(`shell-layout-${testCase.label}`);
      const quattro = fakeQuattro(root);
      const manager = createPlatformServiceManager(
        managerInput(root, quattro.runCommand, adapter(root, daemon(root, []))),
      );
      await manager.install();
      quattro.state.invalidShellConfig = testCase.output;

      await expect(manager.uninstall()).rejects.toThrow(testCase.error);
      expect(quattro.backups).toEqual([]);
      expect(existsSync(root.target)).toBe(true);
    }
  });

  it('covers exact layout restore mutations, disabled layout restore and IPC errors', async () => {
    const moved = fixture('layout-restore-moved');
    const movedQuattro = fakeQuattro(moved);
    const movedAdapter = adapter(moved, daemon(moved, []));
    const movedManager = createPlatformServiceManager(
      managerInput(moved, movedQuattro.runCommand, movedAdapter),
    );
    await movedManager.install();
    const movedContext = context(moved, movedQuattro.runCommand);
    await movedAdapter.preflight!(movedContext, movedAdapter.artifacts(movedContext), 'uninstall');
    const restoreMoved = await movedAdapter.prepareDeactivationRollback!(
      movedContext,
      movedAdapter.artifacts(movedContext),
    );
    const widget = movedQuattro.state.layout.right.pop()!;
    movedQuattro.state.layout.left.unshift(widget);
    await restoreMoved();
    expect(movedQuattro.state.layout.right.at(-1)).toEqual({ id: OMARCHY_PLUGIN_ID });

    const disabled = fixture('layout-restore-disabled');
    const disabledQuattro = fakeQuattro(disabled);
    const disabledAdapter = adapter(disabled, daemon(disabled, []));
    const disabledManager = createPlatformServiceManager(
      managerInput(disabled, disabledQuattro.runCommand, disabledAdapter),
    );
    await disabledManager.install();
    await disabledQuattro.runCommand('/usr/bin/omarchy', ['plugin', 'disable', OMARCHY_PLUGIN_ID]);
    const disabledContext = context(disabled, disabledQuattro.runCommand);
    await disabledAdapter.preflight!(
      disabledContext,
      disabledAdapter.artifacts(disabledContext),
      'uninstall',
    );
    const restoreDisabled = await disabledAdapter.prepareDeactivationRollback!(
      disabledContext,
      disabledAdapter.artifacts(disabledContext),
    );
    disabledQuattro.state.layout.left.push({ id: OMARCHY_PLUGIN_ID });
    disabledQuattro.state.enabled = true;
    await restoreDisabled();
    expect(disabledQuattro.state.enabled).toBe(false);

    disabledQuattro.state.layout.right.push({ id: OMARCHY_PLUGIN_ID });
    disabledQuattro.state.enabled = true;
    await disabledAdapter.preflight!(
      disabledContext,
      disabledAdapter.artifacts(disabledContext),
      'install',
    );
    disabledQuattro.state.enabled = false;
    await disabledAdapter.afterRollback!(
      disabledContext,
      disabledAdapter.artifacts(disabledContext),
    );
    expect(disabledQuattro.state.enabled).toBe(true);

    for (const stdout of ['denied', '']) {
      const failing = fixture(`layout-restore-ipc-${stdout || 'empty'}`);
      const failingQuattro = fakeQuattro(failing);
      const failingAdapter = adapter(failing, daemon(failing, []));
      await createPlatformServiceManager(
        managerInput(failing, failingQuattro.runCommand, failingAdapter),
      ).install();
      const failingContext = context(failing, failingQuattro.runCommand);
      await failingAdapter.preflight!(
        failingContext,
        failingAdapter.artifacts(failingContext),
        'uninstall',
      );
      const restore = await failingAdapter.prepareDeactivationRollback!(
        failingContext,
        failingAdapter.artifacts(failingContext),
      );
      failingQuattro.state.layout.right.pop();
      failingQuattro.state.enabled = false;
      const original = failingQuattro.runCommand.getMockImplementation()!;
      failingQuattro.runCommand.mockImplementation(async (executable, arguments_) =>
        arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin'
          ? ok(stdout)
          : original(executable, arguments_),
      );
      await expect(restore()).rejects.toThrow(/restore Pimpampum widget placement returned/u);
    }

    const exhausted = fixture('layout-restore-readiness-exhausted');
    const exhaustedQuattro = fakeQuattro(exhausted);
    const exhaustedAdapter = adapter(exhausted, daemon(exhausted, []));
    await createPlatformServiceManager(
      managerInput(exhausted, exhaustedQuattro.runCommand, exhaustedAdapter),
    ).install();
    const exhaustedContext = context(exhausted, exhaustedQuattro.runCommand);
    await exhaustedAdapter.preflight!(
      exhaustedContext,
      exhaustedAdapter.artifacts(exhaustedContext),
      'uninstall',
    );
    const restoreExhausted = await exhaustedAdapter.prepareDeactivationRollback!(
      exhaustedContext,
      exhaustedAdapter.artifacts(exhaustedContext),
    );
    exhaustedQuattro.state.layout.right.pop();
    exhaustedQuattro.state.enabled = false;
    exhaustedQuattro.state.installed = false;
    exhaustedQuattro.state.ignoredRescans = 100;
    const rescansBeforeExhaustion = exhaustedQuattro.commands.filter(
      ([, arguments_]) => arguments_[0] === 'shell' && arguments_[1] === 'rescanPlugins',
    ).length;
    vi.useFakeTimers();
    const readinessStartedAt = Date.now();
    try {
      const exhaustedResult = expect(restoreExhausted()).rejects.toThrow(/within 5000ms/u);
      await vi.runAllTimersAsync();
      await exhaustedResult;
      expect(Date.now() - readinessStartedAt).toBe(5000);
    } finally {
      vi.useRealTimers();
    }
    expect(
      exhaustedQuattro.commands.filter(
        ([, arguments_]) => arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin',
      ),
    ).toHaveLength(10);
    expect(
      exhaustedQuattro.commands.filter(
        ([, arguments_]) => arguments_[0] === 'shell' && arguments_[1] === 'rescanPlugins',
      ),
    ).toHaveLength(rescansBeforeExhaustion + 11);

    const unverified = fixture('layout-restore-unverified');
    const unverifiedQuattro = fakeQuattro(unverified);
    const unverifiedAdapter = adapter(unverified, daemon(unverified, []));
    await createPlatformServiceManager(
      managerInput(unverified, unverifiedQuattro.runCommand, unverifiedAdapter),
    ).install();
    unverifiedQuattro.state.layout.right.at(-1)!.density = 'compact';
    const unverifiedContext = context(unverified, unverifiedQuattro.runCommand);
    await unverifiedAdapter.preflight!(
      unverifiedContext,
      unverifiedAdapter.artifacts(unverifiedContext),
      'uninstall',
    );
    const restoreUnverified = await unverifiedAdapter.prepareDeactivationRollback!(
      unverifiedContext,
      unverifiedAdapter.artifacts(unverifiedContext),
    );
    unverifiedQuattro.state.layout.right.pop();
    unverifiedQuattro.state.enabled = false;
    unverifiedQuattro.state.ignoreWidgetSettings = true;
    await expect(restoreUnverified()).rejects.toThrow(/did not restore the exact/u);

    for (const stdout of ['setting denied', '']) {
      const settingFailure = fixture(`layout-setting-ipc-${stdout || 'empty'}`);
      const settingQuattro = fakeQuattro(settingFailure);
      const settingAdapter = adapter(settingFailure, daemon(settingFailure, []));
      await createPlatformServiceManager(
        managerInput(settingFailure, settingQuattro.runCommand, settingAdapter),
      ).install();
      settingQuattro.state.layout.right.at(-1)!.density = 'compact';
      const settingContext = context(settingFailure, settingQuattro.runCommand);
      await settingAdapter.preflight!(
        settingContext,
        settingAdapter.artifacts(settingContext),
        'uninstall',
      );
      const restoreSetting = await settingAdapter.prepareDeactivationRollback!(
        settingContext,
        settingAdapter.artifacts(settingContext),
      );
      settingQuattro.state.layout.right.pop();
      settingQuattro.state.enabled = false;
      const original = settingQuattro.runCommand.getMockImplementation()!;
      settingQuattro.runCommand.mockImplementation(async (executable, arguments_) =>
        arguments_[0] === 'shell' && arguments_[1] === 'setBarWidget'
          ? ok(stdout)
          : original(executable, arguments_),
      );
      await expect(restoreSetting()).rejects.toThrow(/widget setting density returned/u);
    }

    const inconsistent = fixture('layout-restore-inconsistent');
    const inconsistentQuattro = fakeQuattro(inconsistent);
    const inconsistentAdapter = adapter(inconsistent, daemon(inconsistent, []));
    await createPlatformServiceManager(
      managerInput(inconsistent, inconsistentQuattro.runCommand, inconsistentAdapter),
    ).install();
    inconsistentQuattro.state.layout.right.pop();
    const inconsistentContext = context(inconsistent, inconsistentQuattro.runCommand);
    await inconsistentAdapter.preflight!(
      inconsistentContext,
      inconsistentAdapter.artifacts(inconsistentContext),
      'uninstall',
    );
    await expect(
      inconsistentAdapter.prepareDeactivationRollback!(
        inconsistentContext,
        inconsistentAdapter.artifacts(inconsistentContext),
      ),
    ).rejects.toThrow(/state and Pimpampum bar layout are inconsistent/u);
  });

  it('covers daemon activation rollback fallbacks and activation failure cleanup', async () => {
    for (const variant of ['rollback-hook', 'running-fallback', 'activation-failure'] as const) {
      const root = fixture(`daemon-activation-${variant}`);
      const quattro = fakeQuattro(root);
      let running = true;
      let activations = 0;
      let rollbacks = 0;
      const daemonAdapter: PlatformServiceAdapter = {
        id: `daemon-${variant}`,
        platform: 'linux',
        artifacts: () => [{ path: root.unit, content: 'unit', mode: 0o600 }],
        async activate() {
          activations += 1;
          if (variant === 'activation-failure') throw new Error('daemon activation failed');
          running = true;
        },
        ...(variant === 'rollback-hook'
          ? {
              async rollbackActivation() {
                rollbacks += 1;
                running = true;
              },
            }
          : {}),
        async deactivate() {
          running = false;
        },
        async isRunning() {
          return running;
        },
      };
      const composite = adapter(root, daemonAdapter);
      const original = quattro.runCommand.getMockImplementation()!;
      quattro.runCommand.mockImplementation(async (executable, arguments_) => {
        if (
          variant !== 'activation-failure' &&
          arguments_[0] === 'plugin' &&
          arguments_[1] === 'validate' &&
          arguments_[2] === root.target
        ) {
          return { exitCode: 76, stdout: '', stderr: 'plugin activation failed' };
        }
        return original(executable, arguments_);
      });

      await expect(
        createPlatformServiceManager(managerInput(root, quattro.runCommand, composite)).install(),
      ).rejects.toThrow(
        variant === 'activation-failure'
          ? /daemon activation failed/u
          : /plugin activation failed/u,
      );
      expect(existsSync(root.target)).toBe(false);
      if (variant === 'rollback-hook') expect(rollbacks).toBe(1);
      if (variant === 'running-fallback') expect(activations).toBe(2);
    }
  });

  it('rejects incompatible runtimes, invalid plugin lists and unowned destinations before writes', async () => {
    for (const variant of [
      'version',
      'json',
      'shape',
      'entry-shape',
      'enabled',
      'unowned',
      'target-file',
      'marker-json',
      'marker-owner',
      'empty-version',
    ] as const) {
      const root = fixture(`reject-${variant}`);
      const quattro = fakeQuattro(root);
      if (variant === 'version') {
        quattro.runCommand.mockResolvedValueOnce(ok('Omarchy 3.9.2'));
      } else if (variant === 'empty-version') {
        quattro.runCommand.mockResolvedValueOnce(ok(''));
      } else if (variant === 'json') {
        quattro.state.invalidList = 'not json';
      } else if (variant === 'shape') {
        quattro.state.invalidList = '{}';
      } else if (variant === 'entry-shape') {
        quattro.state.invalidList = '[1]';
      } else if (variant === 'enabled') {
        quattro.state.invalidList = JSON.stringify([{ id: OMARCHY_PLUGIN_ID }]);
      } else if (variant === 'unowned') {
        mkdirSync(root.target, { recursive: true });
        writeFileSync(join(root.target, 'personal-file'), 'mine');
      } else if (variant === 'target-file') {
        mkdirSync(join(root.target, '..'), { recursive: true });
        writeFileSync(root.target, 'not a directory');
      } else if (variant === 'marker-json') {
        mkdirSync(root.target, { recursive: true });
        writeFileSync(join(root.target, '.pimpampum-plugin-owner.json'), 'not json');
      } else if (variant === 'marker-owner') {
        mkdirSync(root.target, { recursive: true });
        writeFileSync(
          join(root.target, '.pimpampum-plugin-owner.json'),
          JSON.stringify({ schemaVersion: 1, owner: 'someone-else', pluginId: OMARCHY_PLUGIN_ID }),
        );
      }
      const composite = adapter(root, daemon(root, []));
      const install = createPlatformServiceManager(
        managerInput(root, quattro.runCommand, composite),
      ).install();
      await expect(install).rejects.toThrow();
      expect(existsSync(join(root.data, 'install-receipt.json'))).toBe(false);
      if (variant === 'unowned') {
        expect(readFileSync(join(root.target, 'personal-file'), 'utf8')).toBe('mine');
      }
    }
  });

  it('accepts the wrapped list shape and reports disabled and missing plugin states', async () => {
    const root = fixture('list-shapes');
    const quattro = fakeQuattro(root);
    quattro.state.invalidList = JSON.stringify({ plugins: [] });
    const composite = adapter(root, daemon(root, []));
    const ctx = context(root, quattro.runCommand);
    await composite.preflight!(ctx, composite.artifacts(ctx), 'install');
    quattro.state.invalidList = JSON.stringify({
      plugins: [{ id: OMARCHY_PLUGIN_ID, enabled: false }],
    });
    await expect(composite.integrationStatus!(ctx, [])).resolves.toEqual({
      omarchyPlugin: 'disabled',
    });
    quattro.state.invalidList = JSON.stringify({ plugins: [] });
    await expect(composite.integrationStatus!(ctx, [])).resolves.toEqual({
      omarchyPlugin: 'missing',
    });
  });

  it('covers direct hook guards, fallback rollback and aggregated compensation failures', async () => {
    const missing = fixture('missing-preflight');
    const missingQuattro = fakeQuattro(missing);
    const missingAdapter = adapter(missing, daemon(missing, []));
    await expect(
      missingAdapter.activate!(context(missing, missingQuattro.runCommand), []),
    ).rejects.toThrow(/completed preflight/u);
    await missingAdapter.afterRollback!(context(missing, missingQuattro.runCommand), []);
    const noStateRestore = await missingAdapter.prepareDeactivationRollback!(
      context(missing, missingQuattro.runCommand),
      [],
    );
    await noStateRestore();

    const fallback = fixture('fallback-hooks');
    const fallbackQuattro = fakeQuattro(fallback);
    let daemonRunning = false;
    let fallbackActivations = 0;
    const fallbackDaemon: PlatformServiceAdapter = {
      id: 'fallback-daemon',
      platform: 'linux',
      artifacts: () => [{ path: fallback.unit, content: 'unit', mode: 0o600 }],
      async activate() {
        daemonRunning = true;
        fallbackActivations += 1;
      },
      async deactivate() {
        daemonRunning = false;
      },
      async isRunning() {
        return daemonRunning;
      },
    };
    const fallbackAdapter = adapter(fallback, fallbackDaemon);
    const fallbackContext = context(fallback, fallbackQuattro.runCommand);
    await createPlatformServiceManager(
      managerInput(fallback, fallbackQuattro.runCommand, fallbackAdapter),
    ).install();
    fallbackQuattro.state.installed = true;
    fallbackQuattro.state.enabled = true;
    await fallbackAdapter.preflight!(
      fallbackContext,
      fallbackAdapter.artifacts(fallbackContext),
      'uninstall',
    );
    const restore = await fallbackAdapter.prepareDeactivationRollback!(
      fallbackContext,
      fallbackAdapter.artifacts(fallbackContext),
    );
    await fallbackDaemon.deactivate(fallbackContext, []);
    fallbackQuattro.state.enabled = false;
    for (const entries of Object.values(fallbackQuattro.state.layout)) {
      const index = entries.findIndex((entry) => entry.id === OMARCHY_PLUGIN_ID);
      if (index >= 0) entries.splice(index, 1);
    }
    await restore();
    expect(fallbackQuattro.state.enabled).toBe(true);
    expect(fallbackActivations).toBe(2);

    await fallbackDaemon.deactivate(fallbackContext, []);
    const stoppedRestore = await fallbackAdapter.prepareDeactivationRollback!(
      fallbackContext,
      fallbackAdapter.artifacts(fallbackContext),
    );
    await stoppedRestore();
    expect(fallbackActivations).toBe(2);

    fallbackQuattro.state.fail = 'shell rescanPlugins';
    await expect(
      fallbackAdapter.rollbackActivation!(
        fallbackContext,
        fallbackAdapter.artifacts(fallbackContext),
      ),
    ).rejects.toThrow(/rescanPlugins/u);

    const aggregate = fixture('aggregate-compensation');
    const aggregateQuattro = fakeQuattro(aggregate);
    const original = aggregateQuattro.runCommand.getMockImplementation()!;
    let rescans = 0;
    aggregateQuattro.runCommand.mockImplementation(async (executable, arguments_) => {
      if (arguments_.join(' ') === 'shell rescanPlugins') {
        rescans += 1;
        if (rescans >= 1) return { exitCode: 73, stdout: '', stderr: 'rescan failed' };
      }
      return original(executable, arguments_);
    });
    const aggregateDaemon: PlatformServiceAdapter = {
      id: 'aggregate-daemon',
      platform: 'linux',
      artifacts: () => [{ path: aggregate.unit, content: 'unit', mode: 0o600 }],
      activate: async () => undefined,
      deactivate: async () => {
        throw 'raw daemon failure';
      },
      isRunning: async () => false,
    };
    await expect(
      createPlatformServiceManager(
        managerInput(aggregate, aggregateQuattro.runCommand, adapter(aggregate, aggregateDaemon)),
      ).install(),
    ).rejects.toThrow(AggregateError);
  });

  it('exercises enabled reinstall, changed-enable compensation and daemon rollback hooks', async () => {
    const root = fixture('direct-rollbacks');
    mkdirSync(join(root.source, '.git'));
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const ctx = context(root, quattro.runCommand);
    const artifacts = composite.artifacts(ctx);
    expect(artifacts.some((artifact) => artifact.path.includes('/.git/'))).toBe(false);
    await createPlatformServiceManager(managerInput(root, quattro.runCommand, composite)).install();
    quattro.state.installed = true;
    quattro.state.enabled = true;

    await composite.rollbackActivation!(ctx, artifacts);
    expect(quattro.state.enabled).toBe(false);
    expect(events).toContain('daemon-deactivate');

    const original = quattro.runCommand.getMockImplementation()!;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      if (
        arguments_[0] === 'plugin' &&
        arguments_[1] === 'validate' &&
        arguments_[2] === root.target
      ) {
        return { exitCode: 74, stdout: '', stderr: 'candidate failure' };
      }
      return original(executable, arguments_);
    });
    await expect(composite.activate(ctx, artifacts)).rejects.toThrow(/candidate failure/u);
    quattro.runCommand.mockImplementation(original);

    quattro.state.installed = true;
    quattro.state.enabled = true;
    await composite.preflight!(ctx, artifacts, 'install');
    await composite.activate(ctx, artifacts);
    expect(quattro.state.enabled).toBe(true);

    writeFileSync(join(root.target, 'keep-directory-nonempty'), 'sentinel');
    await composite.afterUninstall!(ctx, artifacts);
    expect(existsSync(root.target)).toBe(true);
    rmSync(join(root.target, 'keep-directory-nonempty'));
  });

  it('rejects unsafe options, source symlinks and special source files', () => {
    const root = fixture('validation');
    const quattro = fakeQuattro(root);
    const linuxDaemon = daemon(root, []);
    const input = {
      pluginSourcePath: root.source,
      daemonAdapter: linuxDaemon,
      omarchyPath: '/usr/bin/omarchy',
      omarchyShellPath: '/usr/bin/omarchy-shell',
    };
    expect(() => createOmarchyAdapter({ ...input, pluginSourcePath: 'relative' })).toThrow(
      /absolute/u,
    );
    expect(() =>
      createOmarchyAdapter({ ...input, pluginSourcePath: join(root.root, 'missing') }),
    ).toThrow(/existing directory/u);
    expect(() => createOmarchyAdapter({ ...input, omarchyPath: 'omarchy' })).toThrow(/absolute/u);
    expect(() => createOmarchyAdapter({ ...input, omarchyShellPath: 'omarchy-shell' })).toThrow(
      /absolute/u,
    );
    expect(() =>
      createOmarchyAdapter({
        ...input,
        daemonAdapter: { ...linuxDaemon, platform: 'darwin' },
      }),
    ).toThrow(/Linux/u);
    expect(() =>
      adapter(root, linuxDaemon).artifacts({
        ...context(root, quattro.runCommand),
        dataDirectory: `${root.data}\nunsafe`,
      }),
    ).toThrow(/line breaks/u);

    symlinkSync('/tmp', join(root.source, 'unsafe-link'));
    expect(() => adapter(root, linuxDaemon).artifacts(context(root, quattro.runCommand))).toThrow(
      /symlink/u,
    );
    rmSync(join(root.source, 'unsafe-link'));
    const fifo = join(root.source, 'unsafe-fifo');
    execFileSync('/usr/bin/mkfifo', [fifo]);
    expect(() => adapter(root, linuxDaemon).artifacts(context(root, quattro.runCommand))).toThrow(
      /non-regular/u,
    );
  });
});
