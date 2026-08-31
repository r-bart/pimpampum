#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacosRuntimePackage } from './macos-live-package.mjs';

if (process.env.PIMPAMPUM_RUN_LIVE_MACOS !== '1') {
  throw new Error('Set PIMPAMPUM_RUN_LIVE_MACOS=1 to run the reversible real macOS smoke.');
}
if (process.platform !== 'darwin') throw new Error('The macOS live smoke requires macOS.');

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveStartedAt = Date.now();
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pimpampum-macos-live-'));
const liveHome = join(temporaryRoot, 'home');
mkdirSync(liveHome, { recursive: true });
let cli = join(repositoryRoot, 'dist/cli.js');
let controlNode = process.execPath;
const app = join(liveHome, 'Applications/PimpampumMenuBar.app');
const launchAgent = join(liveHome, 'Library/LaunchAgents/dev.pimpampum.daemon.plist');
const launchDomain = `gui/${process.getuid()}/dev.pimpampum.daemon`;
const dataDirectory = join(temporaryRoot, 'data');
const workspace = join(temporaryRoot, 'workspace');
const evidencePath = join(repositoryRoot, 'thoughts/evidence/macos-live.json');
const environment = {
  ...process.env,
  HOME: liveHome,
  PIMPAMPUM_DATA_DIR: dataDirectory,
};
let installed = false;
let smokeCompleted = false;
const scenarios = {
  cleanNoNode: false,
  legacyNpmMigration: false,
  noAgent: false,
  oneAgent: false,
  twoAgents: false,
  partialFailure: false,
  conflictDecision: false,
  popoverRestartResume: false,
  packagedUpdate: false,
  disconnect: false,
  removal: false,
};

function command(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${arguments_.join(' ')} failed (${String(result.status)}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function runCli(...arguments_) {
  // Pimpampum CLI success is always exactly one {"data": ...} object. Unwrapping here keeps the
  // live runner honest about the contract instead of reading undefined fields off the envelope.
  const stdout = command(controlNode, [cli, ...arguments_]);
  const envelope = JSON.parse(stdout);
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== 1 ||
    !('data' in envelope)
  ) {
    throw new Error(
      `pimpampum ${arguments_.join(' ')} did not return one data envelope: ${stdout}`,
    );
  }
  return envelope.data;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeSha256(root) {
  const paths = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Unsafe symlink in final app artifact: ${path}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) paths.push({ path, mode: metadata.mode & 0o777 });
      else throw new Error(`Unsafe entry in final app artifact: ${path}`);
    }
  };
  visit(root);
  const digest = createHash('sha256');
  for (const entry of paths) {
    const bytes = readFileSync(entry.path);
    digest.update(relative(root, entry.path).split(sep).join('/'));
    digest.update('\0');
    digest.update(String(entry.mode));
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function installHostFixtures() {
  const bin = join(liveHome, '.local/bin');
  const state = join(temporaryRoot, 'host-state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  const codex = join(bin, 'codex');
  const claude = join(bin, 'claude');
  writeFileSync(
    codex,
    `#!/bin/sh
set -eu
state=${JSON.stringify(join(state, 'codex'))}
fail=${JSON.stringify(join(state, 'codex-fail'))}
if [ "\${1:-}" = "--version" ]; then printf 'codex-cli 1.0.0\\n'; exit 0; fi
if [ "\${1:-}" != "mcp" ]; then exit 2; fi
case "\${2:-}" in
  get|list)
    if [ "\${3:-}" = "--help" ]; then printf '%s\\n' '--json'; exit 0; fi
    if [ ! -f "$state" ]; then printf '%s\\n' 'No MCP server named pimpampum' >&2; exit 1; fi
    command_path=$(cat "$state")
    printf '{"name":"pimpampum","transport":{"type":"stdio","command":"%s","args":[],"env":{}}}\\n' "$command_path"
    ;;
  add)
    if [ "\${3:-}" = "--help" ]; then exit 0; fi
    if [ -f "$fail" ]; then printf '%s\\n' 'injected Codex add failure' >&2; exit 1; fi
    for argument in "$@"; do command_path=$argument; done
    printf '%s' "$command_path" > "$state"
    ;;
  remove)
    if [ "\${3:-}" = "--help" ]; then exit 0; fi
    rm -f "$state"
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    claude,
    `#!/bin/sh
set -eu
state=${JSON.stringify(join(state, 'claude'))}
fail=${JSON.stringify(join(state, 'claude-fail'))}
if [ "\${1:-}" = "--version" ]; then printf '1.0.0 (Claude Code)\\n'; exit 0; fi
if [ "\${1:-}" != "mcp" ]; then exit 2; fi
case "\${2:-}" in
  get)
    if [ "\${3:-}" = "--help" ]; then printf '%s\\n' '--json'; exit 0; fi
    if [ ! -f "$state" ]; then exit 1; fi
    command_path=$(cat "$state")
    printf '{"type":"stdio","command":"%s","args":[],"env":{}}\\n' "$command_path"
    ;;
  add-json|add)
    if [ "\${3:-}" = "--help" ]; then printf '%s\\n' '--scope'; exit 0; fi
    if [ -f "$fail" ]; then printf '%s\\n' 'injected Claude add failure' >&2; exit 1; fi
    for argument in "$@"; do json=$argument; done
    command_path=$(printf '%s' "$json" | sed -n 's/.*"command":"\\([^"]*\\)".*/\\1/p')
    [ -n "$command_path" ] || exit 2
    printf '%s' "$command_path" > "$state"
    ;;
  remove)
    if [ "\${3:-}" = "--help" ]; then printf '%s\\n' '--scope'; exit 0; fi
    rm -f "$state"
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  chmodSync(codex, 0o755);
  chmodSync(claude, 0o755);
  environment.PATH = `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  environment.PIMPAMPUM_LIVE_HOST_STATE = state;
  return { state };
}

function applySetupPlan(connectors, extraArguments = []) {
  const planArguments = connectors.flatMap((id) => ['--connector', id]);
  const plan = runCli('setup', 'plan', ...planArguments);
  const result = runCli(
    'setup',
    'apply',
    plan.operationId,
    plan.revision,
    '--yes',
    ...extraArguments,
  );
  return { plan, result };
}

async function runCliEventually(arguments_, attempts = 100) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return runCli(...arguments_);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError;
}

async function waitForBackupState(expected, attempts = 50) {
  let status;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = runCli('backup', 'status');
    if (status.state === expected) return status;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Automatic backup did not reach ${expected}: ${JSON.stringify(status ?? null)}`);
}

function serviceIsLoaded() {
  return spawnSync('/bin/launchctl', ['print', launchDomain], { encoding: 'utf8' }).status === 0;
}

async function waitForServiceLoaded(expected, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (serviceIsLoaded() === expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`The launchd service did not become ${expected ? 'loaded' : 'unloaded'}.`);
}

function appProcessIsRunning() {
  return (
    spawnSync('/usr/bin/pgrep', ['-f', join(app, 'Contents/MacOS/PimpampumMenuBar')], {
      encoding: 'utf8',
    }).status === 0
  );
}

async function waitForAppProcess(expected, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (appProcessIsRunning() === expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`The packaged menu app did not become ${expected ? 'running' : 'stopped'}.`);
}

function anyPimpampumAppProcessIsRunning() {
  return (
    spawnSync('/usr/bin/pgrep', ['-f', '/PimpampumMenuBar.app/Contents/MacOS/PimpampumMenuBar'], {
      encoding: 'utf8',
    }).status === 0
  );
}

// Uninstall returns once its own commands have completed; launchd and the menu app finish
// tearing down asynchronously. A shared CI runner can take well over the five seconds this
// originally allowed, so wait longer and, on failure, name what is actually left.
async function assertInstallationAbsent(attempts = 300) {
  let leftovers = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    leftovers = [
      existsSync(app) && 'app bundle',
      existsSync(launchAgent) && 'LaunchAgent plist',
      serviceIsLoaded() && 'launchd service',
      appProcessIsRunning() && 'app process',
    ].filter(Boolean);
    if (leftovers.length === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Uninstall left behind after ${attempts / 10}s: ${leftovers.join(', ')}.`);
}

function uiSnapshot(label, options = {}) {
  const output = join(temporaryRoot, `${label}.json`);
  const png = join(temporaryRoot, `${label}.png`);
  const binary = join(app, 'Contents/MacOS/PimpampumMenuBar');
  const arguments_ = ['--ui-smoke-snapshot', output, png];
  if (options.seedOverview) arguments_.push('--seed-overview', options.seedOverview);
  if (options.retainSeed) arguments_.push('--retain-seed');
  if (options.openProject) arguments_.push('--open-project', options.openProject);
  if (options.controlLabel) arguments_.push('--activate-control', options.controlLabel);
  rmSync(output, { force: true });
  rmSync(png, { force: true });
  command(binary, arguments_, {
    env: options.dataDirectory
      ? { ...environment, PIMPAMPUM_DATA_DIR: options.dataDirectory }
      : environment,
  });
  if (!existsSync(output) || !existsSync(png)) {
    throw new Error(`Native UI smoke did not produce the ${label} snapshot.`);
  }
  const snapshot = JSON.parse(readFileSync(output, 'utf8'));
  const rendered = readFileSync(png);
  const compactMark = readFileSync(join(app, 'Contents/Resources/PimpampumCompact.pdf'));
  const compactMarkSha256 = createHash('sha256').update(compactMark).digest('hex');
  const expectedDisplayCount =
    snapshot.activeCount <= 0
      ? null
      : snapshot.activeCount >= 100
        ? '99+'
        : String(snapshot.activeCount);
  if (
    snapshot.schemaVersion !== 2 ||
    snapshot.renderedPngSha256 !== createHash('sha256').update(rendered).digest('hex') ||
    rendered.length < 1_000 ||
    !snapshot.accessibilityLabels.includes(snapshot.accessibilityLabel) ||
    snapshot.markResource !== 'PimpampumCompact.pdf' ||
    snapshot.markResourceSha256 !== compactMarkSha256 ||
    snapshot.markIsTemplate !== true ||
    (snapshot.displayedActiveCount ?? null) !== expectedDisplayCount ||
    typeof snapshot.statusBadgeSystemImage !== 'string' ||
    /wifi|icloud|externaldrive|server|database/iu.test(snapshot.statusBadgeSystemImage)
  ) {
    throw new Error(
      `Native UI smoke produced an invalid ${label} rendering: ${JSON.stringify(snapshot)}`,
    );
  }
  return snapshot;
}

try {
  if (
    existsSync(app) ||
    existsSync(launchAgent) ||
    serviceIsLoaded() ||
    anyPimpampumAppProcessIsRunning()
  ) {
    throw new Error('Refusing live smoke because a Pimpampum user installation already exists.');
  }
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const canonicalWorkspace = realpathSync(workspace);
  const specBodyPath = join(workspace, 'status-integration-spec.md');
  writeFileSync(specBodyPath, '# Status integration Spec\n');

  const runtimeRoot = join(temporaryRoot, 'runtime');
  prepareMacosRuntimePackage({
    prepare() {
      execFileSync(process.execPath, [join(repositoryRoot, 'scripts/prepare-package.mjs')], {
        cwd: repositoryRoot,
        stdio: 'inherit',
      });
    },
    pack() {
      return JSON.parse(
        command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot]),
      )[0];
    },
    install(pack) {
      command('npm', [
        'install',
        '--prefix',
        runtimeRoot,
        '--omit=dev',
        join(temporaryRoot, pack.filename),
      ]);
    },
    restore() {
      execFileSync(
        process.execPath,
        [join(repositoryRoot, 'scripts/restore-package-manifest.mjs')],
        {
          cwd: repositoryRoot,
          stdio: 'inherit',
        },
      );
    },
  });
  const packagedRoot = join(runtimeRoot, 'node_modules/pimpampum');
  const packagedApp = join(packagedRoot, 'platforms/macos/dist/PimpampumMenuBar.app');
  const embeddedPayload = join(packagedApp, 'Contents/Resources/PimpampumRuntime/payload');
  const npmCli = join(packagedRoot, 'dist/cli.js');
  cli = join(embeddedPayload, 'dist/cli.js');
  controlNode = join(embeddedPayload, 'bin/node');
  environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

  const cleanVersion = runCli('version');
  const cleanPlan = runCli('setup', 'plan');
  const cleanResult = runCli('setup', 'apply', cleanPlan.operationId, cleanPlan.revision, '--yes');
  installed = true;
  const cleanJournal = runCli('setup', 'status');
  let empty = await runCliEventually(['overview']);
  const status = runCli('status');
  if (
    cleanVersion.version !==
      JSON.parse(readFileSync(join(packagedRoot, 'package.json'), 'utf8')).version ||
    cleanPlan.selectedConnectors.length !== 0 ||
    cleanResult.status !== 'complete' ||
    !status.installed ||
    !status.running ||
    empty.status !== 'empty'
  ) {
    throw new Error(
      `Embedded no-Node setup did not report the expected state: ${JSON.stringify({ cleanResult, status, empty })}`,
    );
  }
  scenarios.cleanNoNode = true;
  scenarios.noAgent = true;

  const preservedPaths = [join(dataDirectory, 'token'), join(dataDirectory, 'pimpampum.sqlite')];
  const cleanRemoval = runCli('uninstall');
  installed = false;
  await assertInstallationAbsent();
  if (!cleanRemoval.uninstalled) throw new Error('Clean setup removal failed before migration.');

  controlNode = process.execPath;
  cli = npmCli;
  const legacyInstall = runCli('install', '--service-only');
  installed = true;
  if (!legacyInstall.installed || !runCli('status').running) {
    throw new Error('Legacy npm service fixture did not become active.');
  }
  if (preservedPaths.some((path) => !existsSync(path))) {
    throw new Error('Legacy fixture did not retain the canonical token and SQLite data.');
  }
  const preservedHashes = Object.fromEntries(preservedPaths.map((path) => [path, sha256(path)]));
  controlNode = join(embeddedPayload, 'bin/node');
  cli = join(embeddedPayload, 'dist/cli.js');
  const installedRuntimeRoot = join(
    liveHome,
    'Library/Application Support/Pimpampum/Runtime',
    cleanVersion.version,
    'darwin-arm64',
  );
  const installedRuntimeNode = join(installedRuntimeRoot, 'bin/node');
  const installedRuntimeCli = join(installedRuntimeRoot, 'dist/cli.js');
  const migrationPlan = runCli('setup', 'plan');
  const migration = runCli(
    'setup',
    'apply',
    migrationPlan.operationId,
    migrationPlan.revision,
    '--yes',
  );
  const migratedReceipt = JSON.parse(
    readFileSync(join(dataDirectory, 'install-receipt.json'), 'utf8'),
  );
  if (
    migration.status !== 'complete' ||
    migratedReceipt.adapter !== 'launchd-macos-app' ||
    migratedReceipt.nodePath !== installedRuntimeNode ||
    migratedReceipt.cliPath !== installedRuntimeCli ||
    !Object.entries(preservedHashes).every(([path, hash]) => sha256(path) === hash)
  ) {
    throw new Error(
      `Legacy npm migration did not preserve data and activate the native packaged service: ${JSON.stringify(
        {
          status: migration.status,
          adapter: migratedReceipt.adapter,
          nodePathMatches: migratedReceipt.nodePath === installedRuntimeNode,
          cliPathMatches: migratedReceipt.cliPath === installedRuntimeCli,
          preservedData: Object.entries(preservedHashes).every(
            ([path, hash]) => sha256(path) === hash,
          ),
        },
      )}`,
    );
  }
  scenarios.legacyNpmMigration = true;
  empty = await runCliEventually(['overview']);

  const hostFixtures = installHostFixtures();
  const oneAgent = applySetupPlan(['codex']);
  if (
    oneAgent.result.status !== 'complete' ||
    oneAgent.result.connectors.length !== 1 ||
    oneAgent.result.connectors[0]?.available !== true
  ) {
    throw new Error(`One-agent setup failed: ${JSON.stringify(oneAgent.result)}`);
  }
  scenarios.oneAgent = true;
  runCli('disconnect', 'codex', '--yes');

  const twoAgents = applySetupPlan(['codex', 'claude-code']);
  if (
    twoAgents.result.status !== 'complete' ||
    twoAgents.result.connectors.length !== 2 ||
    !twoAgents.result.connectors.every((connector) => connector.available)
  ) {
    throw new Error(`Two-agent setup failed: ${JSON.stringify(twoAgents.result)}`);
  }
  scenarios.twoAgents = true;
  runCli('disconnect', 'codex', '--yes');
  runCli('disconnect', 'claude-code', '--yes');
  scenarios.disconnect = runCli('connections').every(
    (connection) => connection.state === 'notConnected',
  );

  writeFileSync(join(hostFixtures.state, 'claude-fail'), '1\n', { mode: 0o600 });
  const partial = applySetupPlan(['codex', 'claude-code']);
  if (
    partial.result.status !== 'partial' ||
    partial.result.connectors.filter((connector) => connector.available).length !== 1 ||
    partial.result.connectors.filter((connector) => connector.state === 'needsRepair').length !== 1
  ) {
    throw new Error(
      `Partial connector failure was not isolated: ${JSON.stringify(partial.result)}`,
    );
  }
  scenarios.partialFailure = true;

  const beforeRestart = runCli('setup', 'status');
  command('/usr/bin/open', ['-gj', app]);
  await waitForAppProcess(true);
  command('/usr/bin/pkill', ['-TERM', '-f', join(app, 'Contents/MacOS/PimpampumMenuBar')]);
  await waitForAppProcess(false);
  command('/usr/bin/open', ['-gj', app]);
  await waitForAppProcess(true);
  const resumedAfterRestart = runCli('setup', 'resume');
  const afterRestart = runCli('setup', 'status');
  scenarios.popoverRestartResume =
    beforeRestart.operationId === afterRestart.operationId &&
    beforeRestart.status === afterRestart.status &&
    resumedAfterRestart.status === afterRestart.status;
  command('/usr/bin/pkill', ['-TERM', '-f', join(app, 'Contents/MacOS/PimpampumMenuBar')]);
  await waitForAppProcess(false);

  rmSync(join(hostFixtures.state, 'claude-fail'));
  runCli('disconnect', 'codex', '--yes');
  writeFileSync(join(hostFixtures.state, 'codex'), '/usr/bin/false', { mode: 0o600 });
  const conflictPlan = runCli('setup', 'plan', '--connector', 'codex');
  const conflict = runCli(
    'setup',
    'apply',
    conflictPlan.operationId,
    conflictPlan.revision,
    '--yes',
  );
  if (conflict.status !== 'conflict') {
    throw new Error(`Connector conflict mutated without a decision: ${JSON.stringify(conflict)}`);
  }
  const replaced = runCli(
    'setup',
    'apply',
    conflictPlan.operationId,
    conflictPlan.revision,
    '--yes',
    '--replace',
    'codex',
  );
  if (replaced.status !== 'complete' || replaced.connectors[0]?.available !== true) {
    throw new Error(`Reviewed connector replacement failed: ${JSON.stringify(replaced)}`);
  }
  scenarios.conflictDecision = true;
  const sessionConnections = runCli('connections');
  const sessionRestart = {
    required: replaced.nextAction === 'new-session' || oneAgent.result.nextAction === 'new-session',
    observedAfterNewSession: sessionConnections.some(
      (connection) => connection.id === 'codex' && connection.available === true,
    ),
    connectors: ['codex'],
  };
  const emptyUI = uiSnapshot('empty');
  if (
    emptyUI.visualState !== 'No projects' ||
    emptyUI.connectionState !== 'online' ||
    emptyUI.projectRows.length !== 0
  ) {
    throw new Error('Native UI did not render the expected empty state.');
  }
  const settingsDisabledUI = uiSnapshot('settings-disabled', {
    controlLabel: 'Settings…',
  });
  if (
    settingsDisabledUI.activatedControlLabel !== 'Settings…' ||
    settingsDisabledUI.settingsWindowReused !== true ||
    settingsDisabledUI.settingsWindowCount !== 1 ||
    settingsDisabledUI.settingsWindowWidth !== 520 ||
    settingsDisabledUI.settingsWindowHeight !== 400 ||
    settingsDisabledUI.settingsWindowFocused !== true ||
    settingsDisabledUI.settingsBackupState !== 'disabled' ||
    (settingsDisabledUI.settingsConfiguredPath ?? null) !== null ||
    settingsDisabledUI.settingsErrorPresent !== false
  ) {
    throw new Error(
      `Native Settings did not open, focus, and reuse its disabled window: ${JSON.stringify(settingsDisabledUI)}`,
    );
  }

  runCli('workspace:add', 'live-smoke', 'Live Smoke', workspace);
  const project = runCli(
    'project:create',
    'live-smoke',
    'status-integration',
    'Status integration',
  );
  const spec = runCli(
    'spec:create',
    project.id,
    'status-integration-spec',
    'Status integration Spec',
    specBodyPath,
  );
  const readySpec = runCli('spec:ready', spec.id, String(spec.revision));
  const openProject = runCli('project:open', project.id, String(project.revision));
  const claim = runCli('work:start', 'spec', spec.id, 'macos-live-smoke');
  const active = runCli('overview');
  if (active.status !== 'active' || active.counts.activeClaims !== 1) {
    throw new Error('Live overview did not expose the active claim.');
  }
  const cappedOverviewPath = join(temporaryRoot, 'capped-overview.json');
  const cappedOverview = structuredClone(active);
  cappedOverview.counts.activeClaims = 100;
  cappedOverview.projects.find((row) => row.id === project.id).activeClaimCount = 100;
  writeFileSync(cappedOverviewPath, `${JSON.stringify(cappedOverview)}\n`, { mode: 0o600 });
  const cappedUI = uiSnapshot('capped-count', {
    seedOverview: cappedOverviewPath,
    retainSeed: true,
  });
  if (
    cappedUI.activeCount !== 100 ||
    cappedUI.displayedActiveCount !== '99+' ||
    cappedUI.accessibilityLabel !== 'pim • pam • pum: Active, 100 active claims'
  ) {
    throw new Error(`Native UI did not cap the visible count only: ${JSON.stringify(cappedUI)}`);
  }

  const longOverviewPath = join(temporaryRoot, 'long-overview.json');
  const longOverview = structuredClone(active);
  const longProject = longOverview.projects.find((row) => row.id === project.id);
  longProject.title =
    'A deliberately long multilingual project title for deterministic truncation — ' +
    'pimpampum agent coordination 상태 검증 '.repeat(6);
  longProject.slug = 'long-project-slug-for-end-elision-'.repeat(5);
  longProject.workspace.name = 'An exceptionally long workspace name '.repeat(5);
  longOverview.activeWork[0].projectTitle = longProject.title;
  writeFileSync(longOverviewPath, `${JSON.stringify(longOverview)}\n`, { mode: 0o600 });
  const longContentUI = uiSnapshot('long-content', {
    seedOverview: longOverviewPath,
    retainSeed: true,
  });
  if (
    longContentUI.visualState !== 'Active' ||
    longContentUI.projectRows.find((row) => row.id === project.id)?.title !== longProject.title
  ) {
    throw new Error('Native UI did not preserve the long-content rendering fixture.');
  }

  const quitUI = uiSnapshot('quit-boundary', { controlLabel: 'Quit' });
  if (
    quitUI.activatedControlLabel !== 'Quit' ||
    quitUI.quitActionInvoked !== true ||
    !runCli('status').running
  ) {
    throw new Error('The app Quit boundary did not leave the daemon running.');
  }
  const activeUI = uiSnapshot('active', { openProject: project.id });
  if (
    activeUI.visualState !== 'Active' ||
    activeUI.activeCount !== 1 ||
    activeUI.specRows.find((row) => row.id === spec.id)?.title !== 'Status integration Spec' ||
    activeUI.specRows.find((row) => row.id === spec.id)?.activeClaimCount !== 1 ||
    activeUI.projectRows.find((row) => row.id === project.id)?.workspacePath !==
      canonicalWorkspace ||
    activeUI.activatedControlLabel !== 'Open Status integration in Finder' ||
    activeUI.openedWorkspacePath !== canonicalWorkspace
  ) {
    throw new Error(
      `Native UI did not render and activate the expected project row: ${JSON.stringify(activeUI)}`,
    );
  }
  runCli(
    'work:complete',
    'spec',
    spec.id,
    'macos-live-smoke',
    String(claim.spec?.revision ?? readySpec.revision),
    'macOS live smoke Spec complete',
  );
  runCli(
    'project:complete',
    project.id,
    String(openProject.revision),
    'macOS live smoke project complete',
  );
  const complete = runCli('overview');
  if (complete.status !== 'complete') throw new Error('Live overview did not become complete.');
  const completeUI = uiSnapshot('complete');
  if (
    completeUI.visualState !== 'All complete' ||
    completeUI.activeCount !== 0 ||
    completeUI.completedCollapsed !== true ||
    completeUI.specRows.find((row) => row.id === spec.id)?.lifecycleState !== 'done' ||
    completeUI.projectRows.find((row) => row.id === project.id)?.status !== 'complete'
  ) {
    throw new Error('Native UI did not render the expected completed state.');
  }

  const backupDirectory = join(temporaryRoot, 'automatic-backup');
  mkdirSync(backupDirectory);
  const configuredBackup = runCli('backup', 'configure', backupDirectory);
  if (configuredBackup.state !== 'healthy' || configuredBackup.directory !== backupDirectory) {
    throw new Error('Automatic backup did not become healthy in the isolated destination.');
  }
  const settingsHealthyUI = uiSnapshot('settings-healthy', {
    controlLabel: 'Settings…',
  });
  if (
    settingsHealthyUI.settingsWindowReused !== true ||
    settingsHealthyUI.settingsBackupState !== 'healthy' ||
    settingsHealthyUI.settingsConfiguredPath !== backupDirectory ||
    settingsHealthyUI.settingsErrorPresent !== false
  ) {
    throw new Error(
      `Native Settings did not render the healthy backup: ${JSON.stringify(settingsHealthyUI)}`,
    );
  }

  rmSync(backupDirectory, { recursive: true });
  writeFileSync(backupDirectory, 'blocked by the reversible live smoke\n', { mode: 0o600 });
  const failedRetryCommand = spawnSync(process.execPath, [cli, 'backup', 'retry'], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
  });
  if (failedRetryCommand.status === 0) {
    throw new Error('Automatic backup unexpectedly succeeded against a file destination.');
  }
  const failedBackup = await waitForBackupState('error');
  if (typeof failedBackup.error !== 'string' || failedBackup.error.length === 0) {
    throw new Error('The isolated backup failure did not expose an actionable error.');
  }
  const settingsErrorUI = uiSnapshot('settings-error', {
    controlLabel: 'Settings…',
  });
  if (
    settingsErrorUI.settingsBackupState !== 'error' ||
    settingsErrorUI.settingsConfiguredPath !== backupDirectory ||
    settingsErrorUI.settingsErrorPresent !== true
  ) {
    throw new Error(
      `Native Settings did not render the backup error: ${JSON.stringify(settingsErrorUI)}`,
    );
  }

  rmSync(backupDirectory);
  mkdirSync(backupDirectory);
  const retriedBackup = runCli('backup', 'retry');
  if (retriedBackup.state !== 'healthy') {
    throw new Error('Automatic backup retry did not recover after restoring the destination.');
  }
  const disabledBackup = runCli('backup', 'disable');
  if (disabledBackup.state !== 'disabled') {
    throw new Error('Automatic backup did not disable after the Settings state exercise.');
  }
  const seedOverview = join(temporaryRoot, 'complete-overview.json');
  writeFileSync(seedOverview, `${JSON.stringify(complete)}\n`, { mode: 0o600 });
  command('/usr/bin/open', ['-gj', app]);
  await waitForAppProcess(true);
  const backgroundOnly = command('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to get background only of first process whose bundle identifier is "dev.pimpampum.menubar"',
  ]);
  if (backgroundOnly !== 'true') throw new Error('The menu app appeared as a Dock application.');
  const stoppedMenuApp = spawnSync(
    '/usr/bin/pkill',
    ['-TERM', '-f', join(app, 'Contents/MacOS/PimpampumMenuBar')],
    { encoding: 'utf8' },
  );
  if (stoppedMenuApp.status !== 0) {
    throw new Error(`Unable to stop the live-smoke menu app: ${stoppedMenuApp.stderr}`);
  }
  await waitForAppProcess(false);

  command('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, launchAgent]);
  await waitForServiceLoaded(false);
  const offline = spawnSync(controlNode, [cli, 'overview'], {
    env: environment,
    encoding: 'utf8',
  });
  if (offline.status === 0) throw new Error('Overview stayed online after daemon bootout.');
  const offlineUI = uiSnapshot('offline');
  if (
    offlineUI.visualState !== 'Offline' ||
    offlineUI.connectionState !== 'offline' ||
    offlineUI.stale !== false ||
    offlineUI.projectRows.length !== 0
  ) {
    throw new Error('Native UI did not render the expected offline-without-cache state.');
  }
  const staleUI = uiSnapshot('stale', { seedOverview });
  if (
    staleUI.visualState !== 'Offline — stale data' ||
    staleUI.connectionState !== 'offline' ||
    staleUI.stale !== true ||
    staleUI.projectRows.find((row) => row.id === project.id)?.status !== 'complete'
  ) {
    throw new Error('Native UI did not retain and label stale project data.');
  }
  const recovered = runCli('install');
  await runCliEventually(['overview']);
  if (!runCli('status').running) throw new Error('Repeat install did not recover the daemon.');
  const recoveredReceipt = JSON.parse(
    readFileSync(join(dataDirectory, 'install-receipt.json'), 'utf8'),
  );
  scenarios.packagedUpdate =
    recovered.reconciled === true &&
    recoveredReceipt.updateProvider === 'packaged-release' &&
    recoveredReceipt.adapter === 'launchd-macos-app' &&
    recoveredReceipt.nodePath === installedRuntimeNode &&
    recoveredReceipt.cliPath === installedRuntimeCli;
  const recoveredUI = uiSnapshot('recovered');
  if (
    recoveredUI.visualState !== 'All complete' ||
    recoveredUI.connectionState !== 'online' ||
    recoveredUI.stale !== false
  ) {
    throw new Error('Native UI did not recover from stale to online.');
  }

  const authenticationDataDirectory = join(temporaryRoot, 'authentication-data');
  mkdirSync(authenticationDataDirectory);
  copyFileSync(
    join(dataDirectory, 'install-receipt.json'),
    join(authenticationDataDirectory, 'install-receipt.json'),
  );
  writeFileSync(join(authenticationDataDirectory, 'token'), `${'a'.repeat(64)}\n`, {
    mode: 0o600,
  });
  const authenticationUI = uiSnapshot('authentication-error', {
    dataDirectory: authenticationDataDirectory,
  });
  if (
    authenticationUI.visualState !== 'Authentication error' ||
    authenticationUI.connectionState !== 'credentials' ||
    authenticationUI.projectRows.length !== 0
  ) {
    throw new Error('Native UI did not render rejected local credentials safely.');
  }

  const releaseApp = join(repositoryRoot, 'platforms/macos/dist/PimpampumMenuBar.app');
  const artifactMetadataPath = join(
    repositoryRoot,
    'platforms/macos/dist/PimpampumMenuBar.artifact.json',
  );
  const artifactMetadata = JSON.parse(readFileSync(artifactMetadataPath, 'utf8'));
  const releaseRuntime = join(releaseApp, 'Contents/Resources/PimpampumRuntime');
  const releasePayload = join(releaseRuntime, 'payload');
  const removal = runCli('uninstall');
  if (removal.uninstalled !== true) {
    throw new Error(`Uninstall did not acknowledge complete removal: ${JSON.stringify(removal)}`);
  }
  installed = false;
  await assertInstallationAbsent();
  scenarios.removal = true;

  const missingScenarios = Object.entries(scenarios)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (missingScenarios.length > 0) {
    throw new Error(`macOS live setup missed required scenarios: ${missingScenarios.join(', ')}.`);
  }
  if (!sessionRestart.required || !sessionRestart.observedAfterNewSession) {
    throw new Error('A new agent session was not both required and observed after connection.');
  }

  const durationMilliseconds = Date.now() - liveStartedAt;
  if (durationMilliseconds >= 120_000) {
    throw new Error(`macOS live setup exceeded two minutes: ${durationMilliseconds}ms.`);
  }

  const evidence = {
    schemaVersion: 3,
    status: 'passed',
    testedAt: new Date().toISOString(),
    durationMilliseconds,
    platform: 'macOS',
    architecture: 'arm64',
    gitCommit: artifactMetadata.sourceGitCommit,
    sourceInputSha256: artifactMetadata.sourceInputSha256,
    releaseSequence: ['sign-nested-runtime', 'sign-outer-app', 'notarize', 'staple', 'approve'],
    loginItem: cleanJournal.loginItem,
    versions: {
      pimpampum: artifactMetadata.appVersion,
      node: command(controlNode, ['--version']),
      macOS: command('/usr/bin/sw_vers', ['-productVersion']),
      codex: command(join(liveHome, '.local/bin/codex'), ['--version']),
      claudeCode: command(join(liveHome, '.local/bin/claude'), ['--version']),
    },
    artifactHashes: {
      artifactMetadataSha256: sha256(artifactMetadataPath),
      appBundleSha256: treeSha256(releaseApp),
      appBinarySha256: sha256(join(releaseApp, 'Contents/MacOS/PimpampumMenuBar')),
      compactMarkSha256: sha256(join(releaseApp, 'Contents/Resources/PimpampumCompact.pdf')),
      runtimeManifestSha256: sha256(join(releaseRuntime, 'runtime-manifest.json')),
      runtimeInventorySha256: sha256(join(releaseRuntime, 'runtime-inventory.json')),
      runtimeSbomSha256: sha256(join(releaseRuntime, 'runtime-sbom.spdx.json')),
      runtimeNodeSha256: sha256(join(releasePayload, 'bin/node')),
      runtimeAddonSha256: sha256(
        join(releasePayload, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
      ),
    },
    scenarios,
    sessionRestart,
    checks: {
      empty: true,
      activeClaim: true,
      completion: true,
      offlineWithoutCache: true,
      daemonOffline: true,
      nativePopoverRendering: true,
      fixedMarkResource: true,
      externalSemanticBadge: true,
      cappedVisibleCount: true,
      uncappedAccessibleCount: true,
      longContent: true,
      staleRecovery: true,
      authenticationError: true,
      projectRowActivation: true,
      namedSpecProgress: true,
      completedSpecDisclosure: true,
      finderRevealExactPath: true,
      settingsDisabled: true,
      settingsHealthy: true,
      settingsError: true,
      settingsWindowReused: true,
      settingsWindowFocused: true,
      settingsWindowSize: true,
      quitLeavesDaemonRunning: true,
      noDockIcon: true,
      repeatInstallRecovery: scenarios.packagedUpdate,
      uninstallCleanup: true,
    },
    renderings: {
      empty: emptyUI.renderedPngSha256,
      active: activeUI.renderedPngSha256,
      cappedCount: cappedUI.renderedPngSha256,
      longContent: longContentUI.renderedPngSha256,
      quitBoundary: quitUI.renderedPngSha256,
      complete: completeUI.renderedPngSha256,
      settingsDisabled: settingsDisabledUI.renderedPngSha256,
      settingsHealthy: settingsHealthyUI.renderedPngSha256,
      settingsError: settingsErrorUI.renderedPngSha256,
      offline: offlineUI.renderedPngSha256,
      stale: staleUI.renderedPngSha256,
      recovered: recoveredUI.renderedPngSha256,
      authenticationError: authenticationUI.renderedPngSha256,
    },
    manualBoundaries: [
      'Native NSOpenPanel selection and cancellation require user interaction.',
      'Light, dark, increased-contrast, and enlarged-text visual review remains manual.',
      'The transient pending backup frame is covered by focused Swift tests, not timing-based live automation.',
    ],
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  smokeCompleted = true;
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  if (installed) {
    const removal = spawnSync(controlNode, [cli, 'uninstall'], {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
    });
    if (removal.status !== 0) {
      process.stderr.write(`Live-smoke cleanup failed; data remains at ${dataDirectory}\n`);
      process.stderr.write(removal.stderr);
      process.exitCode = 1;
    }
  }
  if (smokeCompleted && !existsSync(launchAgent) && !existsSync(app)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } else if (!smokeCompleted) {
    process.stderr.write(`Live-smoke diagnostics retained at ${temporaryRoot}\n`);
  }
}
