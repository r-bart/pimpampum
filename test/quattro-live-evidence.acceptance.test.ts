/**
 * @generated-from thoughts/specs/2026-08-25_desktop-status-integrations.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * Supplemental executable contract for the Task 4.4 live Quattro gate.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repositoryRoot = process.cwd();
const checker = join(repositoryRoot, 'scripts/check-quattro-evidence.mjs');
const runner = join(repositoryRoot, 'scripts/test-omarchy-live.mjs');
const roots: string[] = [];

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function screenshotPng(seed: number): Buffer {
  const width = 320;
  const height = 180;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = (x * 17 + y * 7 + seed * 31) % 256;
      pixels[offset + 1] = (x * 3 + y * 19 + seed * 47) % 256;
      pixels[offset + 2] = (x * 11 + y * 5 + seed * 61) % 256;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function candidateHash(directory: string): string {
  const files = ['BarWidget.qml', 'manifest.json'];
  const hash = createHash('sha256');
  for (const name of files) {
    const contents = readFileSync(join(directory, name));
    hash.update(name.split(sep).join('/'));
    hash.update('\0');
    hash.update(String(contents.length));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-quattro-evidence-'));
  roots.push(root);
  const candidate = join(root, 'candidate');
  const evidenceDirectory = join(root, 'evidence');
  const artifacts = join(evidenceDirectory, 'artifacts');
  const screenshots = join(evidenceDirectory, 'screenshots');
  mkdirSync(candidate, { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(screenshots, { recursive: true });
  writeFileSync(join(candidate, 'BarWidget.qml'), 'import QtQuick\nItem {}\n');
  writeFileSync(join(candidate, 'manifest.json'), '{"schemaVersion":1}\n');

  const cli = '/opt/pimpampum/dist/cli.js';
  const emptyShell = JSON.stringify({ bar: { left: [], center: [], right: [] } });
  const transcript = [
    command('version', 'omarchy', ['--version'], 'Omarchy 4.0.0\n'),
    command('validation', 'omarchy', ['plugin', 'validate', candidate], 'valid\n'),
    command('baseline-before-shell', 'omarchy-shell', ['shell', 'listShellConfig'], emptyShell),
    command('baseline-before-plugins', 'omarchy', ['plugin', 'list', '--json'], '{"plugins":[]}\n'),
    command(
      'baseline-before-systemd',
      'systemctl',
      ['--user', 'show', 'pimpampum.service', '--property=LoadState,UnitFileState,ActiveState'],
      'LoadState=not-found\nUnitFileState=\nActiveState=inactive\n',
    ),
    command('install', process.execPath, [cli, 'install'], '{"installed":true}\n'),
    command('status-online', process.execPath, [cli, 'status'], '{"running":true}\n'),
    command('seed-workspace', process.execPath, [cli, 'workspace:add', 'live', 'Live', root]),
    command(
      'seed-project',
      process.execPath,
      [cli, 'project:create', 'live', 'active', 'Active'],
      '{"id":"project-id","revision":1}\n',
    ),
    command(
      'ready-active-project',
      process.execPath,
      [cli, 'project:ready', 'project-id', '1'],
      '{"id":"project-id","revision":2}\n',
    ),
    command('seed-task', process.execPath, [cli, 'task:create', 'project-id', 'Live task']),
    command('seed-claim', process.execPath, [cli, 'work:start', 'task', 'task-id', 'live-agent']),
    command(
      'seed-completed-project',
      process.execPath,
      [cli, 'project:create', 'live', 'completed', 'Completed'],
      '{"id":"completed-id","revision":1}\n',
    ),
    command(
      'ready-completed-project',
      process.execPath,
      [cli, 'project:ready', 'completed-id', '1'],
      '{"id":"completed-id","revision":2}\n',
    ),
    command(
      'start-completed-project',
      process.execPath,
      [cli, 'work:start', 'project', 'completed-id', 'completion-agent'],
      '{"revision":3}\n',
    ),
    command(
      'complete-project',
      process.execPath,
      [cli, 'work:complete', 'project', 'completed-id', 'completion-agent', '3', 'Complete'],
      '{"state":"done"}\n',
    ),
    command(
      'overview-active-and-complete',
      process.execPath,
      [cli, 'overview'],
      '{"projects":[{"id":"project-id","status":"active"},{"id":"completed-id","status":"complete"}]}\n',
    ),
    command('hot-reload', 'omarchy-shell', ['shell', 'rescanPlugins'], 'ok\n'),
    command(
      'post-rescan-plugin-loaded',
      'omarchy',
      ['plugin', 'list', '--json'],
      '{"plugins":[{"id":"dev.pimpampum.status","enabled":true}]}\n',
    ),
    command('offline', 'systemctl', ['--user', 'stop', 'pimpampum.service']),
    command('recovery', 'systemctl', ['--user', 'start', 'pimpampum.service']),
    command('status-recovered', process.execPath, [cli, 'status'], '{"running":true}\n'),
    command('uninstall', process.execPath, [cli, 'uninstall'], '{"uninstalled":true}\n'),
    command('baseline-after-shell', 'omarchy-shell', ['shell', 'listShellConfig'], emptyShell),
    command('baseline-after-plugins', 'omarchy', ['plugin', 'list', '--json'], '{"plugins":[]}\n'),
    command(
      'baseline-after-systemd',
      'systemctl',
      ['--user', 'show', 'pimpampum.service', '--property=LoadState,UnitFileState,ActiveState'],
      'LoadState=not-found\nUnitFileState=\nActiveState=inactive\n',
    ),
  ];
  const transcriptPath = join(artifacts, 'transcript.json');
  writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);

  const baseline = {
    shellConfig: { bar: { left: [], center: [], right: [] } },
    shellJson: { exists: false, sha256: null },
    plugin: { exists: false },
    service: { unitExists: false, enabled: false, running: false },
    receipt: { exists: false },
    ownedPaths: [],
  };
  const beforePath = join(artifacts, 'baseline-before.json');
  const afterPath = join(artifacts, 'baseline-after.json');
  writeFileSync(beforePath, `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(afterPath, `${JSON.stringify(baseline, null, 2)}\n`);

  const screenshotEntries = Object.fromEntries(
    ['activePopout', 'completedPopout', 'offlineStale', 'recovered', 'workspaceOpen'].map(
      (name, index) => {
        const path = join(screenshots, `${name}.png`);
        const contents = screenshotPng(index + 1);
        writeFileSync(path, contents);
        return [name, { path: relative(evidenceDirectory, path), sha256: sha256(contents) }];
      },
    ),
  );
  const validatedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 2,
    status: 'passed',
    validatedAt,
    omarchyVersion: '4.0.0',
    candidateHash: candidateHash(candidate),
    validatedCandidatePath: candidate,
    environment: {
      platform: 'linux',
      uid: 1000,
      waylandDisplay: 'wayland-1',
      explicitOptIn: true,
    },
    transcript: {
      path: relative(evidenceDirectory, transcriptPath),
      sha256: sha256(readFileSync(transcriptPath)),
    },
    baseline: {
      beforePath: relative(evidenceDirectory, beforePath),
      beforeSha256: sha256(readFileSync(beforePath)),
      afterPath: relative(evidenceDirectory, afterPath),
      afterSha256: sha256(readFileSync(afterPath)),
      restored: true,
    },
    screenshots: screenshotEntries,
    visualReview: {
      approved: true,
      reviewer: 'Roberto',
      reviewedAt: validatedAt,
      checks: {
        themeInheritance: 'activePopout',
        horizontalTopLayout: 'activePopout',
        popoutCoordination: 'activePopout',
        activeCount: 'activePopout',
        completedCollapse: 'completedPopout',
        offlineRecovery: 'offlineStale',
        recovered: 'recovered',
        workspaceOpen: 'workspaceOpen',
      },
    },
    cleanup: { completed: true, baselineRestored: true, evidenceWrittenAfterCleanup: true },
  };
  const evidencePath = join(evidenceDirectory, 'quattro-live.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { root, candidate, evidenceDirectory, evidencePath, evidence, transcriptPath, afterPath };
}

type LiveEvidence = ReturnType<typeof fixture>['evidence'];

function command(label: string, executable: string, arguments_: string[], stdout = '') {
  return {
    label,
    executable,
    arguments: arguments_,
    exitCode: 0,
    stdout,
    stderr: '',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

function writeEvidence(path: string, evidence: unknown): void {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

function check(evidencePath: string, candidate: string) {
  return spawnSync(process.execPath, [checker, evidencePath, candidate], { encoding: 'utf8' });
}

function fakeRunnerDependencies(
  root: string,
  overrides: {
    platform?: string;
    uid?: number;
    environment?: Record<string, string | undefined>;
    existingPaths?: string[];
    failureLabel?: string;
  } = {},
) {
  const events: string[] = [];
  const baseline = {
    shellConfig: { bar: { left: [], center: [], right: [] } },
    shellJson: { exists: false, sha256: null },
    plugin: { exists: false },
    service: { unitExists: false, enabled: false, running: false },
    receipt: { exists: false },
    ownedPaths: [],
  };
  const commandResults = new Map<string, { exitCode: number; stdout: string; stderr: string }>([
    ['version', { exitCode: 0, stdout: 'Omarchy 4.0.0\n', stderr: '' }],
    ['validation', { exitCode: 0, stdout: 'valid\n', stderr: '' }],
    ['install', { exitCode: 0, stdout: '{"installed":true}\n', stderr: '' }],
    ['status-online', { exitCode: 0, stdout: '{"running":true}\n', stderr: '' }],
    ['seed-workspace', { exitCode: 0, stdout: '{"id":"live"}\n', stderr: '' }],
    ['seed-project', { exitCode: 0, stdout: '{"id":"project-id","revision":1}\n', stderr: '' }],
    [
      'ready-active-project',
      { exitCode: 0, stdout: '{"id":"project-id","revision":2}\n', stderr: '' },
    ],
    ['seed-task', { exitCode: 0, stdout: '{"id":"task-id"}\n', stderr: '' }],
    ['seed-claim', { exitCode: 0, stdout: '{"revision":2}\n', stderr: '' }],
    [
      'seed-completed-project',
      { exitCode: 0, stdout: '{"id":"completed-id","revision":1}\n', stderr: '' },
    ],
    [
      'ready-completed-project',
      { exitCode: 0, stdout: '{"id":"completed-id","revision":2}\n', stderr: '' },
    ],
    ['start-completed-project', { exitCode: 0, stdout: '{"revision":3}\n', stderr: '' }],
    ['complete-project', { exitCode: 0, stdout: '{"state":"done"}\n', stderr: '' }],
    [
      'overview-active-and-complete',
      {
        exitCode: 0,
        stdout:
          '{"projects":[{"id":"project-id","status":"active"},{"id":"completed-id","status":"complete"}]}\n',
        stderr: '',
      },
    ],
    ['hot-reload', { exitCode: 0, stdout: 'ok\n', stderr: '' }],
    [
      'post-rescan-plugin-loaded',
      {
        exitCode: 0,
        stdout: '{"plugins":[{"id":"dev.pimpampum.status","enabled":true}]}\n',
        stderr: '',
      },
    ],
    ['offline', { exitCode: 0, stdout: '', stderr: '' }],
    ['recovery', { exitCode: 0, stdout: '', stderr: '' }],
    ['status-recovered', { exitCode: 0, stdout: '{"running":true}\n', stderr: '' }],
    ['uninstall', { exitCode: 0, stdout: '{"uninstalled":true}\n', stderr: '' }],
  ]);
  const execute = vi.fn(
    async (input: { label: string; executable: string; arguments: string[] }) => {
      events.push(input.label);
      if (input.label === overrides.failureLabel) throw new Error(`failed ${input.label}`);
      return commandResults.get(input.label) ?? { exitCode: 0, stdout: '', stderr: '' };
    },
  );
  const captureScreenshot = vi.fn(async (name: string) => {
    const label = `capture-${name}`;
    events.push(label);
    if (label === overrides.failureLabel) throw new Error(`failed ${label}`);
    const path = join(root, `${name}.png`);
    writeFileSync(path, screenshotPng(events.length));
    return path;
  });
  const snapshotBaseline = vi.fn(async () => structuredClone(baseline));
  const writeEvidenceAtomic = vi.fn((path: string, evidence: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeEvidence(path, evidence);
  });
  return {
    platform: overrides.platform ?? 'linux',
    uid: overrides.uid ?? 1000,
    environment:
      overrides.environment ??
      ({ PIMPAMPUM_QUATTRO_LIVE: '1', WAYLAND_DISPLAY: 'wayland-1' } as Record<
        string,
        string | undefined
      >),
    existingPaths: overrides.existingPaths ?? [],
    now: () => new Date('2026-08-26T02:00:00.000Z'),
    events,
    execute,
    captureScreenshot,
    snapshotBaseline,
    requestVisualReview: vi.fn(async () => ({
      approved: true,
      reviewer: 'Roberto',
      reviewedAt: '2026-08-26T02:00:00.000Z',
    })),
    writeEvidenceAtomic,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Task 4.4: reproducible live Quattro evidence', () => {
  it('FR-4: ships an opt-in live runner and exposes it through the release command', () => {
    // Spec: FR-4 / Local Quattro smoke
    const scripts = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(() => readFileSync(runner)).not.toThrow();
    expect(scripts.scripts?.['test:e2e:omarchy:live']).toBe('node scripts/test-omarchy-live.mjs');
  });

  it('Task 4.4: rejects legacy evidence made only from authored true flags', () => {
    // Spec: Task 4.4 / no inferred live result
    const state = fixture();
    const legacy = {
      schemaVersion: 1,
      status: 'passed',
      omarchyVersion: '4.0.0',
      validatedAt: new Date().toISOString(),
      candidateHash: state.evidence.candidateHash,
      validatedCandidatePath: state.candidate,
      commands: {
        version: command('version', 'omarchy', ['--version'], 'Omarchy 4.0.0\n'),
        validation: {
          ...command('validation', 'omarchy', ['plugin', 'validate', state.candidate], 'valid\n'),
          passed: true,
        },
      },
      smoke: Object.fromEntries(
        [
          'pluginValidation',
          'hotReload',
          'themeInheritance',
          'horizontalTopLayout',
          'popoutCoordination',
          'activeCount',
          'completedCollapse',
          'offlineRecovery',
          'workspaceOpen',
        ].map((name) => [name, true]),
      ),
    };
    writeEvidence(state.evidencePath, legacy);
    expect(check(state.evidencePath, state.candidate).status).not.toBe(0);
  });

  it('Task 4.4: accepts complete schema-v2 evidence bound to the candidate and artifacts', () => {
    // Spec: Task 4.4 / machine-readable evidence
    const state = fixture();
    const result = check(state.evidencePath, state.candidate);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Verified Quattro 4.0.0 live evidence');
  });

  it('Task 4.4: rejects tampered transcripts and missing exact lifecycle commands', () => {
    // Spec: Task 4.4 / exact executable and argument arrays
    const state = fixture();
    expect(check(state.evidencePath, state.candidate).status).toBe(0);
    const transcript = JSON.parse(readFileSync(state.transcriptPath, 'utf8')) as Array<{
      label: string;
      arguments: string[];
      shell?: boolean;
    }>;
    transcript.find((entry) => entry.label === 'uninstall')!.arguments = ['serve'];
    transcript[0]!.shell = true;
    writeFileSync(state.transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
    state.evidence.transcript.sha256 = sha256(readFileSync(state.transcriptPath));
    writeEvidence(state.evidencePath, state.evidence);
    expect(check(state.evidencePath, state.candidate).status).not.toBe(0);
  });

  it('Task 4.4: rejects cleanup claims when the exact before and after snapshots differ', () => {
    // Spec: EC-14 / preserve existing shell configuration
    const state = fixture();
    expect(check(state.evidencePath, state.candidate).status).toBe(0);
    const after = JSON.parse(readFileSync(state.afterPath, 'utf8')) as {
      service: { unitExists: boolean };
    };
    after.service.unitExists = true;
    writeFileSync(state.afterPath, `${JSON.stringify(after, null, 2)}\n`);
    state.evidence.baseline.afterSha256 = sha256(readFileSync(state.afterPath));
    writeEvidence(state.evidencePath, state.evidence);
    expect(check(state.evidencePath, state.candidate).status).not.toBe(0);
  });

  it('Task 4.4: rejects placeholder, duplicate, tampered, escaped, and symlinked screenshots', () => {
    // Spec: FR-4 / actual-machine visual smoke
    for (const variant of ['placeholder', 'duplicate', 'hash', 'outside', 'symlink'] as const) {
      const state = fixture();
      expect(check(state.evidencePath, state.candidate).status).toBe(0);
      const entry = state.evidence.screenshots.activePopout!;
      if (variant === 'placeholder') {
        const path = join(state.evidenceDirectory, entry.path);
        const tiny = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        );
        writeFileSync(path, tiny);
        entry.sha256 = sha256(tiny);
      }
      if (variant === 'duplicate') {
        const completed = state.evidence.screenshots.completedPopout!;
        const activeContents = readFileSync(join(state.evidenceDirectory, entry.path));
        writeFileSync(join(state.evidenceDirectory, completed.path), activeContents);
        completed.sha256 = sha256(activeContents);
      }
      if (variant === 'hash') entry.sha256 = '0'.repeat(64);
      if (variant === 'outside') entry.path = '../outside.png';
      if (variant === 'symlink') {
        const original = join(state.evidenceDirectory, entry.path);
        const target = join(state.root, 'target.png');
        cpSync(original, target);
        rmSync(original);
        symlinkSync(target, original);
      }
      writeEvidence(state.evidencePath, state.evidence);
      expect(check(state.evidencePath, state.candidate).status, variant).not.toBe(0);
    }
  });

  it('Task 4.4: requires an explicit current human review of every visual check', () => {
    // Spec: FR-4 / visual verification on actual Quattro
    for (const mutate of [
      (evidence: LiveEvidence) => {
        evidence.visualReview.approved = false;
      },
      (evidence: LiveEvidence) => {
        evidence.visualReview.reviewer = '   ';
      },
      (evidence: LiveEvidence) => {
        delete (evidence.visualReview.checks as Partial<typeof evidence.visualReview.checks>)
          .workspaceOpen;
      },
    ]) {
      const state = fixture();
      expect(check(state.evidencePath, state.candidate).status).toBe(0);
      mutate(state.evidence);
      writeEvidence(state.evidencePath, state.evidence);
      expect(check(state.evidencePath, state.candidate).status).not.toBe(0);
    }
  });

  it('Task 4.4: rejects stale, future-dated, and post-validation visual reviews', () => {
    // Spec: Task 4.4 / current target-machine evidence
    for (const mutate of [
      (evidence: LiveEvidence) => {
        evidence.validatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
        evidence.visualReview.reviewedAt = evidence.validatedAt;
      },
      (evidence: LiveEvidence) => {
        evidence.validatedAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      },
      (evidence: LiveEvidence) => {
        evidence.visualReview.reviewedAt = new Date(
          Date.parse(evidence.validatedAt) + 10 * 60 * 1_000,
        ).toISOString();
      },
    ]) {
      const state = fixture();
      expect(check(state.evidencePath, state.candidate).status).toBe(0);
      mutate(state.evidence);
      writeEvidence(state.evidencePath, state.evidence);
      expect(check(state.evidencePath, state.candidate).status).not.toBe(0);
    }
  });

  it('Task 4.4: runner preflight observably refuses unsafe hosts and existing installations', async () => {
    // Spec: EC-14 / do not overwrite user-owned state
    const module = (await import(`${pathToFileURL(runner).href}?test=${Date.now()}`)) as {
      default: (dependencies: ReturnType<typeof fakeRunnerDependencies>) => {
        run(input: {
          candidatePath: string;
          evidencePath: string;
          cliPath: string;
        }): Promise<unknown>;
      };
    };
    for (const overrides of [
      { platform: 'darwin' },
      { uid: 0 },
      { environment: { WAYLAND_DISPLAY: 'wayland-1' } },
      { existingPaths: ['/owned/plugin'] },
    ]) {
      const state = fixture();
      const dependencies = fakeRunnerDependencies(state.root, overrides);
      await expect(
        module.default(dependencies).run({
          candidatePath: state.candidate,
          evidencePath: join(state.root, 'runner-evidence.json'),
          cliPath: '/opt/pimpampum/dist/cli.js',
        }),
      ).rejects.toThrow();
      expect(dependencies.execute).not.toHaveBeenCalled();
      expect(dependencies.writeEvidenceAtomic).not.toHaveBeenCalled();
    }
  });

  it('Task 4.4: every post-install failure uninstalls, restores baseline, and writes no evidence', async () => {
    // Spec: EC-14 / partial-failure rollback and evidence integrity
    const module = (await import(`${pathToFileURL(runner).href}?test=${Date.now()}`)) as {
      default: (dependencies: ReturnType<typeof fakeRunnerDependencies>) => {
        run(input: {
          candidatePath: string;
          evidencePath: string;
          cliPath: string;
        }): Promise<unknown>;
      };
    };
    for (const failureLabel of [
      'seed-project',
      'hot-reload',
      'offline',
      'capture-activePopout',
      'recovery',
    ]) {
      const state = fixture();
      const dependencies = fakeRunnerDependencies(state.root, { failureLabel });
      const output = join(state.root, 'atomic', 'quattro-live.json');
      await expect(
        module.default(dependencies).run({
          candidatePath: state.candidate,
          evidencePath: output,
          cliPath: '/opt/pimpampum/dist/cli.js',
        }),
      ).rejects.toThrow();
      expect(dependencies.events).toContain('uninstall');
      expect(dependencies.snapshotBaseline).toHaveBeenCalledTimes(2);
      expect(dependencies.writeEvidenceAtomic).not.toHaveBeenCalled();
      expect(() => readFileSync(output)).toThrow();
    }
  });
});
