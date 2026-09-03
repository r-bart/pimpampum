#!/usr/bin/env node

// Runs the packaged runtime the way a user gets it: `dist/` with no build tree beside it, on a
// host that looks like Omarchy. Every fixture in `test/` builds the checkout shape instead, which
// is how a CLI that failed *every* command on Omarchy — `version` and `help` included — shipped in
// v1.2.11 and was only found by installing v1.3.0 by hand. This runs on every push.
//
//   check-packaged-delivery.mjs <runtime-bundles-root> [--target linux-x64|linux-arm64]
//
// The bundles root is what `build-runtime-bundle.mjs --output` wrote, or what the `runtime` job
// uploads. Nothing here needs systemd, a desktop, or the network: it exercises the paths that
// differ between a checkout and an installation, which is where all of them hid.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'dev.pimpampum.status';
const TARGETS = ['linux-x64', 'linux-arm64'];
const checks = [];

function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  process.stdout.write(`${passed ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function parseArguments(argv) {
  const positional = [];
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--target') {
      target = argv[index + 1];
      index += 1;
    } else positional.push(argv[index]);
  }
  if (positional.length !== 1) {
    throw new Error('usage: check-packaged-delivery.mjs <runtime-bundles-root> [--target <id>]');
  }
  if (target !== null && !TARGETS.includes(target)) {
    throw new Error(`unsupported target: ${String(target)}`);
  }
  return { bundlesRoot: resolve(positional[0]), target };
}

/** The bundle directory `build-runtime-bundle.mjs` or the `runtime` CI job produced. */
function findArchive(bundlesRoot, version, target) {
  for (const directory of [
    join(bundlesRoot, `pimpampum-runtime-${version}-${target}`),
    join(bundlesRoot, `runtime-${target}`),
    bundlesRoot,
  ]) {
    const archive = join(directory, `pimpampum-runtime-${version}-${target}.tar.gz`);
    if (existsSync(archive)) return archive;
  }
  throw new Error(`no runtime archive for ${target} under ${bundlesRoot}`);
}

/**
 * An `omarchy` and an `omarchy-shell` that answer exactly what the adapter asks. The point is not
 * to simulate Omarchy; it is to make the CLI take its Omarchy code path, which is the one that
 * only exists on a user's machine and therefore never ran in CI.
 */
function writeOmarchyStubs(binDirectory, pluginTarget) {
  mkdirSync(binDirectory, { recursive: true });
  const omarchy = join(binDirectory, 'omarchy');
  writeFileSync(
    omarchy,
    `#!/bin/sh
case "$1 $2" in
  "version ") echo "4.0.1-1"; exit 0 ;;
  "plugin list") [ -d ${JSON.stringify(pluginTarget)} ] && echo "${PLUGIN_ID} enabled third-party bar-widget Pimpampum Status"; exit 0 ;;
  "plugin validate") exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const shell = join(binDirectory, 'omarchy-shell');
  writeFileSync(shell, '#!/bin/sh\necho ok\nexit 0\n', { mode: 0o755 });
  chmodSync(omarchy, 0o755);
  chmodSync(shell, 0o755);
}

function runPackaged(runtimeRoot, home, arguments_) {
  const result = spawnSync(
    join(runtimeRoot, 'bin', 'node'),
    [join(runtimeRoot, 'dist', 'cli.js'), ...arguments_],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: `${join(home, 'stub-bin')}:/usr/bin:/bin`,
        HOME: home,
        PIMPAMPUM_DATA_DIR: join(home, '.pimpampum'),
      },
    },
  );
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseEnvelope(result) {
  try {
    return JSON.parse(`${result.stdout}${result.stderr}`.trim());
  } catch {
    return null;
  }
}

/** The shape a user runs: the payload extracted, with no `integrations/` beside `dist/`. */
function stagePackagedRuntime(archive, root) {
  mkdirSync(root, { recursive: true });
  execFileSync('/usr/bin/tar', ['xzf', archive, '-C', root]);
  const runtimeRoot = join(root, 'payload');
  if (!existsSync(join(runtimeRoot, 'dist', 'cli.js'))) {
    throw new Error('runtime archive has no dist/cli.js');
  }
  if (existsSync(join(runtimeRoot, 'integrations'))) {
    throw new Error('runtime archive unexpectedly carries a build tree');
  }
  return runtimeRoot;
}

function stageHome(root) {
  const home = join(root, 'home');
  const data = join(home, '.pimpampum');
  const pluginTarget = join(home, '.config', 'omarchy', 'plugins', PLUGIN_ID);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  chmodSync(data, 0o700);
  // What `omarchy plugin add` leaves behind: the plugin checkout, and nothing else of ours.
  cpSync(join(repositoryRoot, 'integrations', 'omarchy', 'pimpampum-status'), pluginTarget, {
    recursive: true,
  });
  writeOmarchyStubs(join(home, 'stub-bin'), pluginTarget);
  return { home, data, pluginTarget };
}

function pluginFileInodes(pluginTarget) {
  return readdirSync(pluginTarget)
    .map((name) => join(pluginTarget, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => `${path}:${String(statSync(path).ino)}`)
    .sort();
}

/** Read-only verbs must answer on an Omarchy host from a packaged runtime. */
function checkReadOnlyVerbs(runtimeRoot, home, version) {
  for (const verb of ['version', 'help', 'commands']) {
    const result = runPackaged(runtimeRoot, home, [verb]);
    check(
      `packaged \`${verb}\` answers on an Omarchy host`,
      result.exitCode === 0,
      result.stderr.trim().slice(0, 160),
    );
  }
  const versionEnvelope = parseEnvelope(runPackaged(runtimeRoot, home, ['version']));
  check(
    'packaged `version` reports the bundled release',
    versionEnvelope?.data?.version === version,
    `expected ${version}, got ${String(versionEnvelope?.data?.version)}`,
  );
  const status = runPackaged(runtimeRoot, home, ['status']);
  const statusEnvelope = parseEnvelope(status);
  check(
    'packaged `status` answers instead of failing to construct its adapter',
    status.exitCode === 0 && statusEnvelope?.data !== undefined,
    String(statusEnvelope?.error?.message ?? '').slice(0, 160),
  );
}

/** The setup plan both native surfaces render verbatim; a platform word here reaches the other. */
function checkSetupPlanCopy(runtimeRoot, home) {
  const plan = parseEnvelope(runPackaged(runtimeRoot, home, ['setup', 'plan']));
  const changes = plan?.data?.changes;
  check(
    'packaged `setup plan` answers',
    Array.isArray(changes),
    String(plan?.error?.message ?? '').slice(0, 160),
  );
  if (!Array.isArray(changes)) return;
  const platformWords = changes
    .map((change) => String(change?.summary ?? ''))
    .filter((summary) => /\b(mac|macos|windows|linux|omarchy)\b/iu.test(summary));
  check(
    'the shared setup plan names no single platform',
    platformWords.length === 0,
    platformWords.join(' | ').slice(0, 160),
  );
}

/** The plugin directory is Omarchy's; a planning read of it must never rewrite it. */
function checkPluginIsNotRewritten(runtimeRoot, home, pluginTarget) {
  const before = pluginFileInodes(pluginTarget);
  check(
    'the staged plugin has files to watch',
    before.length > 10,
    `${String(before.length)} files`,
  );
  runPackaged(runtimeRoot, home, ['status']);
  runPackaged(runtimeRoot, home, ['setup', 'plan']);
  const after = pluginFileInodes(pluginTarget);
  check(
    'reading the installation leaves every plugin file untouched',
    JSON.stringify(before) === JSON.stringify(after),
    'inodes changed',
  );
}

/** The bootstrap must refuse a bad archive and leave nothing behind. */
function checkBootstrapRejections(root, pluginTarget, archive, version) {
  const bootstrap = join(pluginTarget, 'pimpampum-bootstrap');
  const manifestPath = join(pluginTarget, 'runtime-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const badManifest = join(root, 'bad-hash.json');
  const poisoned = JSON.parse(JSON.stringify(manifest));
  for (const target of TARGETS) {
    poisoned.targets[target].sha256 = `${'0'.repeat(63)}1`;
  }
  writeFileSync(badManifest, `${JSON.stringify(poisoned, null, 2)}\n`);

  const truncated = join(root, 'truncated.tar.gz');
  writeFileSync(truncated, readFileSync(archive).subarray(0, 4096));

  const unsupportedUname = join(root, 'uname-ppc');
  writeFileSync(
    unsupportedUname,
    '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo ppc64le ;; esac\n',
    {
      mode: 0o755,
    },
  );
  chmodSync(unsupportedUname, 0o755);

  const cases = [
    [
      'a mismatched archive hash',
      { PIMPAMPUM_BOOTSTRAP_MANIFEST: badManifest, PIMPAMPUM_BOOTSTRAP_ARCHIVE: archive },
    ],
    ['a truncated download', { PIMPAMPUM_BOOTSTRAP_ARCHIVE: truncated }],
    [
      'an unsupported architecture',
      { PIMPAMPUM_BOOTSTRAP_UNAME: unsupportedUname, PIMPAMPUM_BOOTSTRAP_ARCHIVE: archive },
    ],
  ];
  for (const [label, extraEnvironment] of cases) {
    const home = mkdtempSync(join(root, 'reject-home-'));
    const result = spawnSync(bootstrap, [], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: '/usr/bin:/bin', HOME: home, ...extraEnvironment },
    });
    const installed = join(home, '.local', 'share', 'pimpampum', 'runtime', version);
    const target = TARGETS.map((id) => join(installed, id)).some((path) => existsSync(path));
    check(
      `the bootstrap refuses ${label}`,
      result.status !== 0 && !target,
      `exit ${String(result.status)}; ${(result.stderr ?? '').trim().slice(0, 120)}`,
    );
  }
}

function main() {
  const { bundlesRoot, target } = parseArguments(process.argv.slice(2));
  const version = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).version;
  const selected = target ?? (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
  const archive = findArchive(bundlesRoot, version, selected);
  process.stdout.write(
    `packaged delivery check: ${selected} ${version} (${createHash('sha256').update(readFileSync(archive)).digest('hex').slice(0, 12)}…)\n`,
  );
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-packaged-'));
  try {
    const runtimeRoot = stagePackagedRuntime(archive, join(root, 'runtime'));
    const { home, pluginTarget } = stageHome(root);
    checkReadOnlyVerbs(runtimeRoot, home, version);
    checkSetupPlanCopy(runtimeRoot, home);
    checkPluginIsNotRewritten(runtimeRoot, home, pluginTarget);
    checkBootstrapRejections(root, pluginTarget, archive, version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const failed = checks.filter((entry) => !entry.passed);
  process.stdout.write(
    `\n${String(checks.length - failed.length)}/${String(checks.length)} packaged delivery checks passed\n`,
  );
  if (failed.length > 0) {
    throw new Error(
      `packaged delivery check failed: ${failed.map((entry) => entry.name).join('; ')}`,
    );
  }
}

main();
