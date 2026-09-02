// The real host: installation layout, the bounded process runner, immutable staging, receipt
// verification, guided screenshot IO, the baseline snapshot, the reviewer prompt and signal
// handling. Tests replace this object wholesale; nothing here is reachable without it.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { sha256 } from '../lib/hashTree.mjs';
import { isInside, requireAbsolute } from '../lib/paths.mjs';
import { createProcessRunner } from '../lib/processRunner.mjs';
import { json, writeEvidenceAtomic } from './artifacts.mjs';
import {
  COMMAND_TIMEOUT_MS,
  OMARCHY_SCREENSHOT_ARGUMENTS,
  PLUGIN_ID,
  TASK_3_3_AUTOMATED_ONLY,
  TASK_3_3_REVIEW_MATRIX,
} from './contract.mjs';
import { prepareImmutableInstall, verifyInstalledCandidate } from './immutableStage.mjs';

function pathInventory(paths) {
  return paths
    .filter(existsSync)
    .map((path) => {
      const metadata = lstatSync(path);
      return {
        path,
        type: metadata.isDirectory() ? 'directory' : 'file',
        sha256: metadata.isFile() ? sha256(readFileSync(path)) : null,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function installationLayout(repositoryRoot, homeDirectory, options) {
  const dataDirectory = options.dataDirectory
    ? resolve(options.dataDirectory)
    : process.env.PIMPAMPUM_DATA_DIR
      ? resolve(process.env.PIMPAMPUM_DATA_DIR)
      : join(homeDirectory, '.pimpampum');
  const receipt = join(dataDirectory, 'install-receipt.json');
  const plugin = join(homeDirectory, '.config/omarchy/plugins', PLUGIN_ID);
  const unit = join(homeDirectory, '.config/systemd/user/pimpampum.service');
  const screenshotRoot = options.screenshotDirectory
    ? requireAbsolute(options.screenshotDirectory, 'Screenshot directory')
    : mkdtempSync(join(tmpdir(), 'pimpampum-quattro-shots-'));
  return {
    repositoryRoot,
    homeDirectory,
    dataDirectory,
    receipt,
    plugin,
    unit,
    shellJson: join(homeDirectory, '.config/omarchy/shell.json'),
    ownedPaths: [receipt, plugin, unit],
    screenshotRoot,
    environment: {
      ...process.env,
      PIMPAMPUM_DATA_DIR: dataDirectory,
      OMARCHY_SCREENSHOT_DIR: screenshotRoot,
    },
  };
}

function createScreenshotIo(layout, runner, promptAbortController) {
  return {
    async prepareScreenshot(name, context) {
      mkdirSync(layout.screenshotRoot, { recursive: true, mode: 0o700 });
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
      if (!isInside(realpathSync(layout.screenshotRoot), realpathSync(absoluteSavedPath))) {
        throw new Error('Omarchy screenshot escaped OMARCHY_SCREENSHOT_DIR');
      }
      return absoluteSavedPath;
    },
    async captureScreenshot(name, context) {
      await this.prepareScreenshot(name, context);
      const result = await runner.execute({
        executable: 'omarchy',
        arguments: [...OMARCHY_SCREENSHOT_ARGUMENTS],
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) throw new Error(`Omarchy screenshot failed: ${result.stderr}`);
      return this.resolveScreenshotPath(result.stdout);
    },
  };
}

async function snapshotBaseline(layout) {
  const shellExists = existsSync(layout.shellJson);
  return {
    shellConfig: {},
    shellJson: {
      exists: shellExists,
      sha256: shellExists ? sha256(readFileSync(layout.shellJson)) : null,
    },
    plugin: { exists: existsSync(layout.plugin) },
    service: {
      unitExists: existsSync(layout.unit),
      enabled: false,
      running: false,
    },
    receipt: { exists: existsSync(layout.receipt) },
    ownedPaths: pathInventory(layout.ownedPaths),
  };
}

async function showStagedScreenshots(runner, screenshots) {
  for (const [name, artifact] of Object.entries(screenshots)) {
    const shown = await runner.execute({
      executable: 'xdg-open',
      arguments: [artifact.path],
      timeoutMs: COMMAND_TIMEOUT_MS,
      allowBackground: true,
    });
    if (shown.exitCode !== 0) {
      throw new Error(`Could not show staged ${name} screenshot: ${shown.stderr}`);
    }
  }
}

/**
 * Reads reviewer answers through readline's async iterator rather than question(): question()
 * only captures the next 'line' event, so answers that arrive in one chunk (a paste, or piped
 * input) are dropped between prompts. The iterator buffers them. Returns `ask(prompt)`.
 */
function createReviewerPrompt(terminal, promptAbortController) {
  const lines = terminal[Symbol.asyncIterator]();
  const { signal } = promptAbortController;
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return async (prompt) => {
    process.stdout.write(prompt);
    const next = await Promise.race([lines.next(), aborted]);
    if (next.done) throw new Error('Review input ended before the reviewer answered');
    return next.value;
  };
}

async function requestVisualReview(runner, promptAbortController, review) {
  const {
    screenshots,
    checklist,
    reviewMatrix = TASK_3_3_REVIEW_MATRIX,
    automatedOnly = TASK_3_3_AUTOMATED_ONLY,
    artifactSetHash,
  } = review;
  await showStagedScreenshots(runner, screenshots);
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
  const ask = createReviewerPrompt(terminal, promptAbortController);
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
}

function registerSignalHandler(promptAbortController, handler) {
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
}

export function createRealDependencies(repositoryRoot, homeDirectory, options = {}) {
  const layout = installationLayout(repositoryRoot, homeDirectory, options);
  const promptAbortController = new AbortController();
  const runner = createProcessRunner({ cwd: repositoryRoot, environment: layout.environment });
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    environment: layout.environment,
    allowedEvidenceRoot: join(repositoryRoot, 'thoughts/evidence'),
    trustedEvidenceAnchor: repositoryRoot,
    existingPaths: options.existingPaths ?? layout.ownedPaths.filter(existsSync),
    now: () => new Date(),
    execute: runner.execute,
    abortActiveCommands: runner.abortActiveCommands,
    prepareImmutableInstall: (input) => prepareImmutableInstall(repositoryRoot, input),
    verifyInstalledCandidate: (input) => verifyInstalledCandidate(layout, input),
    ...createScreenshotIo(layout, runner, promptAbortController),
    snapshotBaseline: () => snapshotBaseline(layout),
    requestVisualReview: (review) => requestVisualReview(runner, promptAbortController, review),
    registerSignalHandler: (handler) => registerSignalHandler(promptAbortController, handler),
    writeEvidenceAtomic,
  };
}
