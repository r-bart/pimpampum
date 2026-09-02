import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isolatedGitEnvironment, runGitQuiet } from './helpers/git.js';
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
const omarchyFixtureRoot = join(process.cwd(), 'test', 'fixtures', 'omarchy');
// One pristine copy of the plugin tree per file; every fixture copies from it instead of walking
// the repository checkout again.
let cachedPluginRoot: string;
let cachedPlugin: string;

beforeAll(() => {
  cachedPluginRoot = mkdtempSync(join(tmpdir(), 'pimpampum-omarchy-plugin-cache-'));
  cachedPlugin = join(cachedPluginRoot, 'pimpampum-status');
  cpSync(repositoryPlugin, cachedPlugin, { recursive: true });
});

afterAll(() => {
  rmSync(cachedPluginRoot, { recursive: true, force: true });
});

// Recorded stdout of the `omarchy` and `omarchy-shell` commands (test/fixtures/omarchy/README.md
// lists the capture commands). A command without a fixture fails here instead of being answered
// with a shape the test author invented.
function omarchyFixture(name: string): string {
  const path = join(omarchyFixtureRoot, name);
  if (!existsSync(path)) {
    throw new Error(
      `Missing Omarchy fixture ${relative(process.cwd(), path)}; capture it as test/fixtures/omarchy/README.md describes`,
    );
  }
  return readFileSync(path, 'utf8');
}

function omarchyFixtureName(arguments_: readonly string[]): string {
  const key = arguments_.join(' ');
  if (key === 'version' || key === '--version') return 'version.txt';
  if (key === 'shell ping') return 'shell-ping.txt';
  if (key === 'shell rescanPlugins') return 'shell-rescanPlugins.txt';
  if (key === 'shell listShellConfig') return 'shell-listShellConfig.json';
  if (arguments_[0] === 'shell' && arguments_[1] === 'setPluginEnabled') {
    return 'shell-setPluginEnabled.txt';
  }
  if (arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin')
    return 'shell-enablePlugin.txt';
  if (arguments_[0] === 'shell' && arguments_[1] === 'setBarWidget')
    return 'shell-setBarWidget.txt';
  if (key === 'plugin list --json') return 'plugin-list.json';
  if (key === 'plugin enable --help') return 'plugin-enable-help.txt';
  if (key === 'plugin remove --help') return 'plugin-remove-help.txt';
  if (arguments_[0] === 'plugin' && arguments_[1] === 'validate') return 'plugin-validate.txt';
  if (key === `plugin enable ${OMARCHY_PLUGIN_ID}`) return 'plugin-enable.txt';
  if (key === `plugin disable ${OMARCHY_PLUGIN_ID}`) return 'plugin-disable.txt';
  if (key === `plugin remove ${OMARCHY_PLUGIN_ID} --yes`) return 'plugin-remove.txt';
  throw new Error(`Unexpected command: omarchy ${key}`);
}

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
  cpSync(cachedPlugin, source, { recursive: true });
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
  // The recorded list keeps its key set and order; only the simulated flags change.
  const pluginList = (): string => {
    if (!state.installed) return omarchyFixture('plugin-list-empty.json');
    const recorded = JSON.parse(omarchyFixture('plugin-list.json')) as Array<
      Record<string, unknown>
    >;
    return JSON.stringify(
      recorded.map((entry) =>
        entry.id === OMARCHY_PLUGIN_ID
          ? { ...entry, enabled: state.enabled, active: state.enabled }
          : entry,
      ),
    );
  };
  const shellConfig = (): string => {
    const recorded = JSON.parse(omarchyFixture('shell-listShellConfig.json')) as {
      bar: Record<string, unknown>;
    };
    return JSON.stringify({ ...recorded, bar: { ...recorded.bar, layout: state.layout } });
  };
  const runCommand = vi.fn<RunCommand>(async (executable, arguments_) => {
    commands.push([executable, [...arguments_]]);
    const key = arguments_.join(' ');
    // Throws for a command without a recorded fixture, before any branch below answers it.
    omarchyFixture(omarchyFixtureName(arguments_));
    if (key === `plugin remove ${OMARCHY_PLUGIN_ID} --yes`) {
      const backup = join(
        dirname(root.target),
        `.${OMARCHY_PLUGIN_ID}.bak.20260826000000-${backups.length + 1}`,
      );
      renameSync(root.target, backup);
      backups.push(backup);
      state.installed = false;
      removeWidget();
      const stdout = omarchyFixture('plugin-remove.txt').replace('{BACKUP_PATH}', backup);
      return state.fail === key
        ? { exitCode: 72, stdout, stderr: 'simulated rescan failure' }
        : ok(stdout);
    }
    if (state.fail === key) return { exitCode: 72, stdout: '', stderr: 'simulated failure' };
    if (key === 'version' || key === '--version') return ok(omarchyFixture('version.txt'));
    if (key === 'shell ping') return ok(omarchyFixture('shell-ping.txt'));
    if (key === 'shell rescanPlugins') {
      if (state.ignoredRescans > 0) {
        state.ignoredRescans -= 1;
        return ok(omarchyFixture('shell-rescanPlugins.txt'));
      }
      state.installed = existsSync(root.target) && state.enableReadinessResponses.length === 0;
      if (!state.installed) state.enabled = false;
      return ok(omarchyFixture('shell-rescanPlugins.txt'));
    }
    if (key === 'shell listShellConfig') {
      if (state.invalidShellConfig !== null) return ok(state.invalidShellConfig);
      return ok(shellConfig());
    }
    if (arguments_[0] === 'shell' && arguments_[1] === 'setPluginEnabled') {
      if (arguments_[2] !== OMARCHY_PLUGIN_ID || arguments_[3] !== 'false') {
        return ok(omarchyFixture('shell-unknown.txt'));
      }
      removeWidget();
      return ok(omarchyFixture('shell-setPluginEnabled.txt'));
    }
    if (arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin') {
      const readinessResponse = state.enableReadinessResponses.shift();
      if (readinessResponse !== undefined) {
        return ok(readinessResponse);
      }
      if (arguments_[2] !== OMARCHY_PLUGIN_ID || !state.installed) {
        return ok(omarchyFixture('shell-unknown.txt'));
      }
      removeWidget();
      const placement = JSON.parse(arguments_[3] ?? '{}') as { section?: unknown; index?: unknown };
      const section = ['left', 'center', 'right'].includes(String(placement.section))
        ? (placement.section as 'left' | 'center' | 'right')
        : 'right';
      const requested = typeof placement.index === 'number' ? Math.floor(placement.index) : 0;
      const index = Math.max(0, Math.min(requested, state.layout[section].length));
      state.layout[section].splice(index, 0, { id: OMARCHY_PLUGIN_ID });
      state.enabled = true;
      return ok(omarchyFixture('shell-enablePlugin.txt'));
    }
    if (arguments_[0] === 'shell' && arguments_[1] === 'setBarWidget') {
      const selector = JSON.parse(arguments_[5] ?? '{}') as { section?: unknown; index?: unknown };
      const section = selector.section as 'left' | 'center' | 'right';
      const index = selector.index as number;
      const entry = state.layout[section]?.[index];
      if (!entry || entry.id !== arguments_[2]) return ok(omarchyFixture('shell-unknown.txt'));
      if (state.ignoreWidgetSettings) return ok(omarchyFixture('shell-setBarWidget.txt'));
      entry[arguments_[3]!] = JSON.parse(arguments_[4]!) as unknown;
      return ok(omarchyFixture('shell-setBarWidget.txt'));
    }
    if (key === 'plugin list --json') {
      if (state.invalidList !== null) return ok(state.invalidList);
      return ok(pluginList());
    }
    if (key === 'plugin enable --help') return ok(omarchyFixture('plugin-enable-help.txt'));
    if (key === 'plugin remove --help') return ok(omarchyFixture('plugin-remove-help.txt'));
    if (arguments_[0] === 'plugin' && arguments_[1] === 'validate') {
      if (!existsSync(arguments_[2]!)) return { exitCode: 2, stdout: '', stderr: 'missing' };
      return ok(omarchyFixture('plugin-validate.txt'));
    }
    if (key === `plugin enable ${OMARCHY_PLUGIN_ID}`) {
      state.installed = existsSync(root.target);
      state.enabled = state.installed;
      if (state.enabled && !widgetLocation()) {
        state.layout.right.push({ id: OMARCHY_PLUGIN_ID });
      }
      return state.installed
        ? ok(omarchyFixture('plugin-enable.txt'))
        : { exitCode: 3, stdout: '', stderr: 'unknown' };
    }
    if (key === `plugin disable ${OMARCHY_PLUGIN_ID}`) {
      removeWidget();
      return ok(omarchyFixture('plugin-disable.txt'));
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

// Every test below drives a real install or uninstall lifecycle: 35 plugin artifacts written
// atomically and fsynced, plus a `git clone` in the checkout cases. Measured on an idle machine the
// heaviest cases run 2.4-4.0 s, which leaves no headroom under the default 5 s once vitest runs the
// suite's files in parallel; the test that times out then moves from run to run. The budget is the
// one the subprocess case in this file already carried, not a mask over a regression: the file's
// wall time fell from 53 s to 46 s across this wave.
describe('Omarchy Quattro composite service adapter', { timeout: 20_000 }, () => {
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
    const controlDirectory = join(root.home, '.local', 'share', 'pimpampum', 'bin');
    const controlLauncher = join(controlDirectory, 'pimpampum-control');
    const runtimeDirectory = join(root.home, '.pimpampum');
    const runtimeReceipt = join(runtimeDirectory, 'runtime-install-receipt.json');
    mkdirSync(controlDirectory, { recursive: true });
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(
      controlLauncher,
      `#!/bin/sh
export PIMPAMPUM_DATA_DIR=${shellQuote(root.data)}
export PIMPAMPUM_HOST='127.0.0.1'
export PIMPAMPUM_PORT='7337'
exec ${shellQuote(process.execPath)} ${shellQuote(cliPath)} "$@"
`,
    );
    chmodSync(controlLauncher, 0o755);
    const controlLauncherSha256 = createHash('sha256')
      .update(readFileSync(controlLauncher))
      .digest('hex');
    writeFileSync(
      runtimeReceipt,
      `${JSON.stringify({ controlLauncherPath: controlLauncher, controlLauncherSha256 }, null, 2)}\n`,
    );
    chmodSync(runtimeReceipt, 0o600);
    await createPlatformServiceManager(input).install();

    const helper = join(root.target, 'pimpampum-overview');
    execFileSync(helper, [], {
      env: {
        ...process.env,
        HOME: root.home,
        HELPER_OUTPUT: outputPath,
        PATH: join(root.root, 'attacker-path'),
        PIMPAMPUM_CLI: join(root.root, 'attacker-cli'),
        PIMPAMPUM_DATA_DIR: '/wrong/data/directory',
      },
    });
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual({
      dataDirectory: root.data,
      host: '127.0.0.1',
      port: '7337',
      arguments: ['overview'],
    });
    expect(readFileSync(helper)).toEqual(readFileSync(join(root.source, 'pimpampum-overview')));
    const route = readFileSync(join(root.target, 'pimpampum-control-route'), 'utf8');
    const common = readFileSync(join(root.target, 'pimpampum-common.sh'), 'utf8');
    expect(`${route}\n${common}`).not.toContain(process.execPath);
    expect(route).toContain('verify_control_launcher 69');
    expect(common).toContain('controlLauncherSha256');
    expect(route).toContain('exec "$control_launcher" "$@"');

    const backupHelper = join(root.target, 'pimpampum-backup');
    const backupDirectory = join(root.root, "Dropbox ü ; $(touch nope) 'quoted'");
    execFileSync(backupHelper, ['configure', backupDirectory], {
      env: {
        ...process.env,
        HOME: root.home,
        HELPER_OUTPUT: outputPath,
        PATH: join(root.root, 'attacker-path'),
        PIMPAMPUM_CLI: join(root.root, 'attacker-cli'),
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
    expect(readFileSync(backupHelper)).toEqual(readFileSync(join(root.source, 'pimpampum-backup')));

    writeFileSync(controlLauncher, `${readFileSync(controlLauncher, 'utf8')}# tampered\n`);
    chmodSync(controlLauncher, 0o755);
    // Both streams are captured: the refusal must reach this assertion, not the vitest output.
    const refused = spawnSync(helper, [], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, HOME: root.home, HELPER_OUTPUT: outputPath },
    });
    expect(refused.status).toBe(69);
    expect(refused.stdout).toBe('');
    expect(refused.stderr.trim()).toBe(
      'pimpampum-control-route: control launcher differs from its runtime receipt',
    );
  });

  it('keeps an official Git checkout clean across install, fast-forward, reconcile, and removal', async () => {
    const root = fixture('git-checkout-reconcile');
    const git = isolatedGitEnvironment(root.root);
    runGitQuiet(['init', '--quiet', '--initial-branch=main'], root.source, git);
    runGitQuiet(['add', '.'], root.source, git);
    runGitQuiet(['commit', '--quiet', '-m', 'initial plugin'], root.source, git);
    mkdirSync(dirname(root.target), { recursive: true });
    runGitQuiet(['clone', '--quiet', root.source, root.target], root.root, git);

    const quattro = fakeQuattro(root);
    quattro.state.installed = true;
    quattro.state.enabled = true;
    quattro.state.layout.right.push({ id: OMARCHY_PLUGIN_ID });
    const composite = adapter(root, daemon(root, []));
    const input = managerInput(root, quattro.runCommand, composite);
    await createPlatformServiceManager(input).install();
    expect(runGitQuiet(['status', '--porcelain=v1'], root.target, git)).toBe('');

    writeFileSync(
      join(root.source, 'README.md'),
      `${readFileSync(join(root.source, 'README.md'), 'utf8')}\nFast-forward fixture.\n`,
    );
    runGitQuiet(['add', 'README.md'], root.source, git);
    runGitQuiet(['commit', '--quiet', '-m', 'plugin fast-forward'], root.source, git);
    runGitQuiet(['pull', '--quiet', '--ff-only'], root.target, git);

    await createPlatformServiceManager(input).install();
    expect(runGitQuiet(['status', '--porcelain=v1'], root.target, git)).toBe('');
    await expect(createPlatformServiceManager(input).uninstall()).resolves.toEqual({
      uninstalled: true,
      dataPreserved: true,
    });
    expect(existsSync(root.target)).toBe(false);
    expect(readFileSync(join(root.data, 'token'), 'utf8')).toBe('preserve-me');
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

  it.each(['missing', 'file', 'unsafe', 'absent'] as const)(
    'rejects a %s official backup report safely',
    async (variant) => {
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
    },
  );

  // One case per `it`: every case is a full install and uninstall cycle, and ten of them in one
  // test exceeded the per-test budget on a loaded machine.
  const shellLayoutCases = [
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

  it.each(shellLayoutCases)(
    'rejects a $label shell layout snapshot before removal',
    async (testCase) => {
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
    },
  );

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

  // M-T4: the scenarios below drive the composite adapter through the manager, so every hook runs
  // in the order the product runs it. Each `it` states one invariant about external state.

  /** Installs, then fails the uninstall after the plugin was removed so the manager rolls back. */
  async function failedUninstallAfterRemoval(
    label: string,
    options: {
      prepare?: (quattro: FakeQuattro) => void;
      onCleanup?: (quattro: FakeQuattro) => void;
    } = {},
  ): Promise<{ quattro: FakeQuattro; root: Fixture; error: unknown; events: string[] }> {
    const root = fixture(label);
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const daemonAdapter: PlatformServiceAdapter = {
      ...daemon(root, events),
      async afterUninstall() {
        options.onCleanup?.(quattro);
        throw new Error('daemon cleanup failed');
      },
    };
    const manager = createPlatformServiceManager(
      managerInput(root, quattro.runCommand, adapter(root, daemonAdapter)),
    );
    await manager.install();
    options.prepare?.(quattro);
    const error = await manager.uninstall().catch((caught: unknown) => caught);
    return { quattro, root, error, events };
  }

  function messagesOf(error: unknown): string[] {
    if (error instanceof AggregateError) return error.errors.flatMap(messagesOf);
    return [String((error as Error).message)];
  }

  it('puts the widget back in its original section when a failed uninstall left it elsewhere', async () => {
    const { quattro, error, root } = await failedUninstallAfterRemoval('layout-restore-moved', {
      // The shell re-added the widget at the front of the left section before the rollback ran.
      onCleanup: (state) => {
        state.state.layout.left.unshift({ id: OMARCHY_PLUGIN_ID });
        state.state.enabled = true;
      },
    });
    expect(messagesOf(error)).toEqual(['daemon cleanup failed']);
    expect(quattro.state.layout.left.map((entry) => entry.id)).toEqual(['omarchy.menu']);
    expect(quattro.state.layout.right.at(-1)).toEqual({ id: OMARCHY_PLUGIN_ID });
    expect(existsSync(join(root.target, 'manifest.json'))).toBe(true);
  });

  it('disables a widget that appeared during a failed uninstall of a disabled plugin', async () => {
    const { quattro, error } = await failedUninstallAfterRemoval('layout-restore-disabled', {
      prepare: (state) => {
        // The user had disabled the plugin: no widget in the layout before the uninstall began.
        for (const entries of Object.values(state.state.layout)) {
          const index = entries.findIndex((entry) => entry.id === OMARCHY_PLUGIN_ID);
          if (index >= 0) entries.splice(index, 1);
        }
        state.state.enabled = false;
      },
      onCleanup: (state) => {
        state.state.layout.left.push({ id: OMARCHY_PLUGIN_ID });
        state.state.enabled = true;
      },
    });
    expect(messagesOf(error)).toEqual(['daemon cleanup failed']);
    expect(quattro.state.enabled).toBe(false);
    expect(
      Object.values(quattro.state.layout)
        .flat()
        .some((entry) => entry.id === OMARCHY_PLUGIN_ID),
    ).toBe(false);
  });

  it.each([{ response: 'denied' }, { response: '' }])(
    'reports the placement restore answer $response together with the uninstall failure',
    async ({ response }) => {
      const { error, quattro } = await failedUninstallAfterRemoval(
        `layout-restore-ipc-${response || 'empty'}`,
        {
          onCleanup: (state) => {
            const original = state.runCommand.getMockImplementation()!;
            state.runCommand.mockImplementation(async (executable, arguments_) =>
              arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin'
                ? ok(response)
                : original(executable, arguments_),
            );
          },
        },
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect(messagesOf(error)).toEqual([
        'daemon cleanup failed',
        `omarchy-shell restore Pimpampum widget placement returned ${JSON.stringify(response || 'no result')}`,
      ]);
      expect(quattro.state.enabled).toBe(false);
    },
  );

  it('gives up restoring the widget after five seconds of "unknown" answers with exponential backoff', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    try {
      const outcome = failedUninstallAfterRemoval('layout-restore-readiness-exhausted', {
        // The shell never rediscovers the restored plugin: every rescan is ignored.
        onCleanup: (state) => {
          state.state.ignoredRescans = 100;
        },
      });
      await vi.runAllTimersAsync();
      const { error, quattro } = await outcome;
      expect(Date.now() - startedAt).toBe(5000);
      expect(messagesOf(error)).toEqual([
        'daemon cleanup failed',
        `omarchy-shell did not rediscover ${OMARCHY_PLUGIN_ID} within 5000ms`,
      ]);
      expect(
        quattro.commands.filter(
          ([, arguments_]) => arguments_[0] === 'shell' && arguments_[1] === 'enablePlugin',
        ),
      ).toHaveLength(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a widget setting the shell silently dropped during the rollback', async () => {
    const { error } = await failedUninstallAfterRemoval('layout-restore-unverified', {
      prepare: (state) => {
        state.state.layout.right.at(-1)!.density = 'compact';
      },
      onCleanup: (state) => {
        state.state.ignoreWidgetSettings = true;
      },
    });
    expect(messagesOf(error)).toEqual([
      'daemon cleanup failed',
      'omarchy-shell did not restore the exact Pimpampum bar widget layout',
    ]);
  });

  it.each([{ response: 'setting denied' }, { response: '' }])(
    'reports the widget setting restore answer $response together with the uninstall failure',
    async ({ response }) => {
      const { error } = await failedUninstallAfterRemoval(
        `layout-setting-ipc-${response || 'empty'}`,
        {
          prepare: (state) => {
            state.state.layout.right.at(-1)!.density = 'compact';
          },
          onCleanup: (state) => {
            const original = state.runCommand.getMockImplementation()!;
            state.runCommand.mockImplementation(async (executable, arguments_) =>
              arguments_[0] === 'shell' && arguments_[1] === 'setBarWidget'
                ? ok(response)
                : original(executable, arguments_),
            );
          },
        },
      );
      expect(messagesOf(error)).toEqual([
        'daemon cleanup failed',
        `omarchy-shell restore Pimpampum widget setting density returned ${JSON.stringify(response || 'no result')}`,
      ]);
    },
  );

  it('refuses to uninstall while the plugin is enabled but absent from the bar layout', async () => {
    const root = fixture('layout-restore-inconsistent');
    const quattro = fakeQuattro(root);
    const manager = createPlatformServiceManager(
      managerInput(root, quattro.runCommand, adapter(root, daemon(root, []))),
    );
    await manager.install();
    quattro.state.layout.right.pop();
    await expect(manager.uninstall()).rejects.toThrow(
      'Omarchy plugin state and Pimpampum bar layout are inconsistent',
    );
    expect(existsSync(join(root.target, 'manifest.json'))).toBe(true);
    expect(quattro.backups).toEqual([]);
  });

  it('re-enables the plugin after a failed upgrade whose validation disabled it', async () => {
    const root = fixture('upgrade-restores-enabled');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const input = managerInput(root, quattro.runCommand, composite);
    await createPlatformServiceManager(input).install();
    expect(quattro.state.enabled).toBe(true);

    const original = quattro.runCommand.getMockImplementation()!;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      if (
        arguments_[0] === 'plugin' &&
        arguments_[1] === 'validate' &&
        arguments_[2] === root.target
      ) {
        // The shell dropped the plugin while rejecting the candidate.
        quattro.state.enabled = false;
        return { exitCode: 74, stdout: '', stderr: 'candidate failure' };
      }
      return original(executable, arguments_);
    });
    await expect(
      createPlatformServiceManager({ ...input, version: '2.0.0' }).install(),
    ).rejects.toThrow(/candidate failure/u);
    expect(quattro.state.enabled).toBe(true);
    expect(existsSync(join(root.target, 'manifest.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root.data, 'install-receipt.json'), 'utf8'))).toMatchObject(
      { version: '1.0.0' },
    );
  });

  it('keeps an already enabled plugin enabled across a repeat install without re-enabling it', async () => {
    const root = fixture('repeat-install-enabled');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    const input = managerInput(root, quattro.runCommand, composite);
    await createPlatformServiceManager(input).install();
    const enablesAfterFirstInstall = quattro.commands.filter(
      ([, arguments_]) => arguments_.join(' ') === `plugin enable ${OMARCHY_PLUGIN_ID}`,
    ).length;
    expect(enablesAfterFirstInstall).toBe(1);

    await expect(
      createPlatformServiceManager({ ...input, version: '2.0.0' }).install(),
    ).resolves.toMatchObject({ installed: true, reconciled: true, omarchyPlugin: 'enabled' });
    expect(quattro.state.enabled).toBe(true);
    expect(
      quattro.commands.filter(
        ([, arguments_]) => arguments_.join(' ') === `plugin enable ${OMARCHY_PLUGIN_ID}`,
      ),
    ).toHaveLength(1);
  });

  it('restarts a daemon without rollback hooks when the uninstall fails after stopping it', async () => {
    const root = fixture('fallback-daemon-restart');
    const quattro = fakeQuattro(root);
    let running = false;
    let activations = 0;
    const plainDaemon: PlatformServiceAdapter = {
      id: 'fallback-daemon',
      platform: 'linux',
      artifacts: () => [{ path: root.unit, content: 'unit', mode: 0o600 }],
      async activate() {
        running = true;
        activations += 1;
      },
      async deactivate() {
        running = false;
      },
      async isRunning() {
        return running;
      },
      async afterUninstall() {
        throw new Error('daemon cleanup failed');
      },
    };
    const manager = createPlatformServiceManager(
      managerInput(root, quattro.runCommand, adapter(root, plainDaemon)),
    );
    await manager.install();
    expect(activations).toBe(1);
    await expect(manager.uninstall()).rejects.toThrow('daemon cleanup failed');
    expect(running).toBe(true);
    expect(activations).toBe(2);
    expect(quattro.state.enabled).toBe(true);
  });

  it('leaves a daemon without rollback hooks stopped when it was not running before the uninstall', async () => {
    const root = fixture('fallback-daemon-stopped');
    const quattro = fakeQuattro(root);
    let running = false;
    let activations = 0;
    const plainDaemon: PlatformServiceAdapter = {
      id: 'fallback-daemon',
      platform: 'linux',
      artifacts: () => [{ path: root.unit, content: 'unit', mode: 0o600 }],
      async activate() {
        running = true;
        activations += 1;
      },
      async deactivate() {
        running = false;
      },
      async isRunning() {
        return running;
      },
      async afterUninstall() {
        throw new Error('daemon cleanup failed');
      },
    };
    const manager = createPlatformServiceManager(
      managerInput(root, quattro.runCommand, adapter(root, plainDaemon)),
    );
    await manager.install();
    running = false;
    await expect(manager.uninstall()).rejects.toThrow('daemon cleanup failed');
    expect(running).toBe(false);
    expect(activations).toBe(1);
  });

  it('rolls activation back and reports a rescan failure when the install cannot read the plugin state', async () => {
    const root = fixture('rollback-activation-rescan-failure');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const original = quattro.runCommand.getMockImplementation()!;
    let activated = false;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      const key = arguments_.join(' ');
      if (key === `plugin enable ${OMARCHY_PLUGIN_ID}`) activated = true;
      // After activation the plugin list breaks (afterInstall fails) and so does the rescan the
      // rollback issues; the manager must report both and still stop the daemon.
      if (activated && key === 'plugin list --json') {
        return { exitCode: 75, stdout: '', stderr: 'list broken' };
      }
      if (activated && key === 'shell rescanPlugins') {
        return { exitCode: 73, stdout: '', stderr: 'rescan failed' };
      }
      return original(executable, arguments_);
    });
    const error = await createPlatformServiceManager(
      managerInput(root, quattro.runCommand, composite),
    )
      .install()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    // The list failure, the rescan the activation rollback issues, and the rescan the artifact
    // rollback issues while restoring the prior plugin state.
    expect(messagesOf(error)).toEqual([
      expect.stringContaining('list broken'),
      expect.stringContaining('rescan failed'),
      expect.stringContaining('rescan failed'),
    ]);
    expect(events).toContain('daemon-deactivate');
    expect(quattro.state.enabled).toBe(false);
    expect(existsSync(root.target)).toBe(false);
  });

  it('keeps an already enabled plugin enabled when an upgrade fails after activation and rolls back', async () => {
    const root = fixture('rollback-activation-already-enabled');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const input = managerInput(root, quattro.runCommand, composite);
    await createPlatformServiceManager(input).install();
    expect(quattro.state.enabled).toBe(true);
    events.length = 0;

    // The plugin is already enabled, so the upgrade activation changes nothing about it; the
    // plugin list then breaks, the manager rolls the activation back, and the rollback must not
    // disable a plugin the activation never enabled.
    const original = quattro.runCommand.getMockImplementation()!;
    let upgradeActivated = false;
    let listBroken = false;
    quattro.runCommand.mockImplementation(async (executable, arguments_) => {
      const key = arguments_.join(' ');
      if (
        arguments_[0] === 'plugin' &&
        arguments_[1] === 'validate' &&
        arguments_[2] === root.target
      ) {
        upgradeActivated = true;
      }
      // Only the read that finalizes the install breaks; the rollback reads the list again.
      if (upgradeActivated && !listBroken && key === 'plugin list --json') {
        listBroken = true;
        return { exitCode: 75, stdout: '', stderr: 'list broken' };
      }
      return original(executable, arguments_);
    });
    await expect(
      createPlatformServiceManager({ ...input, version: '2.0.0' }).install(),
    ).rejects.toThrow('omarchy plugin list failed with exit code 75; stderr="list broken"');

    expect(quattro.state.enabled).toBe(true);
    expect(
      quattro.commands.filter(
        ([, arguments_]) => arguments_.join(' ') === `plugin disable ${OMARCHY_PLUGIN_ID}`,
      ),
    ).toEqual([]);
    expect(events.slice(events.indexOf('daemon-activate'))).toEqual([
      'daemon-activate',
      'daemon-deactivate',
      'daemon-restore-deactivation',
      'daemon-after-rollback',
    ]);
    expect(JSON.parse(readFileSync(join(root.data, 'install-receipt.json'), 'utf8'))).toMatchObject(
      { version: '1.0.0' },
    );
    expect(existsSync(join(root.target, 'manifest.json'))).toBe(true);
  });

  it('aggregates an activation failure with a failed compensation', async () => {
    const aggregate = fixture('aggregate-compensation');
    const aggregateQuattro = fakeQuattro(aggregate);
    const original = aggregateQuattro.runCommand.getMockImplementation()!;
    aggregateQuattro.runCommand.mockImplementation(async (executable, arguments_) => {
      if (arguments_.join(' ') === 'shell rescanPlugins') {
        return { exitCode: 73, stdout: '', stderr: 'rescan failed' };
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
    const error = await createPlatformServiceManager(
      managerInput(aggregate, aggregateQuattro.runCommand, adapter(aggregate, aggregateDaemon)),
    )
      .install()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(messagesOf(error)).toEqual(
      expect.arrayContaining([expect.stringContaining('rescan failed'), 'raw daemon failure']),
    );
  });

  it('disables the plugin again when a second activation on one adapter fails after the first enabled it', async () => {
    // Only a stale lifecycle reaches this compensation: the manager re-runs `preflight` before
    // every activation, which resets `enableChanged`. Handoff: drop the branch or `v8 ignore` it in
    // src/service/omarchy.ts and delete this test.
    const root = fixture('stale-lifecycle-compensation');
    const quattro = fakeQuattro(root);
    const events: string[] = [];
    const composite = adapter(root, daemon(root, events));
    const ctx = context(root, quattro.runCommand);
    await createPlatformServiceManager(managerInput(root, quattro.runCommand, composite)).install();
    expect(quattro.state.enabled).toBe(true);
    const original = quattro.runCommand.getMockImplementation()!;
    quattro.runCommand.mockImplementation(async (executable, arguments_) =>
      arguments_[0] === 'plugin' && arguments_[1] === 'validate' && arguments_[2] === root.target
        ? { exitCode: 74, stdout: '', stderr: 'candidate failure' }
        : original(executable, arguments_),
    );
    await expect(composite.activate(ctx, composite.artifacts(ctx))).rejects.toThrow(
      /candidate failure/u,
    );
    expect(quattro.state.enabled).toBe(false);
    expect(events.at(-1)).toBe('daemon-deactivate');
  });

  it('never plans a .git directory inside the plugin source as an artifact', () => {
    const root = fixture('git-excluded');
    mkdirSync(join(root.source, '.git'));
    writeFileSync(join(root.source, '.git', 'HEAD'), 'ref: refs/heads/main');
    const composite = adapter(root, daemon(root, []));
    const artifacts = composite.artifacts(context(root, fakeQuattro(root).runCommand));
    expect(artifacts.some((artifact) => artifact.path.includes('/.git/'))).toBe(false);
    expect(artifacts.some((artifact) => artifact.path.endsWith('/manifest.json'))).toBe(true);
  });

  // The manager always runs `preflight` first; these guards exist for a caller that does not.
  it('refuses to activate before preflight ran', async () => {
    const root = fixture('missing-preflight');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    await expect(composite.activate(context(root, quattro.runCommand), [])).rejects.toThrow(
      'Omarchy activation requires a completed preflight',
    );
    expect(quattro.commands).toEqual([]);
  });

  it('afterRollback is a no-op before preflight ran', async () => {
    const root = fixture('missing-preflight-rollback');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    await composite.afterRollback!(context(root, quattro.runCommand), []);
    expect(quattro.commands).toEqual([]);
  });

  it('prepareDeactivationRollback reads the plugin state itself before preflight ran', async () => {
    const root = fixture('missing-preflight-deactivation');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    const restore = await composite.prepareDeactivationRollback!(
      context(root, quattro.runCommand),
      [],
    );
    expect(quattro.commands.map(([, arguments_]) => arguments_.join(' '))).toEqual([
      'plugin list --json',
      'shell listShellConfig',
    ]);
    await restore();
    expect(quattro.state.enabled).toBe(false);
  });

  it('afterUninstall keeps a plugin directory that still holds content', async () => {
    const root = fixture('after-uninstall-nonempty');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    const ctx = context(root, quattro.runCommand);
    mkdirSync(root.target, { recursive: true });
    writeFileSync(join(root.target, 'keep-directory-nonempty'), 'sentinel');
    await composite.afterUninstall!(ctx, composite.artifacts(ctx));
    expect(readFileSync(join(root.target, 'keep-directory-nonempty'), 'utf8')).toBe('sentinel');
  });

  it('replays a recorded Omarchy fixture for every command the adapter issues', async () => {
    // M-O7: the fake used to answer every command with shapes written for the test. Each answer
    // now comes from test/fixtures/omarchy, whose README names the capture command per file.
    const root = fixture('fixture-coverage');
    const quattro = fakeQuattro(root);
    const composite = adapter(root, daemon(root, []));
    const manager = createPlatformServiceManager(managerInput(root, quattro.runCommand, composite));
    await manager.install();
    await manager.status();
    await manager.uninstall();
    const names = new Set(quattro.commands.map(([, arguments_]) => omarchyFixtureName(arguments_)));
    expect(names.size).toBeGreaterThanOrEqual(8);
    for (const name of names) expect(existsSync(join(omarchyFixtureRoot, name)), name).toBe(true);
    const readme = readFileSync(join(omarchyFixtureRoot, 'README.md'), 'utf8');
    for (const name of readdirSync(omarchyFixtureRoot)) {
      if (name !== 'README.md') expect(readme, name).toContain(`\`${name}\``);
    }
    expect(() => omarchyFixture('missing-command.txt')).toThrow(/Missing Omarchy fixture/u);
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
