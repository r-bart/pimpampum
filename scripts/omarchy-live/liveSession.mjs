// LiveSession owns the daemon and plugin lifecycle on the Omarchy host for one smoke run: every
// command goes through `execute` into the transcript, the baseline is probed before install and
// after uninstall, and cleanup runs exactly once even when a signal lands mid-run.

import { parseCliEnvelope, parseOptionalJson } from '../lib/cliEnvelope.mjs';
import { requireAbsolute } from '../lib/paths.mjs';
import { waitFor } from '../lib/waitFor.mjs';
import {
  assertCandidateUnchanged,
  canonicalCandidateHash,
  invalidateExistingEvidence,
} from './artifacts.mjs';
import { COMMAND_TIMEOUT_MS, PLUGIN_ID, SYSTEMD_PROBE_ARGUMENTS } from './contract.mjs';

/** True/false when the `omarchy plugin list --json` output can be read, null when it is empty. */
export function pluginListed(probeOutput) {
  const parsed = parseOptionalJson(probeOutput);
  const entries = Array.isArray(parsed) ? parsed : parsed?.plugins;
  return Array.isArray(entries) ? entries.some((entry) => entry?.id === PLUGIN_ID) : null;
}

function mergeProbeSnapshot(snapshot, shell, plugins, systemd) {
  const merged = structuredClone(snapshot);
  const shellValue = parseOptionalJson(shell.stdout);
  const listed = pluginListed(plugins.stdout);
  if (shellValue) merged.shellConfig = shellValue;
  if (listed !== null) merged.plugin = { exists: listed };
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class LiveSession {
  constructor(dependencies, target) {
    this.dependencies = dependencies;
    this.target = target;
    this.transcript = [];
    this.activeCliPath = target.cliPath;
    this.interrupted = null;
    this.installAttempted = false;
    this.before = null;
    this.after = null;
    this.cleanupError = null;
    this.cleanupPromise = null;
    this.immutableInstall = null;
  }

  // -- Transcript ------------------------------------------------------------------------------

  /** Runs one command, records it in the transcript, and enforces its allowed exit codes. */
  async execute(label, executable, arguments_, options = {}) {
    const { allowedExitCodes = [0], allowDuringCleanup = false, allowBackground = false } = options;
    if (this.interrupted && !allowDuringCleanup) throw this.interrupted;
    const startedAt = this.dependencies.now().toISOString();
    const result = await this.dependencies.execute({
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
      finishedAt: this.dependencies.now().toISOString(),
    };
    this.transcript.push(entry);
    if (this.interrupted && !allowDuringCleanup) throw this.interrupted;
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new Error(`${label} failed with exit code ${result.exitCode}: ${result.stderr.trim()}`);
    }
    return entry;
  }

  cli(label, arguments_, allowDuringCleanup = false) {
    return this.execute(label, process.execPath, [this.activeCliPath, ...arguments_], {
      allowDuringCleanup,
    });
  }

  /** A CLI call whose stdout must be one {"data": object} envelope; returns the payload. */
  async cliData(label, arguments_, parseLabel = label, allowDuringCleanup = false) {
    const entry = await this.cli(label, arguments_, allowDuringCleanup);
    return parseCliEnvelope(entry.stdout, parseLabel);
  }

  entry(label) {
    return this.transcript.find((entry) => entry.label === label);
  }

  // -- Baseline ---------------------------------------------------------------------------------

  async probes(phase, allowDuringCleanup = false) {
    const shell = await this.execute(
      `baseline-${phase}-shell`,
      'omarchy-shell',
      ['shell', 'listShellConfig'],
      { allowDuringCleanup },
    );
    const plugins = await this.execute(
      `baseline-${phase}-plugins`,
      'omarchy',
      ['plugin', 'list', '--json'],
      { allowDuringCleanup },
    );
    const systemd = await this.execute(
      `baseline-${phase}-systemd`,
      'systemctl',
      SYSTEMD_PROBE_ARGUMENTS,
      { allowedExitCodes: [0, 1, 3, 4], allowDuringCleanup },
    );
    return mergeProbeSnapshot(await this.dependencies.snapshotBaseline(), shell, plugins, systemd);
  }

  // -- Lifecycle on the host -------------------------------------------------------------------

  async checkOmarchyVersion() {
    const version = await this.execute('version', 'omarchy', ['version']);
    if (!/\b(?:Quattro|4(?:\.|\b))/iu.test(version.stdout)) {
      throw new Error(`Unsupported Omarchy build: ${version.stdout.trim() || 'unknown'}`);
    }
  }

  /** Production candidates install from a read-only copy so later source edits cannot leak in. */
  async stageImmutableInstall() {
    const { dependencies, target } = this;
    if (typeof dependencies.prepareImmutableInstall !== 'function') {
      throw new Error('Production candidate install requires an immutable staged runtime');
    }
    this.immutableInstall = await dependencies.prepareImmutableInstall({
      candidatePath: target.candidatePath,
      cliPath: target.cliPath,
      expectedCandidateHash: target.initialCandidateHash,
    });
    this.activeCliPath = requireAbsolute(
      this.immutableInstall.cliPath,
      'Immutable staged CLI path',
    );
    const stagedCandidatePath = requireAbsolute(
      this.immutableInstall.candidatePath,
      'Immutable staged candidate path',
    );
    if (canonicalCandidateHash(stagedCandidatePath) !== target.initialCandidateHash) {
      throw new Error('Immutable staged candidate does not match the validated candidate');
    }
  }

  async validateCandidate() {
    const { target } = this;
    await this.execute('validation', 'omarchy', ['plugin', 'validate', target.candidatePath]);
    assertCandidateUnchanged(target.candidatePath, target.initialCandidateHash, 'after validation');
    if (!target.productionCandidate) return;
    await this.execute('validation-snapshot', 'omarchy', [
      'plugin',
      'validate',
      this.immutableInstall.candidatePath,
    ]);
    if (
      canonicalCandidateHash(this.immutableInstall.candidatePath) !== target.initialCandidateHash
    ) {
      throw new Error('Immutable staged candidate changed during authoritative validation');
    }
  }

  /** Probes the baseline, retires stale evidence, installs, and proves the daemon is online. */
  async install() {
    const { dependencies, target } = this;
    this.before = await this.probes('before');
    invalidateExistingEvidence(target.evidencePath);
    assertCandidateUnchanged(target.candidatePath, target.initialCandidateHash, 'before install');

    this.installAttempted = true;
    const installResult = await this.cliData('install', ['install']);
    if (target.productionCandidate) {
      if (typeof dependencies.verifyInstalledCandidate !== 'function') {
        throw new Error('Production install requires exact receipt-owned artifact verification');
      }
      await dependencies.verifyInstalledCandidate({
        stagedCandidatePath: this.immutableInstall.candidatePath,
        expectedCandidateHash: target.initialCandidateHash,
        receiptPath: installResult.receiptPath,
        cliPath: this.activeCliPath,
      });
    }
    assertCandidateUnchanged(target.candidatePath, target.initialCandidateHash, 'after install');
    const online = await this.cliData('status-online', ['status'], 'status');
    if (online.running !== true) throw new Error('Installed Pimpampum daemon is not running');
  }

  /** Rescans plugins and waits until Quattro lists Pimpampum; each probe stays in the transcript. */
  async reloadPlugin() {
    await this.execute('hot-reload', 'omarchy-shell', ['shell', 'rescanPlugins']);
    await waitFor(
      async () => {
        const probe = await this.execute('post-rescan-plugin-loaded', 'omarchy', [
          'plugin',
          'list',
          '--json',
        ]);
        return pluginListed(probe.stdout) === true;
      },
      {
        attempts: 50,
        intervalMs: 100,
        timeoutMessage: 'Quattro did not report the Pimpampum plugin after rescan',
      },
    );
  }

  // -- Interruption and cleanup ----------------------------------------------------------------

  interrupt(signal) {
    if (!this.interrupted) {
      this.interrupted = new Error(`Quattro live smoke interrupted by ${signal}`);
    }
  }

  recordCleanupError(error, aggregateMessage) {
    this.cleanupError = this.cleanupError
      ? new AggregateError([this.cleanupError, error], aggregateMessage)
      : error;
  }

  /** Uninstalls (once) and re-probes the baseline; every failure is kept, never thrown here. */
  cleanupOnce() {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      if (this.installAttempted) {
        try {
          const removal = await this.cliData('uninstall', ['uninstall'], 'uninstall', true);
          if (removal.uninstalled !== true) {
            this.cleanupError = new Error('Uninstall did not complete');
          }
        } catch (error) {
          this.cleanupError = error;
        }
      }
      if (this.before) {
        try {
          this.after = await this.probes('after', true);
          if (!sameJson(this.before, this.after)) {
            this.recordCleanupError(
              new Error('Live smoke cleanup did not restore the exact baseline'),
              'Quattro live cleanup failed',
            );
          }
        } catch (error) {
          this.recordCleanupError(error, 'Quattro live cleanup failed');
        }
      }
    })();
    return this.cleanupPromise;
  }

  async disposeStage() {
    if (!this.immutableInstall) return;
    try {
      await this.immutableInstall.dispose();
    } catch (error) {
      this.recordCleanupError(error, 'Immutable stage cleanup failed');
    }
  }
}
