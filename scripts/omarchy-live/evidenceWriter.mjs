// EvidenceWriter runs after cleanup: it writes the transcript and baseline artifacts, stages every
// screenshot into the evidence tree bound to its transcript hash, asks a named human for approval
// of exactly that artifact set, and only then writes the canonical evidence file.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { sha256 } from '../lib/hashTree.mjs';
import { requireAbsolute } from '../lib/paths.mjs';
import {
  assertCandidateUnchanged,
  ensurePng,
  ensureRealDirectory,
  json,
  readPng,
  writeArtifactAtomic,
} from './artifacts.mjs';
import {
  SCREENSHOT_NAMES,
  TASK_3_3_AUTOMATED_ONLY,
  TASK_3_3_REVIEW_MATRIX,
  VISUAL_CHECKS,
} from './contract.mjs';

export class EvidenceWriter {
  constructor(session) {
    this.session = session;
    this.evidenceDirectory = dirname(session.target.evidencePath);
  }

  writeFailureDiagnostic(errors) {
    const { session } = this;
    const diagnosticPath = join(
      this.evidenceDirectory,
      `.quattro-live-failure-${randomUUID()}.json`,
    );
    writeArtifactAtomic(
      diagnosticPath,
      json({
        schemaVersion: 1,
        failedAt: session.dependencies.now().toISOString(),
        errors: errors.map((error) => String(error?.stack ?? error)),
        transcript: session.transcript,
        before: session.before,
        after: session.after,
      }),
    );
  }

  writeArtifacts() {
    const { session, evidenceDirectory } = this;
    const artifactDirectory = join(evidenceDirectory, 'artifacts');
    ensureRealDirectory(artifactDirectory, 'Evidence artifact directory');
    ensureRealDirectory(join(evidenceDirectory, 'screenshots'), 'Evidence screenshot directory');
    const paths = {
      transcript: join(artifactDirectory, 'transcript.json'),
      before: join(artifactDirectory, 'baseline-before.json'),
      after: join(artifactDirectory, 'baseline-after.json'),
    };
    writeArtifactAtomic(paths.transcript, json(session.transcript));
    writeArtifactAtomic(paths.before, json(session.before));
    writeArtifactAtomic(paths.after, json(session.after));
    return paths;
  }

  /** Copies every capture into the evidence tree and binds it to its transcript source hash. */
  stageScreenshots(capture) {
    const { evidenceDirectory } = this;
    const { productionCandidate } = this.session.target;
    const screenshotDirectory = join(evidenceDirectory, 'screenshots');
    const staged = {};
    const seenHashes = new Set();
    const seenDestinations = new Set();
    for (const name of SCREENSHOT_NAMES) {
      const source = requireAbsolute(capture.screenshots[name], `${name} screenshot`);
      const destination = join(
        screenshotDirectory,
        productionCandidate ? basename(source) : `${name}.png`,
      );
      if (seenDestinations.has(destination)) {
        throw new Error('Omarchy screenshot output paths must be distinct');
      }
      seenDestinations.add(destination);
      const sourceContents = readPng(source, `${name} screenshot`);
      if (sha256(sourceContents) !== capture.sourceHashes[name]) {
        throw new Error(`${name} screenshot changed after its transcript capture`);
      }
      writeArtifactAtomic(destination, sourceContents);
      const digest = sha256(ensurePng(destination, evidenceDirectory));
      if (seenHashes.has(digest)) throw new Error('Visual screenshots must be distinct');
      seenHashes.add(digest);
      staged[name] = {
        path: relative(evidenceDirectory, destination),
        sha256: digest,
        ...(productionCandidate
          ? { capturedPath: source, capturedSha256: capture.sourceHashes[name] }
          : {}),
      };
    }
    return staged;
  }

  async requestApproval(screenshotEvidence) {
    const { dependencies, target } = this.session;
    const approvalBinding = sha256(
      json({
        screenshots: screenshotEvidence,
        checks: VISUAL_CHECKS,
        reviewMatrix: TASK_3_3_REVIEW_MATRIX,
        automatedOnly: TASK_3_3_AUTOMATED_ONLY,
      }),
    );
    const visualReview = await dependencies.requestVisualReview({
      screenshots: Object.fromEntries(
        Object.entries(screenshotEvidence).map(([name, artifact]) => [
          name,
          { path: join(this.evidenceDirectory, artifact.path), sha256: artifact.sha256 },
        ]),
      ),
      checklist: VISUAL_CHECKS,
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
    const bindingRequired =
      existsSync(join(target.candidatePath, '.pimpampum-plugin-owner.json')) ||
      visualReview.artifactSetHash !== undefined;
    if (bindingRequired && visualReview.artifactSetHash !== approvalBinding) {
      throw new Error('Visual approval does not match the staged screenshot artifacts');
    }
    return visualReview;
  }

  buildEvidence(artifacts, screenshotEvidence, visualReview) {
    const { session, evidenceDirectory } = this;
    const { dependencies, target } = session;
    const versionEntry = session.entry('version');
    return {
      schemaVersion: 2,
      status: 'passed',
      validatedAt: dependencies.now().toISOString(),
      omarchyVersion: versionEntry.stdout.trim().replace(/^Omarchy\s+/iu, ''),
      candidateHash: target.initialCandidateHash,
      validatedCandidatePath: target.candidatePath,
      environment: {
        platform: dependencies.platform,
        uid: dependencies.uid,
        waylandDisplay: dependencies.environment.WAYLAND_DISPLAY,
        explicitOptIn: true,
      },
      transcript: {
        path: relative(evidenceDirectory, artifacts.transcript),
        sha256: sha256(readFileSync(artifacts.transcript)),
      },
      baseline: {
        beforePath: relative(evidenceDirectory, artifacts.before),
        beforeSha256: sha256(readFileSync(artifacts.before)),
        afterPath: relative(evidenceDirectory, artifacts.after),
        afterSha256: sha256(readFileSync(artifacts.after)),
        restored: true,
      },
      screenshots: screenshotEvidence,
      visualReview: {
        approved: true,
        reviewer: visualReview.reviewer.trim(),
        reviewedAt: visualReview.reviewedAt,
        checks: VISUAL_CHECKS,
      },
      cleanup: { completed: true, baselineRestored: true, evidenceWrittenAfterCleanup: true },
    };
  }

  /** Runs after cleanup: nothing here may touch the Omarchy installation any more. */
  async write(capture) {
    const { session } = this;
    const { dependencies, target } = session;
    try {
      assertCandidateUnchanged(
        target.candidatePath,
        target.initialCandidateHash,
        'before evidence generation',
      );
      const artifacts = this.writeArtifacts();
      const screenshotEvidence = this.stageScreenshots(capture);
      const visualReview = await this.requestApproval(screenshotEvidence);
      assertCandidateUnchanged(
        target.candidatePath,
        target.initialCandidateHash,
        'at evidence write',
      );
      const evidence = this.buildEvidence(artifacts, screenshotEvidence, visualReview);
      dependencies.writeEvidenceAtomic(target.evidencePath, evidence);
      return evidence;
    } catch (error) {
      this.writeFailureDiagnostic([error]);
      throw error;
    }
  }
}
