#!/usr/bin/env node

// The reversible macOS live smoke: packs the repository, installs the embedded runtime into an
// isolated HOME, drives the guided setup, the connectors, the native popover snapshots, backup,
// offline recovery and removal, and writes `thoughts/evidence/macos-live.json` for
// `check-macos-evidence.mjs`. Only the release job runs it (PIMPAMPUM_RUN_LIVE_MACOS=1). Every
// assertion is one named check with one condition, so a failure on the runner names what broke.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './lib/checks.mjs';
import { parseJsonObject, unwrapCliEnvelope } from './lib/cliEnvelope.mjs';
import { hashTree, sha256, sha256File } from './lib/hashTree.mjs';
import { retry, waitFor } from './lib/waitFor.mjs';
import { prepareMacosRuntimePackage } from './macos-live-package.mjs';
import { GUIDED_SETUP_BUDGET_MILLISECONDS, LIVE_SETUP_SCENARIOS } from './macos-live-contract.mjs';

if (process.env.PIMPAMPUM_RUN_LIVE_MACOS !== '1') {
  throw new Error('Set PIMPAMPUM_RUN_LIVE_MACOS=1 to run the reversible real macOS smoke.');
}
if (process.platform !== 'darwin') throw new Error('The macOS live smoke requires macOS.');

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const liveStartedAt = Date.now();
// Spans measured inside the budget window that are not guided setup. `verifyLegacyMigration`
// sits between the first-run UI and the connector lifecycle only because of the order of `main`,
// and it cost 88s of the 120s budget on 2026-09-02 while the guided setup itself cost 44.7s. It is
// subtracted rather than reordered, because the later scenarios build on the state it leaves.
let budgetExcludedMilliseconds = 0;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pimpampum-macos-live-'));
const liveHome = join(temporaryRoot, 'home');
mkdirSync(liveHome, { recursive: true });
let cli = join(repositoryRoot, 'dist/cli.js');
let controlNode = process.execPath;
const app = join(liveHome, 'Applications/Pimpampum.app');
const appBinary = join(app, 'Contents/MacOS/PimpampumMenuBar');
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
const scenarios = Object.fromEntries(LIVE_SETUP_SCENARIOS.map((name) => [name, false]));
/** Observations the phases collect and `buildEvidence` reads. */
const run = {};

// ---------------------------------------------------------------------------------------------
// Commands and checks
// ---------------------------------------------------------------------------------------------

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

/**
 * Pimpampum CLI success is always exactly one {"data": ...} object. Unwrapping here keeps the
 * live runner honest about the contract instead of reading undefined fields off the envelope.
 * The payload may be an array (`connections`), so the envelope is unwrapped, not typed.
 */
function runCli(...arguments_) {
  const label = `pimpampum ${arguments_.join(' ')}`;
  const stdout = command(controlNode, [cli, ...arguments_]);
  return unwrapCliEnvelope(parseJsonObject(stdout, label), label);
}

/** One named condition; `details` is appended as JSON so a runner failure stays diagnosable. */
function expect(name, condition, message, details) {
  check(
    name,
    condition,
    details === undefined ? message : `${message}: ${JSON.stringify(details)}`,
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function appTreeSha256(root) {
  return hashTree(root, {
    includeMode: true,
    unsafeEntry: (path, kind) =>
      new Error(
        kind === 'symlink'
          ? `Unsafe symlink in final app artifact: ${path}`
          : `Unsafe entry in final app artifact: ${path}`,
      ),
  });
}

function writeSeed(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
}

// ---------------------------------------------------------------------------------------------
// Host fixtures: fake codex and claude executables with injectable failures
// ---------------------------------------------------------------------------------------------

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
config="$HOME/.claude.json"
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
    printf '{"mcpServers":{"pimpampum":{"type":"stdio","command":"%s","args":[],"env":{}}}}\\n' "$command_path" > "$config"
    ;;
  remove)
    if [ "\${3:-}" = "--help" ]; then printf '%s\\n' '--scope'; exit 0; fi
    rm -f "$state" "$config"
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

// ---------------------------------------------------------------------------------------------
// Setup, service and app process helpers
// ---------------------------------------------------------------------------------------------

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

function runCliEventually(arguments_, attempts = 100) {
  return retry(() => runCli(...arguments_), { attempts, intervalMs: 100 });
}

function waitForBackupState(expected, attempts = 50) {
  return waitFor(() => runCli('backup', 'status'), {
    attempts,
    intervalMs: 100,
    until: (status) => status.state === expected,
    timeoutMessage: (status) =>
      `Automatic backup did not reach ${expected}: ${JSON.stringify(status ?? null)}`,
  });
}

function serviceIsLoaded() {
  return spawnSync('/bin/launchctl', ['print', launchDomain], { encoding: 'utf8' }).status === 0;
}

function waitForServiceLoaded(expected, attempts = 50) {
  return waitFor(() => serviceIsLoaded() === expected, {
    attempts,
    intervalMs: 100,
    timeoutMessage: `The launchd service did not become ${expected ? 'loaded' : 'unloaded'}.`,
  });
}

function appProcessIsRunning() {
  return spawnSync('/usr/bin/pgrep', ['-f', appBinary], { encoding: 'utf8' }).status === 0;
}

function waitForAppProcess(expected, attempts = 50) {
  return waitFor(() => appProcessIsRunning() === expected, {
    attempts,
    intervalMs: 100,
    timeoutMessage: `The packaged menu app did not become ${expected ? 'running' : 'stopped'}.`,
  });
}

function anyPimpampumAppProcessIsRunning() {
  return (
    spawnSync('/usr/bin/pgrep', ['-f', '/Pimpampum.app/Contents/MacOS/PimpampumMenuBar'], {
      encoding: 'utf8',
    }).status === 0
  );
}

function installationLeftovers() {
  return [
    existsSync(app) && 'app bundle',
    existsSync(launchAgent) && 'LaunchAgent plist',
    serviceIsLoaded() && 'launchd service',
    appProcessIsRunning() && 'app process',
  ].filter(Boolean);
}

// Uninstall returns once its own commands have completed; launchd and the menu app finish
// tearing down asynchronously. A shared CI runner can take well over the five seconds this
// originally allowed, so wait longer and, on failure, name what is actually left.
function assertInstallationAbsent(attempts = 300) {
  return waitFor(installationLeftovers, {
    attempts,
    intervalMs: 100,
    until: (leftovers) => leftovers.length === 0,
    timeoutMessage: (leftovers) =>
      `Uninstall left behind after ${attempts / 10}s: ${leftovers.join(', ')}.`,
  });
}

function openMenuApp() {
  command('/usr/bin/open', ['-gj', app]);
  return waitForAppProcess(true);
}

function stopMenuApp() {
  command('/usr/bin/pkill', ['-TERM', '-f', appBinary]);
  return waitForAppProcess(false);
}

// ---------------------------------------------------------------------------------------------
// Native UI snapshots
// ---------------------------------------------------------------------------------------------

function expectedDisplayCount(activeCount) {
  if (activeCount <= 0) return null;
  return activeCount >= 100 ? '99+' : String(activeCount);
}

/** The invariants every snapshot must satisfy, whatever state it renders. */
function validateSnapshot(label, snapshot, rendered) {
  const message = `Native UI smoke produced an invalid ${label} rendering`;
  const compactMarkSha256 = sha256(
    readFileSync(join(app, 'Contents/Resources/PimpampumCompact.pdf')),
  );
  expect(
    'snapshot-schema',
    snapshot.schemaVersion === 2,
    `${message}: schemaVersion must be 2`,
    snapshot,
  );
  expect(
    'snapshot-png-hash',
    snapshot.renderedPngSha256 === sha256(rendered),
    `${message}: renderedPngSha256 must match the PNG on disk`,
    snapshot,
  );
  expect('snapshot-png-size', rendered.length >= 1_000, `${message}: PNG is too small`, snapshot);
  expect(
    'snapshot-accessibility-label-listed',
    snapshot.accessibilityLabels.includes(snapshot.accessibilityLabel),
    `${message}: accessibilityLabel must be among accessibilityLabels`,
    snapshot,
  );
  expect(
    'snapshot-mark-resource',
    snapshot.markResource === 'PimpampumCompact.pdf',
    `${message}: markResource must be PimpampumCompact.pdf`,
    snapshot,
  );
  expect(
    'snapshot-mark-hash',
    snapshot.markResourceSha256 === compactMarkSha256,
    `${message}: markResourceSha256 must match the bundled mark`,
    snapshot,
  );
  expect(
    'snapshot-mark-template',
    snapshot.markIsTemplate === true,
    `${message}: mark must be a template`,
    snapshot,
  );
  expect(
    'snapshot-displayed-count',
    (snapshot.displayedActiveCount ?? null) === expectedDisplayCount(snapshot.activeCount),
    `${message}: displayedActiveCount must hide zero and cap at 99+`,
    snapshot,
  );
  expect(
    'snapshot-badge-string',
    typeof snapshot.statusBadgeSystemImage === 'string',
    `${message}: statusBadgeSystemImage must be a string`,
    snapshot,
  );
  expect(
    'snapshot-badge-semantic',
    !/wifi|icloud|externaldrive|server|database/iu.test(snapshot.statusBadgeSystemImage),
    `${message}: statusBadgeSystemImage must not be a connectivity or storage glyph`,
    snapshot,
  );
}

function uiSnapshot(label, options = {}) {
  const output = join(temporaryRoot, `${label}.json`);
  const png = join(temporaryRoot, `${label}.png`);
  const arguments_ = ['--ui-smoke-snapshot', output, png];
  if (options.seedOverview) arguments_.push('--seed-overview', options.seedOverview);
  if (options.retainSeed) arguments_.push('--retain-seed');
  if (options.openProject) arguments_.push('--open-project', options.openProject);
  if (options.controlLabel) arguments_.push('--activate-control', options.controlLabel);
  rmSync(output, { force: true });
  rmSync(png, { force: true });
  command(appBinary, arguments_, {
    env: options.dataDirectory
      ? { ...environment, PIMPAMPUM_DATA_DIR: options.dataDirectory }
      : environment,
  });
  expect(
    'snapshot-json-written',
    existsSync(output),
    `Native UI smoke did not produce the ${label} snapshot.`,
  );
  expect(
    'snapshot-png-written',
    existsSync(png),
    `Native UI smoke did not produce the ${label} snapshot.`,
  );
  const snapshot = readJson(output);
  validateSnapshot(label, snapshot, readFileSync(png));
  return snapshot;
}

function settingsSnapshot(label) {
  return uiSnapshot(label, { controlLabel: 'Settings…' });
}

// ---------------------------------------------------------------------------------------------
// Phases, in the order the evidence records them
// ---------------------------------------------------------------------------------------------

function refuseExistingInstallation() {
  const refusal = 'Refusing live smoke because a Pimpampum user installation already exists.';
  expect('no-user-app', !existsSync(app), refusal);
  expect('no-user-launch-agent', !existsSync(launchAgent), refusal);
  expect('no-user-service', !serviceIsLoaded(), refusal);
  expect('no-user-app-process', !anyPimpampumAppProcessIsRunning(), refusal);
}

function prepareWorkspace() {
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  run.canonicalWorkspace = realpathSync(workspace);
  run.specBodyPath = join(workspace, 'status-integration-spec.md');
  writeFileSync(run.specBodyPath, '# Status integration Spec\n');
}

/** Packs the repository and installs it into an isolated runtime root; switches to its CLI. */
function prepareRuntime() {
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
  run.packagedRoot = join(runtimeRoot, 'node_modules/pimpampum');
  run.npmCli = join(run.packagedRoot, 'dist/cli.js');
  run.stagedApp = stageReleaseApp();
  run.embeddedPayload = join(run.stagedApp, 'Contents/Resources/PimpampumRuntime/payload');
  useEmbeddedRuntime();
  environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
}

/**
 * Copies the built app out of the repository into the temporary tree, the way a user receives it:
 * a bundle downloaded beside the checkout, not a directory inside `node_modules`.
 *
 * The app and its private runtime left the npm package in v1.2.12 (H-12 of the 2026-09-01 review:
 * `package.json#files` dropped them and `platforms/macos/dist/.npmignore` is the second guard), so
 * reading them back out of the installed package cannot work. `ditto` is used rather than a manual
 * walk because it preserves modes, symlinks and extended attributes, and the embedded `node` is a
 * signed Mach-O that any rewrite would invalidate.
 */
function stageReleaseApp() {
  const built = join(repositoryRoot, 'platforms/macos/dist/Pimpampum.app');
  if (!existsSync(built)) {
    throw new Error(`Build the app first with "npm run build:macos": ${built} is missing.`);
  }
  const staged = join(temporaryRoot, 'release/Pimpampum.app');
  mkdirSync(dirname(staged), { recursive: true });
  execFileSync('/usr/bin/ditto', [built, staged], { stdio: 'inherit' });
  return staged;
}

function useEmbeddedRuntime() {
  cli = join(run.embeddedPayload, 'dist/cli.js');
  controlNode = join(run.embeddedPayload, 'bin/node');
}

async function verifyCleanSetup() {
  run.cleanVersion = runCli('version');
  const cleanPlan = runCli('setup', 'plan');
  const cleanResult = runCli('setup', 'apply', cleanPlan.operationId, cleanPlan.revision, '--yes');
  installed = true;
  run.cleanJournal = runCli('setup', 'status');
  const empty = await runCliEventually(['overview']);
  const status = runCli('status');
  const message = 'Embedded no-Node setup did not report the expected state';
  expect(
    'clean-version',
    run.cleanVersion.version === readJson(join(run.packagedRoot, 'package.json')).version,
    `${message}: CLI version must match the packed package`,
    run.cleanVersion,
  );
  expect(
    'clean-no-connectors',
    cleanPlan.selectedConnectors.length === 0,
    `${message}: a clean plan selects no connectors`,
    cleanPlan,
  );
  expect(
    'clean-complete',
    cleanResult.status === 'complete',
    `${message}: apply must complete`,
    cleanResult,
  );
  expect(
    'clean-installed',
    Boolean(status.installed),
    `${message}: status must report installed`,
    status,
  );
  expect(
    'clean-running',
    Boolean(status.running),
    `${message}: status must report running`,
    status,
  );
  expect(
    'clean-empty-overview',
    empty.status === 'empty',
    `${message}: overview must be empty`,
    empty,
  );
  scenarios.cleanNoNode = true;
  scenarios.noAgent = true;
}

function verifyFirstRunUi() {
  const firstRunDataDirectory = join(temporaryRoot, 'first-run-ui');
  mkdirSync(firstRunDataDirectory, { recursive: true });
  const ui = uiSnapshot('setup-required', { dataDirectory: firstRunDataDirectory });
  const message = 'Native first-run UI did not render the guided setup';
  expect('first-run-visual-state', ui.visualState === 'Setup required', message, ui);
  expect('first-run-connection-state', ui.connectionState === 'setup-required', message, ui);
  // The first step is the welcome; its primary action proves the popover rendered a usable
  // onboarding rather than the empty panel this smoke exists to catch.
  expect(
    'first-run-primary-action',
    ui.accessibilityLabels.includes('Get started with guided setup'),
    message,
    ui,
  );
  run.setupRequiredUI = ui;
  scenarios.guidedSetupPopover = true;
}

/** Removes the clean setup, installs the legacy npm service, then migrates it in place. */
async function verifyLegacyMigration() {
  const preservedPaths = [join(dataDirectory, 'token'), join(dataDirectory, 'pimpampum.sqlite')];
  const cleanRemoval = runCli('uninstall');
  installed = false;
  await assertInstallationAbsent();
  expect(
    'clean-removal',
    Boolean(cleanRemoval.uninstalled),
    'Clean setup removal failed before migration.',
  );

  controlNode = process.execPath;
  cli = run.npmCli;
  const legacyInstall = runCli('install', '--service-only');
  installed = true;
  const legacyMessage = 'Legacy npm service fixture did not become active.';
  expect('legacy-installed', Boolean(legacyInstall.installed), legacyMessage, legacyInstall);
  expect('legacy-running', Boolean(runCli('status').running), legacyMessage);
  for (const path of preservedPaths) {
    expect(
      'legacy-data-present',
      existsSync(path),
      'Legacy fixture did not retain the canonical token and SQLite data.',
      { path },
    );
  }
  const preservedHashes = Object.fromEntries(
    preservedPaths.map((path) => [path, sha256File(path)]),
  );

  useEmbeddedRuntime();
  const installedRuntimeRoot = join(
    liveHome,
    'Library/Application Support/Pimpampum/Runtime',
    run.cleanVersion.version,
    'darwin-arm64',
  );
  run.installedRuntimeNode = join(installedRuntimeRoot, 'bin/node');
  run.installedRuntimeCli = join(installedRuntimeRoot, 'dist/cli.js');
  const migrationPlan = runCli('setup', 'plan');
  const migration = runCli(
    'setup',
    'apply',
    migrationPlan.operationId,
    migrationPlan.revision,
    '--yes',
  );
  const migratedReceipt = readJson(join(dataDirectory, 'install-receipt.json'));
  const message =
    'Legacy npm migration did not preserve data and activate the native packaged service';
  expect('migration-complete', migration.status === 'complete', message, {
    status: migration.status,
  });
  expect('migration-adapter', migratedReceipt.adapter === 'launchd-macos-app', message, {
    adapter: migratedReceipt.adapter,
  });
  expect('migration-node-path', migratedReceipt.nodePath === run.installedRuntimeNode, message, {
    nodePath: migratedReceipt.nodePath,
    expected: run.installedRuntimeNode,
  });
  expect('migration-cli-path', migratedReceipt.cliPath === run.installedRuntimeCli, message, {
    cliPath: migratedReceipt.cliPath,
    expected: run.installedRuntimeCli,
  });
  for (const [path, hash] of Object.entries(preservedHashes)) {
    expect('migration-preserved-data', sha256File(path) === hash, message, { path });
  }
  scenarios.legacyNpmMigration = true;
  await runCliEventually(['overview']);
}

function verifyOneAgent() {
  const oneAgent = applySetupPlan(['codex']);
  const message = 'One-agent setup failed';
  expect('one-agent-complete', oneAgent.result.status === 'complete', message, oneAgent.result);
  expect('one-agent-count', oneAgent.result.connectors.length === 1, message, oneAgent.result);
  expect(
    'one-agent-available',
    oneAgent.result.connectors[0]?.available === true,
    message,
    oneAgent.result,
  );
  // The release budget is download/artifact preflight through the first verified agent, minus the
  // exhaustive release validation that `main` happens to run inside that window. The remaining
  // fault injection, UI rendering, update and removal cases run after this point and are excluded
  // by ordering; `verifyLegacyMigration` runs before it and is excluded by subtraction.
  run.durationMilliseconds = Date.now() - liveStartedAt - budgetExcludedMilliseconds;
  scenarios.oneAgent = true;
  runCli('disconnect', 'codex', '--yes');
  return oneAgent;
}

function verifyTwoAgents() {
  const twoAgents = applySetupPlan(['codex', 'claude-code']);
  const message = 'Two-agent setup failed';
  expect('two-agents-complete', twoAgents.result.status === 'complete', message, twoAgents.result);
  expect('two-agents-count', twoAgents.result.connectors.length === 2, message, twoAgents.result);
  expect(
    'two-agents-available',
    twoAgents.result.connectors.every((connector) => connector.available),
    message,
    twoAgents.result,
  );
  scenarios.twoAgents = true;
  runCli('disconnect', 'codex', '--yes');
  runCli('disconnect', 'claude-code', '--yes');
  scenarios.disconnect = runCli('connections').every(
    (connection) => connection.state === 'notConnected',
  );
}

function verifyPartialFailure(hostFixtures) {
  writeFileSync(join(hostFixtures.state, 'claude-fail'), '1\n', { mode: 0o600 });
  const partial = applySetupPlan(['codex', 'claude-code']);
  const message = 'Partial connector failure was not isolated';
  expect('partial-status', partial.result.status === 'partial', message, partial.result);
  expect(
    'partial-one-available',
    partial.result.connectors.filter((connector) => connector.available).length === 1,
    message,
    partial.result,
  );
  expect(
    'partial-one-needs-repair',
    partial.result.connectors.filter((connector) => connector.state === 'needsRepair').length === 1,
    message,
    partial.result,
  );
  scenarios.partialFailure = true;
}

async function verifyPopoverRestartResume() {
  const beforeRestart = runCli('setup', 'status');
  await openMenuApp();
  await stopMenuApp();
  await openMenuApp();
  const resumedAfterRestart = runCli('setup', 'resume');
  const afterRestart = runCli('setup', 'status');
  scenarios.popoverRestartResume =
    beforeRestart.operationId === afterRestart.operationId &&
    beforeRestart.status === afterRestart.status &&
    resumedAfterRestart.status === afterRestart.status;
  await stopMenuApp();
}

function verifyConflictDecision(hostFixtures) {
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
  expect(
    'conflict-detected',
    conflict.status === 'conflict',
    'Connector conflict mutated without a decision',
    conflict,
  );
  const replaced = runCli(
    'setup',
    'apply',
    conflictPlan.operationId,
    conflictPlan.revision,
    '--yes',
    '--replace',
    'codex',
  );
  const message = 'Reviewed connector replacement failed';
  expect('replacement-complete', replaced.status === 'complete', message, replaced);
  expect('replacement-available', replaced.connectors[0]?.available === true, message, replaced);
  scenarios.conflictDecision = true;
  return replaced;
}

async function verifyConnectorLifecycle() {
  const hostFixtures = installHostFixtures();
  const oneAgent = verifyOneAgent();
  verifyTwoAgents();
  verifyPartialFailure(hostFixtures);
  await verifyPopoverRestartResume();
  const replaced = verifyConflictDecision(hostFixtures);
  const sessionConnections = runCli('connections');
  run.sessionRestart = {
    required: [replaced, oneAgent.result].some((result) =>
      result.connectors.some((connector) => connector.newSessionRequired),
    ),
    observedAfterNewSession: sessionConnections.some(
      (connection) => connection.id === 'codex' && connection.available === true,
    ),
    connectors: ['codex'],
  };
}

function verifyEmptyAndSettingsUi() {
  const emptyUI = uiSnapshot('empty');
  const emptyMessage = 'Native UI did not render the expected empty state.';
  expect('empty-visual-state', emptyUI.visualState === 'No projects', emptyMessage, emptyUI);
  expect('empty-connection-state', emptyUI.connectionState === 'online', emptyMessage, emptyUI);
  expect('empty-no-rows', emptyUI.projectRows.length === 0, emptyMessage, emptyUI);
  run.emptyUI = emptyUI;

  const ui = settingsSnapshot('settings-disabled');
  const message = 'Native Settings did not open, focus, and reuse its disabled window';
  expect('settings-activated', ui.activatedControlLabel === 'Settings…', message, ui);
  expect('settings-window-reused', ui.settingsWindowReused === true, message, ui);
  expect('settings-window-count', ui.settingsWindowCount === 1, message, ui);
  expect('settings-window-width', ui.settingsWindowWidth === 520, message, ui);
  expect('settings-window-height', ui.settingsWindowHeight === 400, message, ui);
  expect('settings-window-focused', ui.settingsWindowFocused === true, message, ui);
  expect('settings-backup-disabled', ui.settingsBackupState === 'disabled', message, ui);
  expect('settings-no-path', (ui.settingsConfiguredPath ?? null) === null, message, ui);
  expect('settings-no-error', ui.settingsErrorPresent === false, message, ui);
  run.settingsDisabledUI = ui;
}

function seedPortfolio() {
  runCli('workspace:add', 'live-smoke', 'Live Smoke', workspace);
  run.project = runCli('project:create', 'live-smoke', 'status-integration', 'Status integration');
  run.spec = runCli(
    'spec:create',
    run.project.id,
    'status-integration-spec',
    'Status integration Spec',
    run.specBodyPath,
  );
  run.readySpec = runCli('spec:ready', run.spec.id, String(run.spec.revision));
  run.openProject = runCli('project:open', run.project.id, String(run.project.revision));
  run.claim = runCli('work:start', 'spec', run.spec.id, 'macos-live-smoke');
  run.active = runCli('overview');
  const message = 'Live overview did not expose the active claim.';
  expect('overview-active', run.active.status === 'active', message, run.active);
  expect('overview-one-claim', run.active.counts.activeClaims === 1, message, run.active.counts);
}

function verifyCappedCount() {
  const cappedOverview = structuredClone(run.active);
  cappedOverview.counts.activeClaims = 100;
  cappedOverview.projects.find((row) => row.id === run.project.id).activeClaimCount = 100;
  const ui = uiSnapshot('capped-count', {
    seedOverview: writeSeed(join(temporaryRoot, 'capped-overview.json'), cappedOverview),
    retainSeed: true,
  });
  const message = 'Native UI did not cap the visible count only';
  expect('capped-active-count', ui.activeCount === 100, message, ui);
  expect('capped-displayed-count', ui.displayedActiveCount === '99+', message, ui);
  expect(
    'capped-accessible-count',
    ui.accessibilityLabel === 'pim • pam • pum: Active, 100 active claims',
    message,
    ui,
  );
  run.cappedUI = ui;
}

function verifyLongContent() {
  const longOverview = structuredClone(run.active);
  const longProject = longOverview.projects.find((row) => row.id === run.project.id);
  longProject.title =
    'A deliberately long multilingual project title for deterministic truncation — ' +
    'pimpampum agent coordination 상태 검증 '.repeat(6);
  longProject.slug = 'long-project-slug-for-end-elision-'.repeat(5);
  longProject.workspace.name = 'An exceptionally long workspace name '.repeat(5);
  longOverview.activeWork[0].projectTitle = longProject.title;
  const ui = uiSnapshot('long-content', {
    seedOverview: writeSeed(join(temporaryRoot, 'long-overview.json'), longOverview),
    retainSeed: true,
  });
  const message = 'Native UI did not preserve the long-content rendering fixture.';
  expect('long-content-visual-state', ui.visualState === 'Active', message, ui);
  expect(
    'long-content-title',
    ui.projectRows.find((row) => row.id === run.project.id)?.title === longProject.title,
    message,
    ui,
  );
  run.longContentUI = ui;
}

function verifyQuitBoundary() {
  const ui = uiSnapshot('quit-boundary', { controlLabel: 'Quit' });
  const message = 'The app Quit boundary did not leave the daemon running.';
  expect('quit-activated', ui.activatedControlLabel === 'Quit', message, ui);
  expect('quit-invoked', ui.quitActionInvoked === true, message, ui);
  expect('quit-daemon-running', Boolean(runCli('status').running), message);
  run.quitUI = ui;
}

function verifyActiveRow() {
  const ui = uiSnapshot('active', { openProject: run.project.id });
  const message = 'Native UI did not render and activate the expected project row';
  const specRow = ui.specRows.find((row) => row.id === run.spec.id);
  const projectRow = ui.projectRows.find((row) => row.id === run.project.id);
  expect('active-visual-state', ui.visualState === 'Active', message, ui);
  expect('active-count', ui.activeCount === 1, message, ui);
  expect('active-spec-title', specRow?.title === 'Status integration Spec', message, ui);
  expect('active-spec-claims', specRow?.activeClaimCount === 1, message, ui);
  expect(
    'active-workspace-path',
    projectRow?.workspacePath === run.canonicalWorkspace,
    message,
    ui,
  );
  expect(
    'active-row-activation',
    ui.activatedControlLabel === 'Open Status integration in Finder',
    message,
    ui,
  );
  expect('active-opened-workspace', ui.openedWorkspacePath === run.canonicalWorkspace, message, ui);
  run.activeUI = ui;
}

function verifyRenderingFixtures() {
  verifyCappedCount();
  verifyLongContent();
  verifyQuitBoundary();
  verifyActiveRow();
}

function completePortfolio() {
  runCli(
    'work:complete',
    'spec',
    run.spec.id,
    'macos-live-smoke',
    String(run.claim.spec?.revision ?? run.readySpec.revision),
    'macOS live smoke Spec complete',
  );
  runCli(
    'project:complete',
    run.project.id,
    String(run.openProject.revision),
    'macOS live smoke project complete',
  );
  run.complete = runCli('overview');
  expect(
    'overview-complete',
    run.complete.status === 'complete',
    'Live overview did not become complete.',
    run.complete,
  );
  const ui = uiSnapshot('complete');
  const message = 'Native UI did not render the expected completed state.';
  expect('complete-visual-state', ui.visualState === 'All complete', message, ui);
  expect('complete-count', ui.activeCount === 0, message, ui);
  expect('complete-collapsed', ui.completedCollapsed === true, message, ui);
  expect(
    'complete-spec-done',
    ui.specRows.find((row) => row.id === run.spec.id)?.lifecycleState === 'done',
    message,
    ui,
  );
  expect(
    'complete-project-status',
    ui.projectRows.find((row) => row.id === run.project.id)?.status === 'complete',
    message,
    ui,
  );
  run.completeUI = ui;
}

async function verifyBackupSettings() {
  const backupDirectory = join(temporaryRoot, 'automatic-backup');
  mkdirSync(backupDirectory);
  const configuredBackup = runCli('backup', 'configure', backupDirectory);
  const configuredMessage = 'Automatic backup did not become healthy in the isolated destination.';
  expect(
    'backup-healthy',
    configuredBackup.state === 'healthy',
    configuredMessage,
    configuredBackup,
  );
  expect(
    'backup-directory',
    configuredBackup.directory === backupDirectory,
    configuredMessage,
    configuredBackup,
  );
  const healthyUI = settingsSnapshot('settings-healthy');
  const healthyMessage = 'Native Settings did not render the healthy backup';
  expect(
    'settings-healthy-reused',
    healthyUI.settingsWindowReused === true,
    healthyMessage,
    healthyUI,
  );
  expect(
    'settings-healthy-state',
    healthyUI.settingsBackupState === 'healthy',
    healthyMessage,
    healthyUI,
  );
  expect(
    'settings-healthy-path',
    healthyUI.settingsConfiguredPath === backupDirectory,
    healthyMessage,
    healthyUI,
  );
  expect(
    'settings-healthy-no-error',
    healthyUI.settingsErrorPresent === false,
    healthyMessage,
    healthyUI,
  );
  run.settingsHealthyUI = healthyUI;

  rmSync(backupDirectory, { recursive: true });
  writeFileSync(backupDirectory, 'blocked by the reversible live smoke\n', { mode: 0o600 });
  const failedRetryCommand = spawnSync(controlNode, [cli, 'backup', 'retry'], {
    cwd: repositoryRoot,
    env: environment,
    encoding: 'utf8',
  });
  // A retry that ends in `state: 'error'` is a successful report of a failed backup, so the CLI
  // exits zero and puts the reason in the payload; see the comment on `backup retry` in
  // src/cliHandlers/backup.ts. Up to v1.2.11 it threw `internal_error` instead, which flattened
  // the reason into an exit code. Asserting the payload is the stronger check either way.
  expect(
    'backup-retry-reports',
    failedRetryCommand.status === 0,
    'A failed backup must be reported in the payload, not flattened into an exit code.',
    { status: failedRetryCommand.status, stderr: failedRetryCommand.stderr },
  );
  const retryReport = unwrapCliEnvelope(
    parseJsonObject(failedRetryCommand.stdout, 'backup retry'),
    'backup retry',
  );
  expect(
    'backup-retry-refused',
    retryReport.state === 'error' &&
      typeof retryReport.error === 'string' &&
      retryReport.error.length > 0,
    'Automatic backup unexpectedly succeeded against a file destination.',
    retryReport,
  );
  const failedBackup = await waitForBackupState('error');
  expect(
    'backup-error-actionable',
    typeof failedBackup.error === 'string' && failedBackup.error.length > 0,
    'The isolated backup failure did not expose an actionable error.',
    failedBackup,
  );
  const errorUI = settingsSnapshot('settings-error');
  const errorMessage = 'Native Settings did not render the backup error';
  expect('settings-error-state', errorUI.settingsBackupState === 'error', errorMessage, errorUI);
  expect(
    'settings-error-path',
    errorUI.settingsConfiguredPath === backupDirectory,
    errorMessage,
    errorUI,
  );
  expect('settings-error-present', errorUI.settingsErrorPresent === true, errorMessage, errorUI);
  run.settingsErrorUI = errorUI;

  rmSync(backupDirectory);
  mkdirSync(backupDirectory);
  const retriedBackup = runCli('backup', 'retry');
  expect(
    'backup-retry-recovered',
    retriedBackup.state === 'healthy',
    'Automatic backup retry did not recover after restoring the destination.',
    retriedBackup,
  );
  const disabledBackup = runCli('backup', 'disable');
  expect(
    'backup-disabled',
    disabledBackup.state === 'disabled',
    'Automatic backup did not disable after the Settings state exercise.',
    disabledBackup,
  );
}

async function verifyBackgroundOnlyApp() {
  run.seedOverview = writeSeed(join(temporaryRoot, 'complete-overview.json'), run.complete);
  await openMenuApp();
  const backgroundOnly = command('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to get background only of first process whose bundle identifier is "dev.pimpampum.menubar"',
  ]);
  expect(
    'no-dock-icon',
    backgroundOnly === 'true',
    'The menu app appeared as a Dock application.',
    {
      backgroundOnly,
    },
  );
  const stoppedMenuApp = spawnSync('/usr/bin/pkill', ['-TERM', '-f', appBinary], {
    encoding: 'utf8',
  });
  expect(
    'menu-app-stopped',
    stoppedMenuApp.status === 0,
    `Unable to stop the live-smoke menu app: ${stoppedMenuApp.stderr}`,
  );
  await waitForAppProcess(false);
}

async function verifyOfflineAndRecovery() {
  command('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, launchAgent]);
  await waitForServiceLoaded(false);
  const offline = spawnSync(controlNode, [cli, 'overview'], {
    env: environment,
    encoding: 'utf8',
  });
  expect('overview-offline', offline.status !== 0, 'Overview stayed online after daemon bootout.');
  const offlineUI = uiSnapshot('offline');
  const offlineMessage = 'Native UI did not render the expected offline-without-cache state.';
  expect('offline-visual-state', offlineUI.visualState === 'Offline', offlineMessage, offlineUI);
  expect(
    'offline-connection-state',
    offlineUI.connectionState === 'offline',
    offlineMessage,
    offlineUI,
  );
  expect('offline-not-stale', offlineUI.stale === false, offlineMessage, offlineUI);
  expect('offline-no-rows', offlineUI.projectRows.length === 0, offlineMessage, offlineUI);
  run.offlineUI = offlineUI;

  const staleUI = uiSnapshot('stale', { seedOverview: run.seedOverview });
  const staleMessage = 'Native UI did not retain and label stale project data.';
  expect(
    'stale-visual-state',
    staleUI.visualState === 'Offline — stale data',
    staleMessage,
    staleUI,
  );
  expect('stale-connection-state', staleUI.connectionState === 'offline', staleMessage, staleUI);
  expect('stale-flag', staleUI.stale === true, staleMessage, staleUI);
  expect(
    'stale-project-retained',
    staleUI.projectRows.find((row) => row.id === run.project.id)?.status === 'complete',
    staleMessage,
    staleUI,
  );
  run.staleUI = staleUI;

  const recovered = runCli('install');
  await runCliEventually(['overview']);
  expect(
    'repeat-install-running',
    Boolean(runCli('status').running),
    'Repeat install did not recover the daemon.',
  );
  const recoveredReceipt = readJson(join(dataDirectory, 'install-receipt.json'));
  scenarios.packagedUpdate =
    recovered.reconciled === true &&
    recoveredReceipt.updateProvider === 'packaged-release' &&
    recoveredReceipt.adapter === 'launchd-macos-app' &&
    recoveredReceipt.nodePath === run.installedRuntimeNode &&
    recoveredReceipt.cliPath === run.installedRuntimeCli;
  const recoveredUI = uiSnapshot('recovered');
  const recoveredMessage = 'Native UI did not recover from stale to online.';
  expect(
    'recovered-visual-state',
    recoveredUI.visualState === 'All complete',
    recoveredMessage,
    recoveredUI,
  );
  expect(
    'recovered-connection-state',
    recoveredUI.connectionState === 'online',
    recoveredMessage,
    recoveredUI,
  );
  expect('recovered-not-stale', recoveredUI.stale === false, recoveredMessage, recoveredUI);
  run.recoveredUI = recoveredUI;
}

function verifyAuthenticationError() {
  const authenticationDataDirectory = join(temporaryRoot, 'authentication-data');
  mkdirSync(authenticationDataDirectory);
  copyFileSync(
    join(dataDirectory, 'install-receipt.json'),
    join(authenticationDataDirectory, 'install-receipt.json'),
  );
  writeFileSync(join(authenticationDataDirectory, 'token'), `${'a'.repeat(64)}\n`, {
    mode: 0o600,
  });
  const ui = uiSnapshot('authentication-error', { dataDirectory: authenticationDataDirectory });
  const message = 'Native UI did not render rejected local credentials safely.';
  expect('authentication-visual-state', ui.visualState === 'Authentication error', message, ui);
  expect('authentication-connection-state', ui.connectionState === 'credentials', message, ui);
  expect('authentication-no-rows', ui.projectRows.length === 0, message, ui);
  run.authenticationUI = ui;
}

async function verifyRemoval() {
  const removal = runCli('uninstall');
  expect(
    'uninstall-complete',
    removal.uninstalled === true,
    'Uninstall did not acknowledge complete removal',
    removal,
  );
  installed = false;
  await assertInstallationAbsent();
  scenarios.removal = true;
}

function assertRunComplete() {
  const missingScenarios = Object.entries(scenarios)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  expect(
    'all-scenarios-observed',
    missingScenarios.length === 0,
    `macOS live setup missed required scenarios: ${missingScenarios.join(', ')}.`,
  );
  const sessionMessage = 'A new agent session was not both required and observed after connection';
  expect(
    'session-restart-required',
    run.sessionRestart.required,
    sessionMessage,
    run.sessionRestart,
  );
  expect(
    'session-restart-observed',
    run.sessionRestart.observedAfterNewSession,
    sessionMessage,
    run.sessionRestart,
  );
  expect(
    'guided-setup-budget',
    run.durationMilliseconds < GUIDED_SETUP_BUDGET_MILLISECONDS,
    `macOS live setup exceeded two minutes: ${run.durationMilliseconds}ms.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------------

/** Reads the release artifact before removal; its hashes bind the evidence to the tested build. */
function readReleaseArtifact() {
  const releaseApp = join(repositoryRoot, 'platforms/macos/dist/Pimpampum.app');
  const artifactMetadataPath = join(
    repositoryRoot,
    'platforms/macos/dist/PimpampumMenuBar.artifact.json',
  );
  const releaseRuntime = join(releaseApp, 'Contents/Resources/PimpampumRuntime');
  run.release = {
    releaseApp,
    artifactMetadataPath,
    artifactMetadata: readJson(artifactMetadataPath),
    releaseRuntime,
    releasePayload: join(releaseRuntime, 'payload'),
  };
}

function buildEvidence() {
  const { releaseApp, artifactMetadataPath, artifactMetadata, releaseRuntime, releasePayload } =
    run.release;
  return {
    schemaVersion: 3,
    status: 'passed',
    testedAt: new Date().toISOString(),
    durationMilliseconds: run.durationMilliseconds,
    platform: 'macOS',
    architecture: 'arm64',
    gitCommit: artifactMetadata.sourceGitCommit,
    sourceInputSha256: artifactMetadata.sourceInputSha256,
    releaseSequence: ['sign-nested-runtime', 'sign-outer-app', 'notarize', 'staple', 'approve'],
    loginItem: run.cleanJournal.loginItem,
    versions: {
      pimpampum: artifactMetadata.appVersion,
      node: command(controlNode, ['--version']),
      macOS: command('/usr/bin/sw_vers', ['-productVersion']),
      codex: command(join(liveHome, '.local/bin/codex'), ['--version']),
      claudeCode: command(join(liveHome, '.local/bin/claude'), ['--version']),
    },
    artifactHashes: {
      artifactMetadataSha256: sha256File(artifactMetadataPath),
      appBundleSha256: appTreeSha256(releaseApp),
      appBinarySha256: sha256File(join(releaseApp, 'Contents/MacOS/PimpampumMenuBar')),
      compactMarkSha256: sha256File(join(releaseApp, 'Contents/Resources/PimpampumCompact.pdf')),
      runtimeManifestSha256: sha256File(join(releaseRuntime, 'runtime-manifest.json')),
      runtimeInventorySha256: sha256File(join(releaseRuntime, 'runtime-inventory.json')),
      runtimeSbomSha256: sha256File(join(releaseRuntime, 'runtime-sbom.spdx.json')),
      runtimeNodeSha256: sha256File(join(releasePayload, 'bin/node')),
      runtimeAddonSha256: sha256File(
        join(releasePayload, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
      ),
    },
    scenarios,
    sessionRestart: run.sessionRestart,
    checks: {
      empty: true,
      activeClaim: true,
      completion: true,
      offlineWithoutCache: true,
      daemonOffline: true,
      nativePopoverRendering: true,
      guidedSetupPopover: scenarios.guidedSetupPopover,
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
      setupRequired: run.setupRequiredUI.renderedPngSha256,
      empty: run.emptyUI.renderedPngSha256,
      active: run.activeUI.renderedPngSha256,
      cappedCount: run.cappedUI.renderedPngSha256,
      longContent: run.longContentUI.renderedPngSha256,
      quitBoundary: run.quitUI.renderedPngSha256,
      complete: run.completeUI.renderedPngSha256,
      settingsDisabled: run.settingsDisabledUI.renderedPngSha256,
      settingsHealthy: run.settingsHealthyUI.renderedPngSha256,
      settingsError: run.settingsErrorUI.renderedPngSha256,
      offline: run.offlineUI.renderedPngSha256,
      stale: run.staleUI.renderedPngSha256,
      recovered: run.recoveredUI.renderedPngSha256,
      authenticationError: run.authenticationUI.renderedPngSha256,
    },
    manualBoundaries: [
      'Native NSOpenPanel selection and cancellation require user interaction.',
      'Light, dark, increased-contrast, and enlarged-text visual review remains manual.',
      'The transient pending backup frame is covered by focused Swift tests, not timing-based live automation.',
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

async function main() {
  refuseExistingInstallation();
  prepareWorkspace();
  prepareRuntime();
  await verifyCleanSetup();
  verifyFirstRunUi();
  const legacyMigrationStartedAt = Date.now();
  await verifyLegacyMigration();
  budgetExcludedMilliseconds += Date.now() - legacyMigrationStartedAt;
  await verifyConnectorLifecycle();
  verifyEmptyAndSettingsUi();
  seedPortfolio();
  verifyRenderingFixtures();
  completePortfolio();
  await verifyBackupSettings();
  await verifyBackgroundOnlyApp();
  await verifyOfflineAndRecovery();
  verifyAuthenticationError();
  readReleaseArtifact();
  await verifyRemoval();
  assertRunComplete();
  const evidence = buildEvidence();
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  smokeCompleted = true;
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

try {
  await main();
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
