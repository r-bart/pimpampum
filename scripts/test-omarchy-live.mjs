#!/usr/bin/env node

// The Quattro live smoke: installs the Omarchy plugin on a real host, seeds a portfolio, captures
// the five canonical screenshots with a human at the keyboard, restores the exact baseline and
// only then writes `thoughts/evidence/quattro-live.json` for `check-quattro-evidence.mjs`.
// The pieces live under scripts/omarchy-live/: `LiveSession` (host lifecycle and transcript),
// `SEED_STEPS` (the portfolio), `CaptureFlow` (ordered captures), `EvidenceWriter` (artifacts,
// approval, evidence) and `createRealDependencies` (the real host behind the injected seam).

import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSafeEvidencePath, requireAbsolute } from './lib/paths.mjs';
import { canonicalCandidateHash, json } from './omarchy-live/artifacts.mjs';
import { CaptureFlow } from './omarchy-live/captureFlow.mjs';
import { PLUGIN_ID } from './omarchy-live/contract.mjs';
import { EvidenceWriter } from './omarchy-live/evidenceWriter.mjs';
import { LiveSession } from './omarchy-live/liveSession.mjs';
import { createRealDependencies } from './omarchy-live/realDependencies.mjs';
import { seedPortfolio } from './omarchy-live/seedTable.mjs';

export {
  TASK_3_3_AUTOMATED_ONLY,
  TASK_3_3_REVIEW_MATRIX,
  TASK_6_2_SCENARIOS,
} from './omarchy-live/contract.mjs';
export { createTask62LiveRunner } from './omarchy-live/task62.mjs';
export { createRealDependencies } from './omarchy-live/realDependencies.mjs';

/** Resolves and checks every input before any command runs; returns the run target. */
function resolveRunTarget(dependencies, input) {
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
  return {
    candidatePath,
    evidencePath,
    cliPath,
    productionCandidate: existsSync(join(candidatePath, '.pimpampum-plugin-owner.json')),
    initialCandidateHash: canonicalCandidateHash(candidatePath),
    workspace: input.workspacePath
      ? requireAbsolute(input.workspacePath, 'Workspace path')
      : dirname(candidatePath),
  };
}

function registerInterrupt(session) {
  const { dependencies } = session;
  if (typeof dependencies.registerSignalHandler !== 'function') return () => {};
  return dependencies.registerSignalHandler(async (signal) => {
    session.interrupt(signal);
    await dependencies.abortActiveCommands?.();
    await session.cleanupOnce();
  });
}

/** The smoke in transcript order; the evidence checker pins this sequence of labels. */
async function runSmoke(session, capture) {
  await session.checkOmarchyVersion();
  if (session.target.productionCandidate) await session.stageImmutableInstall();
  await session.validateCandidate();
  await session.install();
  await seedPortfolio(session);
  await session.reloadPlugin();
  await capture.run();
}

export default function createLiveRunner(dependencies) {
  return {
    async run(input) {
      const target = resolveRunTarget(dependencies, input);
      const session = new LiveSession(dependencies, target);
      const capture = new CaptureFlow(session);
      const writer = new EvidenceWriter(session);
      const unregisterSignalHandler = registerInterrupt(session);
      let operationError = null;
      try {
        await runSmoke(session, capture);
      } catch (error) {
        // A signal aborts the active prompt with readline's AbortError; report the interruption
        // itself so the diagnostic and the exit path describe what actually happened.
        operationError = session.interrupted ?? error;
      } finally {
        await session.cleanupOnce();
        await session.disposeStage();
        unregisterSignalHandler?.();
      }

      if (operationError || session.cleanupError) {
        const errors = [operationError, session.cleanupError].filter(Boolean);
        writer.writeFailureDiagnostic(errors);
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Quattro live smoke and cleanup failed');
        }
        throw errors[0];
      }
      return writer.write(capture);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

function assertLiveHost(userDependencies) {
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
}

function reportCommandLineFailure(error) {
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
}

function removeIsolatedState(temporaryRoot, temporaryData) {
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

async function runFromCommandLine() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = join(repositoryRoot, 'dist/cli.js');
  if (!existsSync(cliPath) || !lstatSync(cliPath).isFile()) {
    throw new Error('Missing compiled Pimpampum CLI; run npm run build before the live smoke');
  }
  const userDependencies = createRealDependencies(repositoryRoot, homedir());
  assertLiveHost(userDependencies);
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
    reportCommandLineFailure(error);
  } finally {
    removeIsolatedState(temporaryRoot, temporaryData);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runFromCommandLine();
}
