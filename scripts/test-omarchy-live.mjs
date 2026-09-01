#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { executableHelpers } from './check-omarchy-delivery.mjs';

const PLUGIN_ID = 'dev.pimpampum.status';
const SCREENSHOT_NAMES = [
  'activePopout',
  'completedPopout',
  'offlineStale',
  'recovered',
  'workspaceOpen',
];
const TASK_3_3_CAPTURE_GUIDANCE = Object.freeze({
  activePopout:
    'Keep the fixed circle-p mark visible with the active treatment outside it. Use the horizontal bar, open the bounded popout, and exercise project hover, keyboard focus, and activation before capture.',
  completedPopout:
    'Switch through the supported Quattro UI to the vertical bar and alternate light/dark theme, then show completed work and exercise its disclosure plus the collapsed Backup disclosure. Do not edit shell.json or QML; restore the original layout and theme before continuing.',
  offlineStale:
    'Show stale cached content and the urgent external error treatment while the fixed circle-p identity remains unchanged; it must not become an x, exclamation mark, or Wi-Fi glyph.',
  recovered:
    'Show the same fixed identity after recovery, with live content restored and no stale or offline message.',
  workspaceOpen:
    'Exercise mouse and keyboard activation where Quickshell supports it, then use the project row in the Pimpampum QML popout to open the workspace.',
});
export const TASK_3_3_REVIEW_MATRIX = Object.freeze([
  'Fixed circle-p identity and theme-foreground tint in every state; status is carried only by the external accent and shape.',
  'Horizontal side-by-side and vertical stacked bar layouts, using inherited Quattro geometry and theme tokens.',
  'Counts 7, 42, and 99+ (for 100 or more); zero hidden and negative source values clamped to zero.',
  'Light and dark themes.',
  'Complete, available, active/draft, empty, offline, stale, and credentials states.',
  'Hover plus visible keyboard focus and activation where Quickshell supports them.',
  'Bounded scrolling, long-content elision/disambiguation, completed disclosure, and safe workspace opening.',
  'Portfolio-to-Settings navigation inside the same bounded popout, keyboard-accessible back navigation, and no competing Quattro popout.',
  'Backup settings shown directly without nested disclosure; unconfigured, healthy, backing-up, and failed states; exact destination preview; explicit enable/disable confirmation; configure/retry/disable serialization and native folder-dialog behavior.',
  'Synchronization settings shown directly without nested disclosure; unconfigured, healthy, pending, paused, unavailable, failed, and conflicted states; provider-location selection; effective Pimpampum destination preview; explicit enable/forget confirmation; device identity, timestamps, pending count, open-folder, sync-now, and pause/resume behavior.',
]);
// States the reviewer is NOT asked to observe live, because a healthy installation cannot hold
// them long enough to be seen, or cannot produce them at all. Each stays covered by automated
// tests; listing them here keeps that exclusion explicit in the prompt and in the evidence binding.
export const TASK_3_3_AUTOMATED_ONLY = Object.freeze([
  'incompatible: the daemon pins overview schemaVersion 2 (overviewContract.ts), so a healthy installation can never emit another version; covered by test/service-omarchy.test.ts and test/omarchy-plugin.test.ts.',
  'importing and exporting: set and cleared inside one local filesystem operation (syncController.ts), so a poll observes them only by chance; covered by the sync controller tests.',
]);
export const TASK_6_2_SCENARIOS = Object.freeze([
  'bootstrap-no-node',
  'connect-codex',
  'connect-claude-code',
  'reject-wrong-architecture',
  'reject-wrong-hash',
  'reject-offline-download',
  'reject-interrupted-download',
  'quickshell-restart-preserves-daemon-and-connectors',
  'packaged-update-preserves-connectors',
  'receipt-owned-removal-preserves-data',
]);
const COMMAND_TIMEOUT_MS = 30_000;

function hash(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

/**
 * Task 6.2 is deliberately separate from the human Quattro screenshot artifact. Its injected
 * scenario boundary is implemented by the native-target harness and fixture tests; this
 * orchestrator owns exact ordering, duration bounds, hash binding, cleanup, and fail-closed output.
 */
export function createTask62LiveRunner(dependencies) {
  return {
    async run(input) {
      if (dependencies.environment.PIMPAMPUM_OMARCHY_DELIVERY_LIVE !== '1') {
        throw new Error('Set PIMPAMPUM_OMARCHY_DELIVERY_LIVE=1 for the Task 6.2 target smoke');
      }
      if (dependencies.platform !== 'linux' || dependencies.uid === 0) {
        throw new Error('Task 6.2 target smoke requires rootless Linux');
      }
      const candidatePath = requireAbsolute(input.candidatePath, 'Candidate path');
      const evidencePath = requireAbsolute(input.evidencePath, 'Evidence path');
      const target = input.target;
      if (target !== 'linux-x64' && target !== 'linux-arm64') {
        throw new Error('Task 6.2 target must be linux-x64 or linux-arm64');
      }
      const delivery = await dependencies.validateDelivery(candidatePath);
      if (
        !exactKeys(delivery, ['runtimeVersion', 'runtimeManifestSha256', 'artifactSha256']) ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(delivery.runtimeVersion) ||
        !/^[a-f0-9]{64}$/u.test(delivery.runtimeManifestSha256) ||
        !/^[a-f0-9]{64}$/u.test(delivery.artifactSha256)
      ) {
        throw new Error('Task 6.2 delivery validation returned an invalid hash binding');
      }
      const commit = await dependencies.repositoryCommit();
      if (!/^[a-f0-9]{40}$/u.test(commit)) {
        throw new Error('Task 6.2 evidence requires an exact repository commit');
      }
      const preservedBeforeSha256 = await dependencies.preservedDataSha256();
      if (!/^[a-f0-9]{64}$/u.test(preservedBeforeSha256)) {
        throw new Error('Task 6.2 preserved-data baseline hash is invalid');
      }
      const startedAt = dependencies.now();
      const scenarios = [];
      let cleanupPromise;
      const cleanupOnce = async () => {
        cleanupPromise ??= Promise.resolve().then(() => dependencies.cleanup());
        return cleanupPromise;
      };
      let preservedAfterSha256;
      let cleanup;
      try {
        for (const id of TASK_6_2_SCENARIOS) {
          const scenarioStartedAt = dependencies.now();
          const result = await dependencies.runScenario({
            id,
            target,
            candidatePath,
            runtimeVersion: delivery.runtimeVersion,
            artifactSha256: delivery.artifactSha256,
          });
          const scenarioFinishedAt = dependencies.now();
          const durationMs = scenarioFinishedAt.getTime() - scenarioStartedAt.getTime();
          if (
            !exactKeys(result, ['passed', 'observed']) ||
            result.passed !== true ||
            typeof result.observed !== 'string' ||
            result.observed.length === 0 ||
            result.observed.length > 512 ||
            !Number.isSafeInteger(durationMs) ||
            durationMs < 0 ||
            durationMs > 10 * 60_000
          ) {
            throw new Error(`Task 6.2 scenario did not pass safely: ${id}`);
          }
          scenarios.push({
            id,
            passed: true,
            observed: result.observed,
            startedAt: scenarioStartedAt.toISOString(),
            finishedAt: scenarioFinishedAt.toISOString(),
            durationMs,
          });
        }
        preservedAfterSha256 = await dependencies.preservedDataSha256();
        if (preservedAfterSha256 !== preservedBeforeSha256) {
          throw new Error('Task 6.2 removal changed preserved user data');
        }
        cleanup = await cleanupOnce();
        if (!exactKeys(cleanup, ['completed']) || cleanup.completed !== true) {
          throw new Error('Task 6.2 cleanup did not complete');
        }
      } catch (error) {
        try {
          await cleanupOnce();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Task 6.2 run and cleanup failed');
        }
        throw error;
      }
      const finishedAt = dependencies.now();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 60 * 60_000) {
        throw new Error('Task 6.2 overall duration is invalid');
      }
      const evidence = {
        schemaVersion: 1,
        status: 'passed',
        explicitOptIn: true,
        commit,
        target,
        runtimeVersion: delivery.runtimeVersion,
        runtimeManifestSha256: delivery.runtimeManifestSha256,
        artifactSha256: delivery.artifactSha256,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        scenarios,
        preservedData: {
          beforeSha256: preservedBeforeSha256,
          afterSha256: preservedAfterSha256,
          unchanged: true,
        },
        cleanup,
      };
      dependencies.writeEvidenceAtomic(evidencePath, evidence);
      return evidence;
    },
  };
}

function requireAbsolute(path, label) {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function canonicalCandidateHash(directory) {
  const files = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (name === '.git') continue;
      const path = join(current, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`Candidate contains a symlink: ${path}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error(`Candidate contains a non-regular file: ${path}`);
    }
  };
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('Quattro candidate must be a real directory');
  }
  visit(directory);
  const digest = createHash('sha256');
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    const contents = readFileSync(path);
    digest.update(relative(directory, path).split(sep).join('/'));
    digest.update('\0');
    digest.update(String(contents.length));
    digest.update('\0');
    digest.update(contents);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function assertCandidateUnchanged(candidatePath, expectedHash, stage) {
  const actualHash = canonicalCandidateHash(candidatePath);
  if (actualHash !== expectedHash) {
    throw new Error(`Quattro candidate changed ${stage}`);
  }
}

function ensureSafeEvidencePath(evidencePath, allowedRoot, trustedAnchor) {
  const root = requireAbsolute(allowedRoot, 'Allowed evidence root');
  const anchor = requireAbsolute(trustedAnchor, 'Trusted evidence anchor');
  const rootFromAnchor = relative(anchor, root);
  if (
    rootFromAnchor === '..' ||
    rootFromAnchor.startsWith(`..${sep}`) ||
    isAbsolute(rootFromAnchor)
  ) {
    throw new Error('Allowed evidence root must be contained by the trusted anchor');
  }
  const child = relative(root, evidencePath);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Evidence path must be contained by the allowed evidence root');
  }
  let current = anchor;
  const segments = relative(anchor, dirname(evidencePath)).split(sep).filter(Boolean);
  for (const segment of ['', ...segments]) {
    if (segment) current = join(current, segment);
    if (!existsSync(current)) {
      const fromRoot = relative(root, current);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error(`Trusted evidence ancestor does not exist: ${current}`);
      }
      mkdirSync(current);
      continue;
    }
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Evidence ancestor must be a real directory: ${current}`);
    }
  }
}

function makeTreeReadOnly(root) {
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`Immutable stage contains a symlink: ${path}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) chmodSync(path, 0o400);
      else throw new Error(`Immutable stage contains a non-regular file: ${path}`);
    }
  };
  visit(root);
  for (const directory of directories.reverse()) chmodSync(directory, 0o500);
}

function makeTreeWritable(root) {
  if (!existsSync(root)) return;
  const visit = (directory) => {
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) visit(path);
    }
  };
  visit(root);
}

function invalidateExistingEvidence(evidencePath) {
  if (!existsSync(evidencePath)) return null;
  const metadata = lstatSync(evidencePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Existing canonical evidence is unsafe: ${evidencePath}`);
  }
  const archivedPath = `${evidencePath}.invalidated-${Date.now()}-${randomUUID()}`;
  renameSync(evidencePath, archivedPath);
  return archivedPath;
}

function parseObject(stdout, label) {
  try {
    const value = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

/**
 * Pimpampum CLI success is always exactly one {"data": ...} object. Unwrapping here keeps the live
 * runner honest about the contract instead of silently reading undefined fields off the envelope.
 */
function parseCliObject(stdout, label) {
  const envelope = parseObject(stdout, label);
  if (Object.keys(envelope).length !== 1 || !('data' in envelope)) {
    throw new Error(`${label} did not return one data envelope`);
  }
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${label} returned a non-object data payload`);
  }
  return data;
}

function parseOptionalJson(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error('baseline probe returned invalid JSON', { cause: error });
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readPng(path, label) {
  const metadata = lstatSync(path);
  const contents = readFileSync(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    contents.length < 1_000 ||
    !contents.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    throw new Error(`${label} is not a substantial regular PNG: ${path}`);
  }
  return contents;
}

function ensurePng(path, artifactRoot) {
  const absolute = realpathSync(path);
  const child = relative(realpathSync(artifactRoot), absolute);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Screenshot escaped its artifact directory: ${path}`);
  }
  return readPng(path, 'Screenshot');
}

function ensureRealDirectory(path, label) {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`${label} must be a regular directory`);
    }
    return;
  }
  mkdirSync(path, { recursive: true });
}

function writeArtifactAtomic(path, contents) {
  const directory = dirname(path);
  ensureRealDirectory(directory, 'Artifact directory');
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Refusing to replace an unsafe artifact: ${path}`);
    }
  }
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function mergeProbeSnapshot(snapshot, shell, plugins, systemd) {
  const merged = structuredClone(snapshot);
  const shellValue = parseOptionalJson(shell.stdout);
  const pluginsValue = parseOptionalJson(plugins.stdout);
  if (shellValue) merged.shellConfig = shellValue;
  if (pluginsValue) {
    const entries = Array.isArray(pluginsValue) ? pluginsValue : pluginsValue.plugins;
    if (Array.isArray(entries)) {
      merged.plugin = {
        exists: entries.some((entry) => entry?.id === PLUGIN_ID),
      };
    }
  }
  if (systemd.stdout.trim()) {
    merged.service = {
      ...merged.service,
      unitExists: !/^LoadState=not-found$/mu.test(systemd.stdout),
      enabled: /^UnitFileState=enabled$/mu.test(systemd.stdout),
      running: /^ActiveState=active$/mu.test(systemd.stdout),
    };
  }
  return merged;
}

export default function createLiveRunner(dependencies) {
  return {
    async run(input) {
      const candidatePath = requireAbsolute(input.candidatePath, 'Candidate path');
      const evidencePath = requireAbsolute(input.evidencePath, 'Evidence path');
      const cliPath = requireAbsolute(input.cliPath, 'CLI path');
      const allowedEvidenceRoot = requireAbsolute(
        dependencies.allowedEvidenceRoot ?? dirname(evidencePath),
        'Allowed evidence root',
      );
      const trustedEvidenceAnchor = requireAbsolute(
        dependencies.trustedEvidenceAnchor ?? allowedEvidenceRoot,
        'Trusted evidence anchor',
      );
      if (dependencies.environment.PIMPAMPUM_QUATTRO_LIVE !== '1') {
        throw new Error('Set PIMPAMPUM_QUATTRO_LIVE=1 to run the real Quattro smoke');
      }
      if (dependencies.platform !== 'linux') throw new Error('Quattro live smoke requires Linux');
      if (!Number.isInteger(dependencies.uid) || dependencies.uid === 0) {
        throw new Error('Quattro live smoke requires a non-root user');
      }
      if (!dependencies.environment.WAYLAND_DISPLAY?.trim()) {
        throw new Error('Quattro live smoke requires an active Wayland session');
      }
      if (dependencies.existingPaths.length > 0) {
        throw new Error(
          `Refusing live smoke because a Pimpampum installation already exists: ${dependencies.existingPaths.join(', ')}`,
        );
      }
      ensureSafeEvidencePath(evidencePath, allowedEvidenceRoot, trustedEvidenceAnchor);
      const productionCandidate = existsSync(join(candidatePath, '.pimpampum-plugin-owner.json'));
      const initialCandidateHash = canonicalCandidateHash(candidatePath);
      const transcript = [];
      const screenshots = {};
      const screenshotSourceHashes = {};
      const workspace = input.workspacePath
        ? requireAbsolute(input.workspacePath, 'Workspace path')
        : dirname(candidatePath);
      let installAttempted = false;
      let before = null;
      let after = null;
      let operationError = null;
      let cleanupError = null;
      let interrupted = null;
      let cleanupPromise = null;
      let unregisterSignalHandler = () => {};
      let immutableInstall = null;
      let activeCliPath = cliPath;

      const execute = async (
        label,
        executable,
        arguments_,
        allowedExitCodes = [0],
        allowDuringCleanup = false,
        allowBackground = false,
      ) => {
        if (interrupted && !allowDuringCleanup) throw interrupted;
        const startedAt = dependencies.now().toISOString();
        const result = await dependencies.execute({
          label,
          executable,
          arguments: [...arguments_],
          timeoutMs: COMMAND_TIMEOUT_MS,
          allowBackground,
        });
        const entry = {
          label,
          executable,
          arguments: [...arguments_],
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          startedAt,
          finishedAt: dependencies.now().toISOString(),
        };
        transcript.push(entry);
        if (interrupted && !allowDuringCleanup) throw interrupted;
        if (!allowedExitCodes.includes(result.exitCode)) {
          throw new Error(
            `${label} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
          );
        }
        return entry;
      };
      const cli = (label, arguments_, allowDuringCleanup = false) =>
        execute(label, process.execPath, [activeCliPath, ...arguments_], [0], allowDuringCleanup);
      const captureState = async (name, context) => {
        const matrixPrompt =
          name === 'activePopout'
            ? `Before taking the five canonical captures, directly exercise every item in this live matrix through supported Omarchy controls and Pimpampum's public CLI/API; do not infer a state from static validation: ${TASK_3_3_REVIEW_MATRIX.join(' ')} Not required live, covered by automated tests only: ${TASK_3_3_AUTOMATED_ONLY.join(' ')}`
            : '';
        const guidedContext = {
          ...context,
          instruction: [matrixPrompt, context?.instruction, TASK_3_3_CAPTURE_GUIDANCE[name]]
            .filter(Boolean)
            .join(' '),
        };
        if (!productionCandidate) {
          screenshots[name] = await dependencies.captureScreenshot(name, guidedContext);
        } else {
          if (
            typeof dependencies.prepareScreenshot !== 'function' ||
            typeof dependencies.resolveScreenshotPath !== 'function'
          ) {
            throw new Error('Production candidate capture requires transcript-aware screenshot IO');
          }
          await dependencies.prepareScreenshot(name, guidedContext);
          const captured = await execute(`screenshot-${name}`, 'omarchy', [
            'capture',
            'screenshot',
            'fullscreen',
            'save',
          ]);
          screenshots[name] = dependencies.resolveScreenshotPath(captured.stdout, name);
        }
        const source = requireAbsolute(screenshots[name], `${name} screenshot`);
        screenshotSourceHashes[name] = hash(readPng(source, `${name} screenshot`));
      };
      const probes = async (phase, allowDuringCleanup = false) => {
        const shell = await execute(
          `baseline-${phase}-shell`,
          'omarchy-shell',
          ['shell', 'listShellConfig'],
          [0],
          allowDuringCleanup,
        );
        const plugins = await execute(
          `baseline-${phase}-plugins`,
          'omarchy',
          ['plugin', 'list', '--json'],
          [0],
          allowDuringCleanup,
        );
        const systemd = await execute(
          `baseline-${phase}-systemd`,
          'systemctl',
          ['--user', 'show', 'pimpampum.service', '--property=LoadState,UnitFileState,ActiveState'],
          [0, 1, 3, 4],
          allowDuringCleanup,
        );
        return mergeProbeSnapshot(await dependencies.snapshotBaseline(), shell, plugins, systemd);
      };
      const cleanupOnce = () => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
          if (installAttempted) {
            try {
              const removal = parseCliObject(
                (await cli('uninstall', ['uninstall'], true)).stdout,
                'uninstall',
              );
              if (removal.uninstalled !== true) {
                cleanupError = new Error('Uninstall did not complete');
              }
            } catch (error) {
              cleanupError = error;
            }
          }
          if (before) {
            try {
              after = await probes('after', true);
              if (!sameJson(before, after)) {
                const mismatch = new Error('Live smoke cleanup did not restore the exact baseline');
                cleanupError = cleanupError
                  ? new AggregateError([cleanupError, mismatch], 'Quattro live cleanup failed')
                  : mismatch;
              }
            } catch (error) {
              cleanupError = cleanupError
                ? new AggregateError([cleanupError, error], 'Quattro live cleanup failed')
                : error;
            }
          }
        })();
        return cleanupPromise;
      };
      const writeFailureDiagnostic = (errors) => {
        const diagnosticPath = join(
          dirname(evidencePath),
          `.quattro-live-failure-${randomUUID()}.json`,
        );
        writeArtifactAtomic(
          diagnosticPath,
          json({
            schemaVersion: 1,
            failedAt: dependencies.now().toISOString(),
            errors: errors.map((error) => String(error?.stack ?? error)),
            transcript,
            before,
            after,
          }),
        );
      };

      if (typeof dependencies.registerSignalHandler === 'function') {
        unregisterSignalHandler = dependencies.registerSignalHandler(async (signal) => {
          if (!interrupted) interrupted = new Error(`Quattro live smoke interrupted by ${signal}`);
          await dependencies.abortActiveCommands?.();
          await cleanupOnce();
        });
      }

      try {
        const version = await execute('version', 'omarchy', ['version']);
        if (!/\b(?:Quattro|4(?:\.|\b))/iu.test(version.stdout)) {
          throw new Error(`Unsupported Omarchy build: ${version.stdout.trim() || 'unknown'}`);
        }
        if (productionCandidate) {
          if (typeof dependencies.prepareImmutableInstall !== 'function') {
            throw new Error('Production candidate install requires an immutable staged runtime');
          }
          immutableInstall = await dependencies.prepareImmutableInstall({
            candidatePath,
            cliPath,
            expectedCandidateHash: initialCandidateHash,
          });
          activeCliPath = requireAbsolute(immutableInstall.cliPath, 'Immutable staged CLI path');
          const stagedCandidatePath = requireAbsolute(
            immutableInstall.candidatePath,
            'Immutable staged candidate path',
          );
          if (canonicalCandidateHash(stagedCandidatePath) !== initialCandidateHash) {
            throw new Error('Immutable staged candidate does not match the validated candidate');
          }
        }
        await execute('validation', 'omarchy', ['plugin', 'validate', candidatePath]);
        assertCandidateUnchanged(candidatePath, initialCandidateHash, 'after validation');
        if (productionCandidate) {
          await execute('validation-snapshot', 'omarchy', [
            'plugin',
            'validate',
            immutableInstall.candidatePath,
          ]);
          if (canonicalCandidateHash(immutableInstall.candidatePath) !== initialCandidateHash) {
            throw new Error('Immutable staged candidate changed during authoritative validation');
          }
        }
        before = await probes('before');
        invalidateExistingEvidence(evidencePath);
        assertCandidateUnchanged(candidatePath, initialCandidateHash, 'before install');

        installAttempted = true;
        const installResult = parseCliObject((await cli('install', ['install'])).stdout, 'install');
        if (productionCandidate) {
          if (typeof dependencies.verifyInstalledCandidate !== 'function') {
            throw new Error(
              'Production install requires exact receipt-owned artifact verification',
            );
          }
          await dependencies.verifyInstalledCandidate({
            stagedCandidatePath: immutableInstall.candidatePath,
            expectedCandidateHash: initialCandidateHash,
            receiptPath: installResult.receiptPath,
            cliPath: activeCliPath,
          });
        }
        assertCandidateUnchanged(candidatePath, initialCandidateHash, 'after install');
        const online = parseCliObject((await cli('status-online', ['status'])).stdout, 'status');
        if (online.running !== true) throw new Error('Installed Pimpampum daemon is not running');
        const specBodyPath = resolve(dirname(activeCliPath), '..', 'README.md');

        await cli('seed-workspace', ['workspace:add', 'live', 'Pimpampum', workspace]);
        const activeProject = parseCliObject(
          (
            await cli('seed-project', [
              'project:create',
              'live',
              'omarchy-plugin',
              'Omarchy plugin',
            ])
          ).stdout,
          'active project creation',
        );
        const activeSpec = parseCliObject(
          (
            await cli('seed-active-spec', [
              'spec:create',
              String(activeProject.id),
              'widget-v1',
              'Widget V1',
              specBodyPath,
            ])
          ).stdout,
          'active Spec creation',
        );
        parseCliObject(
          (
            await cli('ready-active-spec', [
              'spec:ready',
              String(activeSpec.id),
              String(activeSpec.revision),
            ])
          ).stdout,
          'active Spec ready',
        );
        parseCliObject(
          (
            await cli('open-active-project', [
              'project:open',
              String(activeProject.id),
              String(activeProject.revision),
            ])
          ).stdout,
          'active project open',
        );
        const task = parseCliObject(
          (await cli('seed-task', ['task:create', String(activeSpec.id), 'Polish widget design']))
            .stdout,
          'task creation',
        );
        await cli('seed-claim', ['work:start', 'task', String(task.id), 'live-agent']);
        const completeProject = parseCliObject(
          (
            await cli('seed-completed-project', [
              'project:create',
              'live',
              'completed',
              'Completed',
            ])
          ).stdout,
          'completed project creation',
        );
        const completeSpec = parseCliObject(
          (
            await cli('seed-completed-spec', [
              'spec:create',
              String(completeProject.id),
              'completed-spec',
              'Completed Spec',
              specBodyPath,
            ])
          ).stdout,
          'completed Spec creation',
        );
        const completeReady = parseCliObject(
          (
            await cli('ready-completed-spec', [
              'spec:ready',
              String(completeSpec.id),
              String(completeSpec.revision),
            ])
          ).stdout,
          'completed Spec ready',
        );
        const completeOpen = parseCliObject(
          (
            await cli('open-completed-project', [
              'project:open',
              String(completeProject.id),
              String(completeProject.revision),
            ])
          ).stdout,
          'completed project open',
        );
        const completeClaim = parseCliObject(
          (
            await cli('start-completed-spec', [
              'work:start',
              'spec',
              String(completeSpec.id),
              'completion-agent',
            ])
          ).stdout,
          'completed Spec claim',
        );
        await cli('complete-spec', [
          'work:complete',
          'spec',
          String(completeSpec.id),
          'completion-agent',
          String(completeClaim.spec?.revision ?? completeClaim.revision ?? completeReady.revision),
          'Complete',
        ]);
        await cli('complete-project', [
          'project:complete',
          String(completeProject.id),
          String(completeOpen.revision),
          'Complete',
        ]);
        const overview = parseCliObject(
          (await cli('overview-active-and-complete', ['overview'])).stdout,
          'overview',
        );
        if (
          !Array.isArray(overview.projects) ||
          !overview.projects.some((project) => project?.status === 'active') ||
          !overview.projects.some((project) => project?.status === 'complete')
        ) {
          throw new Error('Seeded overview did not contain active and completed projects');
        }

        await execute('hot-reload', 'omarchy-shell', ['shell', 'rescanPlugins']);
        let pluginLoaded = false;
        for (let attempt = 0; attempt < 50 && !pluginLoaded; attempt += 1) {
          const loadedOutput = (
            await execute('post-rescan-plugin-loaded', 'omarchy', ['plugin', 'list', '--json'])
          ).stdout;
          const loaded = parseOptionalJson(loadedOutput);
          const plugins = Array.isArray(loaded) ? loaded : loaded?.plugins;
          pluginLoaded =
            Array.isArray(plugins) && plugins.some((plugin) => plugin?.id === PLUGIN_ID);
          if (!pluginLoaded) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        }
        if (!pluginLoaded) {
          throw new Error('Quattro did not report the Pimpampum plugin after rescan');
        }

        await captureState('activePopout', {
          instruction: 'Open the Pimpampum popout and show mixed active work.',
        });
        await captureState('completedPopout', {
          instruction:
            'Show the completed project collapsed, expand it to inspect long content, then return it to the captured collapsed state.',
        });
        await execute('offline', 'systemctl', ['--user', 'stop', 'pimpampum.service']);
        await captureState('offlineStale', {
          instruction: 'Show the Pimpampum stale/offline state.',
        });
        await execute('recovery', 'systemctl', ['--user', 'start', 'pimpampum.service']);
        const recovered = parseCliObject(
          (await cli('status-recovered', ['status'])).stdout,
          'recovered status',
        );
        if (recovered.running !== true) throw new Error('Pimpampum did not recover after restart');
        await captureState('recovered', {
          instruction: 'Show the recovered online state.',
        });
        await captureState('workspaceOpen', {
          instruction:
            'Click the project row in the Pimpampum QML popout and show the workspace opened by that UI action.',
        });
        // Secondary fallback kept in the evidence transcript; the bound screenshot proves the QML action.
        await execute('workspace-open', 'xdg-open', [workspace], [0], false, true);
      } catch (error) {
        // A signal aborts the active prompt with readline's AbortError; report the interruption
        // itself so the diagnostic and the exit path describe what actually happened.
        operationError = interrupted ?? error;
      } finally {
        await cleanupOnce();
        if (immutableInstall) {
          try {
            await immutableInstall.dispose();
          } catch (error) {
            cleanupError = cleanupError
              ? new AggregateError([cleanupError, error], 'Immutable stage cleanup failed')
              : error;
          }
        }
        unregisterSignalHandler?.();
      }

      if (operationError || cleanupError) {
        const errors = [operationError, cleanupError].filter(Boolean);
        writeFailureDiagnostic(errors);
        if (errors.length > 1)
          throw new AggregateError(errors, 'Quattro live smoke and cleanup failed');
        throw errors[0];
      }

      try {
        assertCandidateUnchanged(candidatePath, initialCandidateHash, 'before evidence generation');
        const evidenceDirectory = dirname(evidencePath);
        const artifactDirectory = join(evidenceDirectory, 'artifacts');
        const screenshotDirectory = join(evidenceDirectory, 'screenshots');
        ensureRealDirectory(artifactDirectory, 'Evidence artifact directory');
        ensureRealDirectory(screenshotDirectory, 'Evidence screenshot directory');
        const transcriptPath = join(artifactDirectory, 'transcript.json');
        const beforePath = join(artifactDirectory, 'baseline-before.json');
        const afterPath = join(artifactDirectory, 'baseline-after.json');
        writeArtifactAtomic(transcriptPath, json(transcript));
        writeArtifactAtomic(beforePath, json(before));
        writeArtifactAtomic(afterPath, json(after));

        const screenshotEvidence = {};
        const seenScreenshotHashes = new Set();
        const seenScreenshotDestinations = new Set();
        for (const name of SCREENSHOT_NAMES) {
          const source = requireAbsolute(screenshots[name], `${name} screenshot`);
          const destination = join(
            screenshotDirectory,
            productionCandidate ? basename(source) : `${name}.png`,
          );
          if (seenScreenshotDestinations.has(destination)) {
            throw new Error('Omarchy screenshot output paths must be distinct');
          }
          seenScreenshotDestinations.add(destination);
          const sourceContents = readPng(source, `${name} screenshot`);
          if (hash(sourceContents) !== screenshotSourceHashes[name]) {
            throw new Error(`${name} screenshot changed after its transcript capture`);
          }
          writeArtifactAtomic(destination, sourceContents);
          const contents = ensurePng(destination, evidenceDirectory);
          const digest = hash(contents);
          if (seenScreenshotHashes.has(digest))
            throw new Error('Visual screenshots must be distinct');
          seenScreenshotHashes.add(digest);
          screenshotEvidence[name] = {
            path: relative(evidenceDirectory, destination),
            sha256: digest,
            ...(productionCandidate
              ? {
                  capturedPath: source,
                  capturedSha256: screenshotSourceHashes[name],
                }
              : {}),
          };
        }
        const visualChecks = {
          themeInheritance: 'activePopout',
          horizontalTopLayout: 'activePopout',
          popoutCoordination: 'activePopout',
          activeCount: 'activePopout',
          completedCollapse: 'completedPopout',
          offlineRecovery: 'offlineStale',
          recovered: 'recovered',
          workspaceOpen: 'workspaceOpen',
        };
        const reviewScreenshots = Object.fromEntries(
          Object.entries(screenshotEvidence).map(([name, artifact]) => [
            name,
            { path: join(evidenceDirectory, artifact.path), sha256: artifact.sha256 },
          ]),
        );
        const approvalBinding = hash(
          json({
            screenshots: screenshotEvidence,
            checks: visualChecks,
            reviewMatrix: TASK_3_3_REVIEW_MATRIX,
            automatedOnly: TASK_3_3_AUTOMATED_ONLY,
          }),
        );
        const visualReview = await dependencies.requestVisualReview({
          screenshots: reviewScreenshots,
          checklist: visualChecks,
          reviewMatrix: TASK_3_3_REVIEW_MATRIX,
          automatedOnly: TASK_3_3_AUTOMATED_ONLY,
          artifactSetHash: approvalBinding,
        });
        if (typeof visualReview.reviewer !== 'string' || !visualReview.reviewer.trim()) {
          throw new Error('A named human must approve the Quattro visual smoke');
        }
        if (visualReview.approved !== true) {
          throw new Error(
            `Reviewer ${visualReview.reviewer.trim()} declined approval; no evidence was written`,
          );
        }
        if (
          (existsSync(join(candidatePath, '.pimpampum-plugin-owner.json')) ||
            visualReview.artifactSetHash !== undefined) &&
          visualReview.artifactSetHash !== approvalBinding
        ) {
          throw new Error('Visual approval does not match the staged screenshot artifacts');
        }
        assertCandidateUnchanged(candidatePath, initialCandidateHash, 'at evidence write');
        const validatedAt = dependencies.now().toISOString();
        const versionEntry = transcript.find((entry) => entry.label === 'version');
        const evidence = {
          schemaVersion: 2,
          status: 'passed',
          validatedAt,
          omarchyVersion: versionEntry.stdout.trim().replace(/^Omarchy\s+/iu, ''),
          candidateHash: initialCandidateHash,
          validatedCandidatePath: candidatePath,
          environment: {
            platform: dependencies.platform,
            uid: dependencies.uid,
            waylandDisplay: dependencies.environment.WAYLAND_DISPLAY,
            explicitOptIn: true,
          },
          transcript: {
            path: relative(evidenceDirectory, transcriptPath),
            sha256: hash(readFileSync(transcriptPath)),
          },
          baseline: {
            beforePath: relative(evidenceDirectory, beforePath),
            beforeSha256: hash(readFileSync(beforePath)),
            afterPath: relative(evidenceDirectory, afterPath),
            afterSha256: hash(readFileSync(afterPath)),
            restored: true,
          },
          screenshots: screenshotEvidence,
          visualReview: {
            approved: true,
            reviewer: visualReview.reviewer.trim(),
            reviewedAt: visualReview.reviewedAt,
            checks: visualChecks,
          },
          cleanup: { completed: true, baselineRestored: true, evidenceWrittenAfterCleanup: true },
        };
        dependencies.writeEvidenceAtomic(evidencePath, evidence);
        return evidence;
      } catch (error) {
        writeFailureDiagnostic([error]);
        throw error;
      }
    },
  };
}

function pathInventory(paths) {
  return paths
    .filter(existsSync)
    .map((path) => {
      const metadata = lstatSync(path);
      return {
        path,
        type: metadata.isDirectory() ? 'directory' : 'file',
        sha256: metadata.isFile() ? hash(readFileSync(path)) : null,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function createRealDependencies(repositoryRoot, homeDirectory, options = {}) {
  const dataDirectory = options.dataDirectory
    ? resolve(options.dataDirectory)
    : process.env.PIMPAMPUM_DATA_DIR
      ? resolve(process.env.PIMPAMPUM_DATA_DIR)
      : join(homeDirectory, '.pimpampum');
  const receipt = join(dataDirectory, 'install-receipt.json');
  const plugin = join(homeDirectory, '.config/omarchy/plugins', PLUGIN_ID);
  const unit = join(homeDirectory, '.config/systemd/user/pimpampum.service');
  const shellJson = join(homeDirectory, '.config/omarchy/shell.json');
  const ownedPaths = [receipt, plugin, unit];
  const screenshotRoot = options.screenshotDirectory
    ? requireAbsolute(options.screenshotDirectory, 'Screenshot directory')
    : mkdtempSync(join(tmpdir(), 'pimpampum-quattro-shots-'));
  const environment = {
    ...process.env,
    PIMPAMPUM_DATA_DIR: dataDirectory,
    OMARCHY_SCREENSHOT_DIR: screenshotRoot,
  };
  const promptAbortController = new AbortController();
  const activeCommands = new Set();
  const signalProcessGroup = (pid, signal) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  const waitForProcessGroupExit = async (pid) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if (error?.code === 'ESRCH' || error?.code === 'EPERM') return true;
        throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    return false;
  };
  const rawExecute = async ({
    executable,
    arguments: arguments_,
    timeoutMs = COMMAND_TIMEOUT_MS,
    allowBackground = false,
  }) =>
    new Promise((resolveResult) => {
      let stdout = '';
      let stderr = '';
      let outcome = null;
      let completed = false;
      let resolveCompletion;
      const completion = new Promise((resolveDone) => {
        resolveCompletion = resolveDone;
      });
      const child = spawn(executable, arguments_, {
        cwd: repositoryRoot,
        env: environment,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let forceTimer = null;
      const terminate = (reason) => {
        if (!outcome) outcome = reason;
        signalProcessGroup(child.pid, 'SIGTERM');
        if (!forceTimer) {
          forceTimer = setTimeout(() => signalProcessGroup(child.pid, 'SIGKILL'), 250);
          forceTimer.unref?.();
        }
      };
      const active = { terminate, completion };
      activeCommands.add(active);
      const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
      timeout.unref?.();
      const append = (stream, chunk) => {
        const combined = stream + chunk.toString('utf8');
        if (Buffer.byteLength(combined) > 1_048_576) {
          terminate('output-limit');
          return combined.slice(0, 1_048_576);
        }
        return combined;
      };
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk);
      });
      const finish = async (exitCode, error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        if (!outcome && !allowBackground && Number.isInteger(child.pid) && child.pid > 0) {
          try {
            process.kill(-child.pid, 0);
            outcome = 'unexpected-background';
            signalProcessGroup(child.pid, 'SIGTERM');
            if (!(await waitForProcessGroupExit(child.pid))) {
              signalProcessGroup(child.pid, 'SIGKILL');
              if (!(await waitForProcessGroupExit(child.pid))) {
                outcome = 'process-group-survived';
                stderr = `${stderr}${stderr ? '\n' : ''}command process group did not exit`;
              }
            }
          } catch (groupError) {
            if (groupError?.code !== 'ESRCH' && groupError?.code !== 'EPERM') throw groupError;
          }
        } else if (outcome && Number.isInteger(child.pid) && child.pid > 0) {
          if (forceTimer) clearTimeout(forceTimer);
          signalProcessGroup(child.pid, 'SIGKILL');
          if (!(await waitForProcessGroupExit(child.pid))) {
            outcome = 'process-group-survived';
            stderr = `${stderr}${stderr ? '\n' : ''}timed-out process group did not exit`;
          }
        } else if (forceTimer) clearTimeout(forceTimer);
        activeCommands.delete(active);
        if (error) stderr = `${stderr}${stderr ? '\n' : ''}${error.message}`;
        const normalizedExitCode =
          outcome === 'timeout' ? 124 : outcome === 'interrupted' ? 130 : outcome ? 125 : exitCode;
        resolveResult({ exitCode: normalizedExitCode ?? 1, stdout, stderr });
        resolveCompletion();
      };
      child.once('error', (error) => void finish(1, error));
      child.once('close', (code) => void finish(code, null));
    });
  const abortActiveCommands = async () => {
    const active = [...activeCommands];
    for (const command of active) command.terminate('interrupted');
    await Promise.all(active.map((command) => command.completion));
  };
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    environment,
    allowedEvidenceRoot: join(repositoryRoot, 'thoughts/evidence'),
    trustedEvidenceAnchor: repositoryRoot,
    existingPaths: options.existingPaths ?? ownedPaths.filter(existsSync),
    now: () => new Date(),
    execute: rawExecute,
    abortActiveCommands,
    async prepareImmutableInstall({ candidatePath, cliPath, expectedCandidateHash }) {
      const candidateChild = relative(repositoryRoot, candidatePath);
      if (
        candidateChild === '..' ||
        candidateChild.startsWith(`..${sep}`) ||
        isAbsolute(candidateChild)
      ) {
        throw new Error('Candidate must be inside the repository for immutable staging');
      }
      assertCandidateUnchanged(candidatePath, expectedCandidateHash, 'before immutable staging');
      const stageRoot = mkdtempSync(join(tmpdir(), 'pimpampum-quattro-stage-'));
      try {
        const stagedCandidate = join(stageRoot, candidateChild);
        mkdirSync(dirname(stagedCandidate), { recursive: true });
        cpSync(candidatePath, stagedCandidate, { recursive: true });
        if (canonicalCandidateHash(stagedCandidate) !== expectedCandidateHash) {
          throw new Error('Immutable stage changed while it was copied');
        }
        makeTreeReadOnly(stageRoot);
        return {
          cliPath,
          candidatePath: stagedCandidate,
          async dispose() {
            makeTreeWritable(stageRoot);
            rmSync(stageRoot, { recursive: true, force: true });
          },
        };
      } catch (error) {
        makeTreeWritable(stageRoot);
        rmSync(stageRoot, { recursive: true, force: true });
        throw error;
      }
    },
    async verifyInstalledCandidate({ stagedCandidatePath, expectedCandidateHash, receiptPath }) {
      if (canonicalCandidateHash(stagedCandidatePath) !== expectedCandidateHash) {
        throw new Error('Immutable candidate changed before installed-artifact verification');
      }
      const absoluteReceipt = requireAbsolute(receiptPath, 'Install receipt path');
      if (absoluteReceipt !== receipt)
        throw new Error('Install returned an unexpected receipt path');
      for (const [label, path, anchor] of [
        ['receipt', absoluteReceipt, dataDirectory],
        ['plugin', plugin, homeDirectory],
      ]) {
        let current = anchor;
        for (const segment of relative(anchor, path).split(sep).filter(Boolean)) {
          const metadata = lstatSync(current);
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error(`Installed ${label} traverses an unsafe ancestor`);
          }
          current = join(current, segment);
        }
      }
      const receiptMetadata = lstatSync(absoluteReceipt);
      if (receiptMetadata.isSymbolicLink() || !receiptMetadata.isFile()) {
        throw new Error('Install receipt must be a regular file');
      }
      const receiptContents = readFileSync(absoluteReceipt);
      if (receiptContents.length > 1024 * 1024) throw new Error('Install receipt is too large');
      const installedReceipt = parseObject(receiptContents.toString('utf8'), 'install receipt');
      if (
        installedReceipt.schemaVersion !== 1 ||
        installedReceipt.adapter !== 'systemd-omarchy-quattro' ||
        installedReceipt.dataDirectory !== dataDirectory ||
        !Array.isArray(installedReceipt.artifacts)
      ) {
        throw new Error(
          `Install receipt does not describe the expected Omarchy installation: ${JSON.stringify({
            schemaVersion: installedReceipt.schemaVersion,
            adapter: installedReceipt.adapter,
            dataDirectory: installedReceipt.dataDirectory,
            expectedDataDirectory: dataDirectory,
            artifactsIsArray: Array.isArray(installedReceipt.artifacts),
          })}`,
        );
      }
      // The installer copies every plugin byte verbatim (pluginArtifacts in src/service/omarchy.ts)
      // and marks exactly the delivery checker's helper list executable. Anything else on disk
      // is drift, whether the installer rewrote a helper or a later process touched the tree.
      const expected = [];
      const visit = (directory) => {
        for (const name of readdirSync(directory).sort()) {
          const source = join(directory, name);
          const metadata = lstatSync(source);
          if (metadata.isSymbolicLink()) throw new Error('Immutable candidate contains a symlink');
          if (metadata.isDirectory()) visit(source);
          else if (metadata.isFile()) {
            const child = relative(stagedCandidatePath, source);
            expected.push({
              child,
              path: join(plugin, child),
              contents: readFileSync(source),
              mode: executableHelpers.includes(child) ? 0o755 : 0o644,
            });
          } else throw new Error('Immutable candidate contains a non-regular file');
        }
      };
      visit(stagedCandidatePath);
      const actualPaths = [];
      const visitInstalled = (directory) => {
        const metadata = lstatSync(directory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error('Installed plugin tree contains an unsafe directory');
        }
        for (const name of readdirSync(directory).sort()) {
          const path = join(directory, name);
          const child = lstatSync(path);
          if (child.isSymbolicLink()) throw new Error('Installed plugin tree contains a symlink');
          if (child.isDirectory()) visitInstalled(path);
          else if (child.isFile()) actualPaths.push(path);
          else throw new Error('Installed plugin tree contains a non-regular file');
        }
      };
      visitInstalled(plugin);
      const receiptArtifacts = new Map();
      for (const artifact of installedReceipt.artifacts) {
        if (
          !artifact ||
          typeof artifact !== 'object' ||
          typeof artifact.path !== 'string' ||
          typeof artifact.sha256 !== 'string' ||
          !Number.isInteger(artifact.mode) ||
          receiptArtifacts.has(artifact.path)
        ) {
          throw new Error('Install receipt contains an invalid or duplicate artifact');
        }
        receiptArtifacts.set(artifact.path, artifact);
      }
      if (
        actualPaths.length !== expected.length ||
        !actualPaths.every((path) => expected.some((artifact) => artifact.path === path))
      ) {
        throw new Error('Installed plugin tree differs from the immutable candidate');
      }
      for (const artifact of expected) {
        const installed = lstatSync(artifact.path);
        const contents = readFileSync(artifact.path);
        const digest = hash(artifact.contents);
        const owned = receiptArtifacts.get(artifact.path);
        if (
          installed.isSymbolicLink() ||
          !installed.isFile() ||
          (installed.mode & 0o777) !== artifact.mode ||
          !contents.equals(artifact.contents) ||
          owned?.sha256 !== digest ||
          owned?.mode !== artifact.mode
        ) {
          throw new Error(
            `Installed receipt-owned plugin differs from the staged candidate at ${artifact.child}`,
          );
        }
      }
    },
    async prepareScreenshot(name, context) {
      mkdirSync(screenshotRoot, { recursive: true, mode: 0o700 });
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await terminal.question(
          `${context?.instruction ?? `Arrange the ${name} Quattro state.`} Press Enter to capture. `,
          { signal: promptAbortController.signal },
        );
      } finally {
        terminal.close();
      }
    },
    resolveScreenshotPath(stdout) {
      const lines = stdout.trim().split(/\r?\n/u);
      if (lines.length !== 1) {
        throw new Error('Omarchy screenshot must print exactly one saved path');
      }
      const savedPath = lines[0]?.trim() ?? '';
      if (!isAbsolute(savedPath)) {
        throw new Error('Omarchy screenshot did not print an absolute saved path');
      }
      const absoluteSavedPath = requireAbsolute(savedPath, 'Omarchy screenshot path');
      const child = relative(realpathSync(screenshotRoot), realpathSync(absoluteSavedPath));
      if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error('Omarchy screenshot escaped OMARCHY_SCREENSHOT_DIR');
      }
      return absoluteSavedPath;
    },
    async captureScreenshot(name, context) {
      await this.prepareScreenshot(name, context);
      const result = await rawExecute({
        executable: 'omarchy',
        arguments: ['capture', 'screenshot', 'fullscreen', 'save'],
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) throw new Error(`Omarchy screenshot failed: ${result.stderr}`);
      return this.resolveScreenshotPath(result.stdout);
    },
    async snapshotBaseline() {
      const shellExists = existsSync(shellJson);
      return {
        shellConfig: {},
        shellJson: {
          exists: shellExists,
          sha256: shellExists ? hash(readFileSync(shellJson)) : null,
        },
        plugin: { exists: existsSync(plugin) },
        service: {
          unitExists: existsSync(unit),
          enabled: false,
          running: false,
        },
        receipt: { exists: existsSync(receipt) },
        ownedPaths: pathInventory(ownedPaths),
      };
    },
    async requestVisualReview({
      screenshots,
      checklist,
      reviewMatrix = TASK_3_3_REVIEW_MATRIX,
      automatedOnly = TASK_3_3_AUTOMATED_ONLY,
      artifactSetHash,
    }) {
      for (const [name, artifact] of Object.entries(screenshots)) {
        const shown = await rawExecute({
          executable: 'xdg-open',
          arguments: [artifact.path],
          timeoutMs: COMMAND_TIMEOUT_MS,
          allowBackground: true,
        });
        if (shown.exitCode !== 0) {
          throw new Error(`Could not show staged ${name} screenshot: ${shown.stderr}`);
        }
      }
      process.stdout.write(
        `${json({
          artifactSetHash,
          screenshots,
          checklist,
          reviewMatrix,
          automatedOnly,
        })}\nReview the exact staged files and hashes above.\n`,
      );
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      // Read answers through the async iterator rather than question(): question() only captures
      // the next 'line' event, so answers that arrive in one chunk (a paste, or piped input) are
      // dropped between prompts. The iterator buffers them.
      const lines = terminal[Symbol.asyncIterator]();
      const { signal } = promptAbortController;
      const aborted = new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      const ask = async (prompt) => {
        process.stdout.write(prompt);
        const next = await Promise.race([lines.next(), aborted]);
        if (next.done) throw new Error('Review input ended before the reviewer answered');
        return next.value;
      };
      try {
        let reviewer = '';
        while (!reviewer) {
          reviewer = (await ask('Reviewer name: ')).trim();
          if (!reviewer) process.stdout.write('A reviewer name is required.\n');
        }
        const approval = await ask(
          'Did you directly observe every Task 3.3 matrix item during this run, and do the bound captures match the screenshot checklist? Type yes: ',
        );
        return {
          approved: approval.trim().toLowerCase() === 'yes',
          reviewer,
          reviewedAt: new Date().toISOString(),
          artifactSetHash,
        };
      } finally {
        terminal.close();
      }
    },
    registerSignalHandler(handler) {
      const interrupt = (signal) => {
        const cleanup = handler(signal);
        promptAbortController.abort(new Error(`Quattro live smoke interrupted by ${signal}`));
        void cleanup.catch((error) => {
          process.stderr.write(`${signal} cleanup failed: ${String(error)}\n`);
        });
      };
      const onSigint = () => interrupt('SIGINT');
      const onSigterm = () => interrupt('SIGTERM');
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
      return () => {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
      };
    },
    writeEvidenceAtomic(path, evidence) {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      writeFileSync(temporary, json(evidence), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = join(repositoryRoot, 'dist/cli.js');
  if (!existsSync(cliPath) || !lstatSync(cliPath).isFile()) {
    throw new Error('Missing compiled Pimpampum CLI; run npm run build before the live smoke');
  }
  const userDependencies = createRealDependencies(repositoryRoot, homedir());
  if (
    userDependencies.environment.PIMPAMPUM_QUATTRO_LIVE !== '1' ||
    userDependencies.platform !== 'linux' ||
    userDependencies.uid === 0 ||
    !userDependencies.environment.WAYLAND_DISPLAY?.trim() ||
    userDependencies.existingPaths.length > 0
  ) {
    throw new Error(
      'Live runner requires PIMPAMPUM_QUATTRO_LIVE=1, Linux, non-root Wayland, and no existing Pimpampum installation',
    );
  }
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'pimpampum-quattro-live-'));
  const temporaryWorkspace = join(temporaryRoot, 'workspace');
  const temporaryData = join(temporaryRoot, 'data');
  const temporaryScreenshots = join(temporaryRoot, 'screenshots');
  mkdirSync(temporaryWorkspace, { recursive: true });
  const dependencies = createRealDependencies(repositoryRoot, homedir(), {
    dataDirectory: temporaryData,
    screenshotDirectory: temporaryScreenshots,
    existingPaths: userDependencies.existingPaths,
  });
  const runner = createLiveRunner(dependencies);
  try {
    const evidence = await runner.run({
      candidatePath: join(repositoryRoot, 'integrations/omarchy/pimpampum-status'),
      evidencePath: join(repositoryRoot, 'thoughts/evidence/quattro-live.json'),
      cliPath,
      workspacePath: temporaryWorkspace,
    });
    process.stdout.write(json(evidence));
  } catch (error) {
    const message = String(error?.message);
    if (/interrupted by SIG(?:INT|TERM)/u.test(message)) {
      process.stderr.write(
        `${message}; the Omarchy baseline was restored and no evidence was written.\n`,
      );
      process.exitCode = 130;
    } else if (/declined approval/u.test(message)) {
      process.stderr.write(`${message}; the Omarchy baseline was restored.\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    const cleanupResidue = [
      join(temporaryData, 'install-receipt.json'),
      join(homedir(), '.config/omarchy/plugins', PLUGIN_ID),
      join(homedir(), '.config/systemd/user/pimpampum.service'),
    ].filter(existsSync);
    if (cleanupResidue.length === 0) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(
        `Quattro live cleanup left ${cleanupResidue.join(', ')}; isolated data is preserved at ${temporaryRoot}\n`,
      );
    }
  }
}
