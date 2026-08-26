#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacosRuntimePackage } from './macos-live-package.mjs';

if (process.env.PIMPAMPUM_RUN_LIVE_MACOS !== '1') {
  throw new Error('Set PIMPAMPUM_RUN_LIVE_MACOS=1 to run the reversible real macOS smoke.');
}
if (process.platform !== 'darwin') throw new Error('The macOS live smoke requires macOS.');

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let cli = join(repositoryRoot, 'dist/cli.js');
const app = join(homedir(), 'Applications/PimpampumMenuBar.app');
const launchAgent = join(homedir(), 'Library/LaunchAgents/dev.pimpampum.daemon.plist');
const launchDomain = `gui/${process.getuid()}/dev.pimpampum.daemon`;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'pimpampum-macos-live-'));
const dataDirectory = join(temporaryRoot, 'data');
const workspace = join(temporaryRoot, 'workspace');
const evidencePath = join(repositoryRoot, 'thoughts/evidence/macos-live.json');
const environment = { ...process.env, PIMPAMPUM_DATA_DIR: dataDirectory };
let installed = false;

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
  return JSON.parse(command(process.execPath, [cli, ...arguments_]));
}

async function runCliEventually(arguments_, attempts = 50) {
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

function serviceIsLoaded() {
  return spawnSync('/bin/launchctl', ['print', launchDomain], { encoding: 'utf8' }).status === 0;
}

function appProcessIsRunning() {
  return (
    spawnSync('/usr/bin/pgrep', ['-f', join(app, 'Contents/MacOS/PimpampumMenuBar')], {
      encoding: 'utf8',
    }).status === 0
  );
}

async function assertInstallationAbsent() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (
      !existsSync(app) &&
      !existsSync(launchAgent) &&
      !serviceIsLoaded() &&
      !appProcessIsRunning()
    ) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Uninstall left the app, LaunchAgent, launchd service, or app process behind.');
}

function uiSnapshot(label, options = {}) {
  const output = join(temporaryRoot, `${label}.json`);
  const png = join(temporaryRoot, `${label}.png`);
  const binary = join(app, 'Contents/MacOS/PimpampumMenuBar');
  const arguments_ = ['--ui-smoke-snapshot', output, png];
  if (options.seedOverview) arguments_.push('--seed-overview', options.seedOverview);
  if (options.openProject) arguments_.push('--open-project', options.openProject);
  rmSync(output, { force: true });
  rmSync(png, { force: true });
  command(binary, arguments_);
  if (!existsSync(output) || !existsSync(png)) {
    throw new Error(`Native UI smoke did not produce the ${label} snapshot.`);
  }
  const snapshot = JSON.parse(readFileSync(output, 'utf8'));
  const rendered = readFileSync(png);
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.renderedPngSha256 !== createHash('sha256').update(rendered).digest('hex') ||
    rendered.length < 1_000 ||
    !snapshot.accessibilityLabels.includes(snapshot.accessibilityLabel)
  ) {
    throw new Error(
      `Native UI smoke produced an invalid ${label} rendering: ${JSON.stringify(snapshot)}`,
    );
  }
  return snapshot;
}

try {
  if (existsSync(app) || existsSync(launchAgent) || serviceIsLoaded()) {
    throw new Error('Refusing live smoke because a Pimpampum user installation already exists.');
  }
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const canonicalWorkspace = realpathSync(workspace);
  writeFileSync(join(workspace, 'prd.md'), '# Live smoke PRD\n');

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
  cli = join(runtimeRoot, 'node_modules/pimpampum/dist/cli.js');

  const install = runCli('install');
  installed = true;
  const status = runCli('status');
  const empty = await runCliEventually(['overview']);
  if (!status.installed || !status.running || empty.status !== 'empty') {
    throw new Error('Installed daemon did not report the expected empty online state.');
  }
  const emptyUI = uiSnapshot('empty');
  if (
    emptyUI.visualState !== 'No projects' ||
    emptyUI.connectionState !== 'online' ||
    emptyUI.projectRows.length !== 0
  ) {
    throw new Error('Native UI did not render the expected empty state.');
  }

  runCli('workspace:add', 'live-smoke', 'Live Smoke', workspace);
  const project = runCli(
    'project:create',
    'live-smoke',
    'status-integration',
    'Status integration',
    join(workspace, 'prd.md'),
  );
  const ready = runCli('project:ready', project.id, String(project.revision));
  const claim = runCli('work:start', 'project', project.id, 'macos-live-smoke');
  const active = runCli('overview');
  if (active.status !== 'active' || active.counts.activeClaims !== 1) {
    throw new Error('Live overview did not expose the active claim.');
  }
  const activeUI = uiSnapshot('active', { openProject: project.id });
  if (
    activeUI.visualState !== 'Active' ||
    activeUI.activeCount !== 1 ||
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
    'project',
    project.id,
    'macos-live-smoke',
    String(claim.project.revision ?? ready.revision),
    'macOS live smoke complete',
  );
  const complete = runCli('overview');
  if (complete.status !== 'complete') throw new Error('Live overview did not become complete.');
  const completeUI = uiSnapshot('complete');
  if (
    completeUI.visualState !== 'All complete' ||
    completeUI.activeCount !== 0 ||
    completeUI.completedCollapsed !== true ||
    completeUI.projectRows.find((row) => row.id === project.id)?.status !== 'complete'
  ) {
    throw new Error('Native UI did not render the expected completed state.');
  }
  const seedOverview = join(temporaryRoot, 'complete-overview.json');
  writeFileSync(seedOverview, `${JSON.stringify(complete)}\n`, { mode: 0o600 });
  const backgroundOnly = command('/usr/bin/osascript', [
    '-e',
    'tell application "System Events" to get background only of first process whose bundle identifier is "dev.pimpampum.menubar"',
  ]);
  if (backgroundOnly !== 'true') throw new Error('The menu app appeared as a Dock application.');

  command('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, launchAgent]);
  const offline = spawnSync(process.execPath, [cli, 'overview'], {
    env: environment,
    encoding: 'utf8',
  });
  if (offline.status === 0) throw new Error('Overview stayed online after daemon bootout.');
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
  const recoveredUI = uiSnapshot('recovered');
  if (
    recoveredUI.visualState !== 'All complete' ||
    recoveredUI.connectionState !== 'online' ||
    recoveredUI.stale !== false
  ) {
    throw new Error('Native UI did not recover from stale to online.');
  }

  const binary = readFileSync(
    join(
      runtimeRoot,
      'node_modules/pimpampum/platforms/macos/dist/PimpampumMenuBar.app/Contents/MacOS/PimpampumMenuBar',
    ),
  );
  const removal = runCli('uninstall');
  if (removal.uninstalled !== true) {
    throw new Error(`Uninstall did not acknowledge complete removal: ${JSON.stringify(removal)}`);
  }
  installed = false;
  await assertInstallationAbsent();

  const evidence = {
    schemaVersion: 1,
    testedAt: new Date().toISOString(),
    platform: 'macOS',
    architecture: 'arm64',
    appSha256: createHash('sha256').update(binary).digest('hex'),
    loginItem: install.loginItem,
    checks: {
      empty: true,
      activeClaim: true,
      completion: true,
      daemonOffline: true,
      nativePopoverRendering: true,
      staleRecovery: true,
      projectRowActivation: true,
      finderRevealExactPath: true,
      noDockIcon: true,
      repeatInstallRecovery: recovered.reconciled === true,
      uninstallCleanup: true,
    },
    renderings: {
      empty: emptyUI.renderedPngSha256,
      active: activeUI.renderedPngSha256,
      complete: completeUI.renderedPngSha256,
      stale: staleUI.renderedPngSha256,
      recovered: recoveredUI.renderedPngSha256,
    },
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  if (installed) {
    const removal = spawnSync(process.execPath, [cli, 'uninstall'], {
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
  if (!existsSync(launchAgent) && !existsSync(app)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
