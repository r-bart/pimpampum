import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, contents: Buffer): Buffer {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(contents.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, contents])));
  return Buffer.concat([length, name, contents, checksum]);
}

function png(seed: number): Buffer {
  const width = 320;
  const height = 180;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width * 4 + 1);
    pixels[offset] = 0;
    for (let index = 1; index <= width * 4; index += 1) {
      pixels[offset + index] = (offset + index + seed * 31) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function commandResult(stdout = '', exitCode = 0) {
  return { exitCode, stdout, stderr: '' };
}

function treeHash(root: string): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  const digest = createHash('sha256');
  for (const path of files.sort((left, right) => left.localeCompare(right))) {
    const contents = readFileSync(path);
    digest.update(relative(root, path).split(sep).join('/'));
    digest.update('\0');
    digest.update(String(contents.length));
    digest.update('\0');
    digest.update(contents);
    digest.update('\0');
  }
  return digest.digest('hex');
}

const baseline = {
  shellConfig: { bar: { left: [], center: [], right: [] } },
  shellJson: { exists: false, sha256: null },
  plugin: { exists: false },
  service: { unitExists: false, enabled: false, running: false },
  receipt: { exists: false },
  ownedPaths: [],
};

function responseFor(label: string) {
  const shell = `${JSON.stringify(baseline.shellConfig)}\n`;
  const responses: Record<string, ReturnType<typeof commandResult>> = {
    version: commandResult('Omarchy 4.0.0\n'),
    validation: commandResult(),
    'validation-snapshot': commandResult(),
    'baseline-before-shell': commandResult(shell),
    'baseline-before-plugins': commandResult('{"plugins":[]}\n'),
    'baseline-before-systemd': commandResult(
      'LoadState=not-found\nUnitFileState=\nActiveState=inactive\n',
      4,
    ),
    install: commandResult('{"installed":true,"receiptPath":"/tmp/fake-receipt.json"}\n'),
    'status-online': commandResult('{"running":true}\n'),
    'seed-workspace': commandResult('{"id":"live"}\n'),
    'seed-project': commandResult('{"id":"active-id","revision":1}\n'),
    'seed-active-spec': commandResult('{"id":"active-spec-id","revision":1}\n'),
    'ready-active-spec': commandResult('{"id":"active-spec-id","revision":2}\n'),
    'open-active-project': commandResult('{"id":"active-id","revision":2}\n'),
    'seed-task': commandResult('{"id":"task-id"}\n'),
    'seed-claim': commandResult('{"task":{"revision":1}}\n'),
    'seed-completed-project': commandResult('{"id":"complete-id","revision":1}\n'),
    'seed-completed-spec': commandResult('{"id":"complete-spec-id","revision":1}\n'),
    'ready-completed-spec': commandResult('{"id":"complete-spec-id","revision":2}\n'),
    'open-completed-project': commandResult('{"id":"complete-id","revision":2}\n'),
    'start-completed-spec': commandResult('{"spec":{"revision":2}}\n'),
    'complete-spec': commandResult('{"id":"complete-spec-id","state":"done","revision":3}\n'),
    'complete-project': commandResult('{"id":"complete-id","state":"done","revision":3}\n'),
    'overview-active-and-complete': commandResult(
      '{"projects":[{"id":"active-id","status":"active"},{"id":"complete-id","status":"complete"}]}\n',
    ),
    'hot-reload': commandResult(),
    'post-rescan-plugin-loaded': commandResult(
      '{"plugins":[{"id":"dev.pimpampum.status","enabled":true}]}\n',
    ),
    offline: commandResult(),
    recovery: commandResult(),
    'status-recovered': commandResult('{"running":true}\n'),
    'workspace-open': commandResult(),
    uninstall: commandResult('{"uninstalled":true}\n'),
    'baseline-after-shell': commandResult(shell),
    'baseline-after-plugins': commandResult('{"plugins":[]}\n'),
    'baseline-after-systemd': commandResult(
      'LoadState=not-found\nUnitFileState=\nActiveState=inactive\n',
      4,
    ),
  };
  const response = responses[label];
  if (!response) throw new Error(`Unexpected command ${label}`);
  return response;
}

type ExecuteInput = {
  label: string;
  executable: string;
  arguments: string[];
  timeoutMs: number;
  allowBackground?: boolean;
};

type ReviewInput = {
  screenshots: Record<string, { path: string; sha256: string }>;
  checklist: Record<string, string>;
  artifactSetHash: string;
};

type HarnessOptions = {
  executeHook?: (input: ExecuteInput, harness: Harness) => Promise<void> | void;
  reviewHook?: (
    input: ReviewInput,
  ) => Promise<{ artifactSetHash?: string }> | { artifactSetHash?: string };
  existingEvidence?: string;
};

type Harness = ReturnType<typeof createHarness>;

function createHarness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-live-runner-'));
  roots.push(root);
  const candidate = join(root, 'pimpampum-status');
  cpSync(join(process.cwd(), 'integrations/omarchy/pimpampum-status'), candidate, {
    recursive: true,
  });
  const evidenceRoot = join(root, 'evidence');
  const evidencePath = join(evidenceRoot, 'quattro-live.json');
  mkdirSync(evidenceRoot);
  if (options.existingEvidence) writeFileSync(evidencePath, options.existingEvidence);
  let tick = Date.now() - 10_000;
  let screenshotSequence = 0;
  let signalHandler: ((signal: string) => Promise<void>) | undefined;
  const harness = {
    root,
    candidate,
    evidenceRoot,
    evidencePath,
    get signalHandler() {
      return signalHandler;
    },
    dependencies: undefined as unknown as Record<string, unknown>,
  };
  const execute = vi.fn(async (input: ExecuteInput) => {
    await options.executeHook?.(input, harness);
    if (input.label.startsWith('screenshot-')) {
      const path = join(root, `capture-${input.label}-${(screenshotSequence += 1)}.png`);
      writeFileSync(path, png(screenshotSequence));
      return commandResult(`${path}\n`);
    }
    return responseFor(input.label);
  });
  const requestVisualReview = vi.fn(async (input: ReviewInput) => ({
    approved: true,
    reviewer: 'Roberto',
    reviewedAt: new Date(tick + 10).toISOString(),
    artifactSetHash: (await options.reviewHook?.(input))?.artifactSetHash ?? input.artifactSetHash,
  }));
  harness.dependencies = {
    platform: 'linux',
    uid: 1000,
    environment: { PIMPAMPUM_QUATTRO_LIVE: '1', WAYLAND_DISPLAY: 'wayland-1' },
    allowedEvidenceRoot: evidenceRoot,
    trustedEvidenceAnchor: root,
    existingPaths: [],
    now: () => new Date((tick += 10)),
    execute,
    abortActiveCommands: vi.fn(async () => {}),
    prepareImmutableInstall: vi.fn(async () => {
      const stage = mkdtempSync(join(tmpdir(), 'pimpampum-quattro-stage-'));
      roots.push(stage);
      const stagedCandidate = join(stage, 'integrations/omarchy/pimpampum-status');
      mkdirSync(dirname(stagedCandidate), { recursive: true });
      cpSync(candidate, stagedCandidate, { recursive: true });
      return {
        cliPath: '/opt/pimpampum/dist/cli.js',
        candidatePath: stagedCandidate,
        async dispose() {
          rmSync(stage, { recursive: true, force: true });
        },
      };
    }),
    verifyInstalledCandidate: vi.fn(async () => {}),
    prepareScreenshot: vi.fn(async () => {}),
    resolveScreenshotPath: vi.fn((stdout: string) => stdout.trim()),
    snapshotBaseline: vi.fn(async () => structuredClone(baseline)),
    captureScreenshot: vi.fn(async (name: string) => {
      const path = join(root, `${name}.png`);
      writeFileSync(path, png((screenshotSequence += 1)));
      return path;
    }),
    requestVisualReview,
    registerSignalHandler: vi.fn((handler: (signal: string) => Promise<void>) => {
      signalHandler = handler;
      return () => {
        signalHandler = undefined;
      };
    }),
    writeEvidenceAtomic: vi.fn((path: string, evidence: unknown) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    }),
  };
  return harness;
}

async function runnerFor(dependencies: Record<string, unknown>) {
  const module = (await import(
    `${pathToFileURL(join(process.cwd(), 'scripts/test-omarchy-live.mjs')).href}?test=${Date.now()}-${Math.random()}`
  )) as {
    default: (input: Record<string, unknown>) => {
      run(options: {
        candidatePath: string;
        evidencePath: string;
        cliPath: string;
        workspacePath: string;
      }): Promise<unknown>;
    };
  };
  return module.default(dependencies);
}

async function realDependenciesForTest(root: string, repositoryRoot = process.cwd()) {
  const module = (await import(
    `${pathToFileURL(join(process.cwd(), 'scripts/test-omarchy-live.mjs')).href}?real=${Date.now()}-${Math.random()}`
  )) as {
    createRealDependencies: (
      repositoryRoot: string,
      homeDirectory: string,
      options?: Record<string, unknown>,
    ) => {
      execute(input: {
        executable: string;
        arguments: string[];
        timeoutMs: number;
      }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
      prepareImmutableInstall(input: {
        candidatePath: string;
        cliPath: string;
        expectedCandidateHash: string;
      }): Promise<{ cliPath: string; candidatePath: string; dispose(): Promise<void> }>;
      verifyInstalledCandidate(input: {
        stagedCandidatePath: string;
        expectedCandidateHash: string;
        receiptPath: string;
        cliPath: string;
      }): Promise<void>;
    };
  };
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return module.createRealDependencies(repositoryRoot, home, {
    dataDirectory: join(root, 'data'),
    screenshotDirectory: join(root, 'screenshots'),
    existingPaths: [],
  });
}

function waitForChild(child: ReturnType<typeof spawn>, pattern: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let signalled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for child output: ${stdout} ${stderr}`));
    }, 5_000);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!signalled && stdout.includes('READY')) {
        signalled = true;
        child.kill(pattern as NodeJS.Signals);
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runHarness(harness: Harness) {
  return (await runnerFor(harness.dependencies)).run({
    candidatePath: harness.candidate,
    evidencePath: harness.evidencePath,
    cliPath: '/opt/pimpampum/dist/cli.js',
    workspacePath: harness.root,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Quattro live runner hardening', () => {
  it('uses the documented Omarchy screenshot command and controlled output directory', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/test-omarchy-live.mjs'), 'utf8');
    expect(source).toContain('OMARCHY_SCREENSHOT_DIR: screenshotRoot');
    expect(source).toContain("arguments: ['capture', 'screenshot', 'fullscreen', 'save']");
    expect(source).not.toContain(
      "arguments: ['capture', 'screenshot', 'fullscreen', 'save', path]",
    );
  });

  it('uses a read-only real candidate snapshot independent of later source mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-immutable-stage-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const candidate = join(repository, 'integrations/omarchy/pimpampum-status');
    mkdirSync(dirname(candidate), { recursive: true });
    cpSync(join(process.cwd(), 'integrations/omarchy/pimpampum-status'), candidate, {
      recursive: true,
    });
    const dependencies = await realDependenciesForTest(root, repository);
    const staged = await dependencies.prepareImmutableInstall({
      candidatePath: candidate,
      cliPath: join(repository, 'dist/cli.js'),
      expectedCandidateHash: treeHash(candidate),
    });
    expect(staged.cliPath).toBe(join(repository, 'dist/cli.js'));
    expect(treeHash(staged.candidatePath)).toBe(treeHash(candidate));
    const stagedManifest = join(staged.candidatePath, 'manifest.json');
    expect(() => writeFileSync(stagedManifest, '{}\n')).toThrow();
    writeFileSync(join(candidate, 'manifest.json'), '{"mutated":true}\n');
    expect(readFileSync(stagedManifest, 'utf8')).not.toContain('mutated');
    await staged.dispose();
    expect(existsSync(staged.cliPath)).toBe(false);
  });

  it('verifies every installed plugin byte and mode against its receipt-owned transform', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-transform-proof-'));
    roots.push(root);
    const repository = join(root, 'repository');
    const candidate = join(repository, 'integrations/omarchy/pimpampum-status');
    mkdirSync(dirname(candidate), { recursive: true });
    cpSync(join(process.cwd(), 'integrations/omarchy/pimpampum-status'), candidate, {
      recursive: true,
    });
    const dependencies = await realDependenciesForTest(root, repository);
    const cliPath = join(repository, 'dist/cli.js');
    const expectedCandidateHash = treeHash(candidate);
    const staged = await dependencies.prepareImmutableInstall({
      candidatePath: candidate,
      cliPath,
      expectedCandidateHash,
    });
    const plugin = join(root, 'home/.config/omarchy/plugins/dev.pimpampum.status');
    cpSync(candidate, plugin, { recursive: true });
    const helper = `#!/bin/bash
set -euo pipefail

export PIMPAMPUM_DATA_DIR='${join(root, 'data')}'
export PIMPAMPUM_HOST='127.0.0.1'
export PIMPAMPUM_PORT='7337'
exec '${process.execPath}' '${cliPath}' overview
`;
    writeFileSync(join(plugin, 'pimpampum-overview'), helper);
    const backupHelper = `#!/bin/bash
set -euo pipefail

case \${1:-} in
  status|retry|disable)
    [[ $# -eq 1 ]] || { printf '%s\\n' 'pimpampum-backup: invalid arguments' >&2; exit 64; }
    ;;
  configure)
    [[ $# -eq 2 ]] || { printf '%s\\n' 'pimpampum-backup: configure requires one directory' >&2; exit 64; }
    ;;
  *)
    printf '%s\\n' 'pimpampum-backup: expected status, configure, retry, or disable' >&2
    exit 64
    ;;
esac

export PIMPAMPUM_DATA_DIR='${join(root, 'data')}'
export PIMPAMPUM_HOST='127.0.0.1'
export PIMPAMPUM_PORT='7337'
exec '${process.execPath}' '${cliPath}' backup "$@"
`;
    writeFileSync(join(plugin, 'pimpampum-backup'), backupHelper);
    const syncHelper = `#!/bin/bash
set -euo pipefail

case \${1:-} in
  status|now|pause|resume|conflicts|forget)
    [[ $# -eq 1 ]] || { printf '%s\\n' 'pimpampum-sync: invalid arguments' >&2; exit 64; }
    ;;
  configure)
    [[ $# -eq 2 ]] || { printf '%s\\n' 'pimpampum-sync: configure requires one directory' >&2; exit 64; }
    ;;
  *)
    printf '%s\\n' 'pimpampum-sync: expected status, configure, now, pause, resume, conflicts, or forget' >&2
    exit 64
    ;;
esac

export PIMPAMPUM_DATA_DIR='${join(root, 'data')}'
export PIMPAMPUM_HOST='127.0.0.1'
export PIMPAMPUM_PORT='7337'

if [[ $1 == configure ]]; then
  device_id=$(hostname | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-63)
  [[ -n $device_id ]] || device_id=linux
  exec '${process.execPath}' '${cliPath}' sync configure "$2" --device "$device_id" --json
fi

exec '${process.execPath}' '${cliPath}' sync "$1" --json
`;
    writeFileSync(join(plugin, 'pimpampum-sync'), syncHelper);
    const artifacts: Array<{ path: string; sha256: string; mode: number }> = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (lstatSync(path).isDirectory()) visit(path);
        else {
          const child = relative(plugin, path);
          const mode = [
            'install.sh',
            'uninstall.sh',
            'pimpampum-backup',
            'pimpampum-folder-picker',
            'pimpampum-overview',
            'pimpampum-sync',
          ].includes(child)
            ? 0o755
            : 0o644;
          chmodSync(path, mode);
          artifacts.push({
            path,
            sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
            mode,
          });
        }
      }
    };
    visit(plugin);
    const receiptPath = join(root, 'data/install-receipt.json');
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        adapter: 'systemd-omarchy-quattro',
        dataDirectory: join(root, 'data'),
        artifacts,
      }),
    );
    const verification = {
      stagedCandidatePath: staged.candidatePath,
      expectedCandidateHash,
      receiptPath,
      cliPath,
    };
    await dependencies.verifyInstalledCandidate(verification);
    writeFileSync(join(plugin, 'manifest.json'), '{"tampered":true}\n');
    await expect(dependencies.verifyInstalledCandidate(verification)).rejects.toThrow(
      'Installed receipt-owned plugin transform differs at manifest.json',
    );
    await staged.dispose();
  });

  it('stages immutable screenshots before named approval and produces accepted evidence', async () => {
    const harness = createHarness({
      reviewHook(input) {
        expect(Object.keys(input.checklist)).toContain('workspaceOpen');
        for (const artifact of Object.values(input.screenshots)) {
          expect(existsSync(artifact.path)).toBe(true);
          expect(createHash('sha256').update(readFileSync(artifact.path)).digest('hex')).toBe(
            artifact.sha256,
          );
        }
        return { artifactSetHash: input.artifactSetHash };
      },
    });
    await runHarness(harness);
    const checked = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts/check-quattro-evidence.mjs'),
        harness.evidencePath,
        harness.candidate,
        harness.root,
        harness.evidenceRoot,
      ],
      { encoding: 'utf8' },
    );
    expect(checked.status, checked.stderr).toBe(0);
    const evidence = JSON.parse(readFileSync(harness.evidencePath, 'utf8')) as {
      transcript: { path: string };
    };
    const transcript = JSON.parse(
      readFileSync(join(harness.evidenceRoot, evidence.transcript.path), 'utf8'),
    ) as Array<{ label: string; stdout: string }>;
    expect(transcript.find(({ label }) => label === 'validation')?.stdout).toBe('');
    expect(transcript.find(({ label }) => label === 'hot-reload')?.stdout).toBe('');
    const dependencies = harness.dependencies as {
      execute: ReturnType<typeof vi.fn>;
      prepareImmutableInstall: ReturnType<typeof vi.fn>;
      prepareScreenshot: ReturnType<typeof vi.fn>;
      verifyInstalledCandidate: ReturnType<typeof vi.fn>;
    };
    expect(
      dependencies.prepareScreenshot.mock.calls.find(([name]) => name === 'workspaceOpen')?.[1],
    ).toMatchObject({ instruction: expect.stringContaining('QML') });
    expect(
      dependencies.execute.mock.calls.every(
        (call) => (call[0] as ExecuteInput).timeoutMs === 30_000,
      ),
    ).toBe(true);
    const validationSnapshot = dependencies.execute.mock.calls
      .map((call) => call[0] as ExecuteInput)
      .find((input) => input.label === 'validation-snapshot');
    expect(validationSnapshot).toMatchObject({
      executable: 'omarchy',
      arguments: ['plugin', 'validate', expect.stringContaining('pimpampum-quattro-stage-')],
    });
    const sourceValidationOrder = dependencies.execute.mock.invocationCallOrder[
      dependencies.execute.mock.calls.findIndex(
        (call) => (call[0] as ExecuteInput).label === 'validation',
      )
    ] as number;
    expect(dependencies.prepareImmutableInstall.mock.invocationCallOrder[0]).toBeLessThan(
      sourceValidationOrder,
    );
    const screenshotCalls = dependencies.execute.mock.calls
      .map((call) => call[0] as ExecuteInput)
      .filter((input) => input.label.startsWith('screenshot-'));
    expect(screenshotCalls.map(({ label }) => label)).toEqual([
      'screenshot-activePopout',
      'screenshot-completedPopout',
      'screenshot-offlineStale',
      'screenshot-recovered',
      'screenshot-workspaceOpen',
    ]);
    expect(screenshotCalls.every((input) => input.executable === 'omarchy')).toBe(true);
    expect(
      screenshotCalls.every(
        (input) =>
          JSON.stringify(input.arguments) ===
          JSON.stringify(['capture', 'screenshot', 'fullscreen', 'save']),
      ),
    ).toBe(true);
    const installCall = dependencies.execute.mock.calls
      .map((call) => call[0] as ExecuteInput)
      .find((input) => input.label === 'install');
    expect(installCall?.arguments[0]).toBe('/opt/pimpampum/dist/cli.js');
    expect(dependencies.verifyInstalledCandidate).toHaveBeenCalledOnce();
    expect(dependencies.verifyInstalledCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptPath: '/tmp/fake-receipt.json',
        cliPath: '/opt/pimpampum/dist/cli.js',
        expectedCandidateHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
  });

  it('rejects candidate mutation immediately after validation', async () => {
    const harness = createHarness({
      executeHook(input, current) {
        if (input.label === 'validation') writeFileSync(join(current.candidate, 'mutation'), 'x');
      },
    });
    await expect(runHarness(harness)).rejects.toThrow('candidate changed after validation');
    const execute = (harness.dependencies as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(execute).not.toHaveBeenCalledWith(expect.objectContaining({ label: 'install' }));
  });

  it('archives old canonical evidence before mutation and leaves it invalid on failure', async () => {
    const oldEvidence = '{"schemaVersion":2,"status":"passed","old":true}\n';
    const harness = createHarness({
      existingEvidence: oldEvidence,
      executeHook(input) {
        if (input.label === 'seed-project') throw new Error('seed failed');
      },
    });
    await expect(runHarness(harness)).rejects.toThrow('seed failed');
    expect(existsSync(harness.evidencePath)).toBe(false);
    const archived = readdirSync(harness.evidenceRoot).find((name) =>
      name.startsWith('quattro-live.json.invalidated-'),
    );
    expect(archived).toBeDefined();
    expect(readFileSync(join(harness.evidenceRoot, archived as string), 'utf8')).toBe(oldEvidence);
  });

  it('cleans up when install mutates state and then throws before returning', async () => {
    const harness = createHarness({
      executeHook(input) {
        if (input.label === 'install') throw new Error('partial install failure');
      },
    });
    await expect(runHarness(harness)).rejects.toThrow('partial install failure');
    const execute = (harness.dependencies as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(
      execute.mock.calls.filter((call) => (call[0] as ExecuteInput).label === 'uninstall'),
    ).toHaveLength(1);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'baseline-after-systemd', timeoutMs: 30_000 }),
    );
  });

  it('coordinates signal cleanup idempotently at an injected command boundary', async () => {
    let signalled = false;
    const harness = createHarness({
      async executeHook(input, current) {
        if (input.label === 'seed-project' && !signalled) {
          signalled = true;
          await current.signalHandler?.('SIGTERM');
          await current.signalHandler?.('SIGTERM');
        }
      },
    });
    await expect(runHarness(harness)).rejects.toThrow('interrupted by SIGTERM');
    const execute = (harness.dependencies as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(
      execute.mock.calls.filter((call) => (call[0] as ExecuteInput).label === 'uninstall'),
    ).toHaveLength(1);
  });

  it('rejects approval whose binding does not match the staged artifacts', async () => {
    const harness = createHarness({ reviewHook: () => ({ artifactSetHash: '0'.repeat(64) }) });
    await expect(runHarness(harness)).rejects.toThrow(
      'Visual approval does not match the staged screenshot artifacts',
    );
    expect(existsSync(harness.evidencePath)).toBe(false);
  });

  it('rejects a screenshot mutated after its transcript command', async () => {
    const harness = createHarness({
      executeHook(input, current) {
        if (input.label !== 'uninstall') return;
        const captured = readdirSync(current.root).find((name) =>
          name.startsWith('capture-screenshot-activePopout-'),
        );
        if (captured) writeFileSync(join(current.root, captured), png(99));
      },
    });
    await expect(runHarness(harness)).rejects.toThrow(
      'activePopout screenshot changed after its transcript capture',
    );
    expect(existsSync(harness.evidencePath)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'kills and reaps a timed-out real child process group including descendants',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pimpampum-process-group-'));
      roots.push(root);
      const descendantPidPath = join(root, 'descendant.pid');
      const dependencies = await realDependenciesForTest(root);
      const childSource = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
        writeFileSync(process.argv[1], String(descendant.pid));
        setInterval(() => {}, 1000);
      `;
      const result = await dependencies.execute({
        executable: process.execPath,
        arguments: ['-e', childSource, descendantPidPath],
        timeoutMs: 1_000,
      });
      expect(result.exitCode).toBe(124);
      const descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a successful leader that leaves a detached descendant in its process group',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pimpampum-process-group-success-'));
      roots.push(root);
      const descendantPidPath = join(root, 'descendant.pid');
      const dependencies = await realDependenciesForTest(root);
      const childSource = `
        const { spawn } = require('node:child_process');
        const { writeFileSync } = require('node:fs');
        const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
        descendant.unref();
        writeFileSync(process.argv[1], String(descendant.pid));
      `;
      const result = await dependencies.execute({
        executable: process.execPath,
        arguments: ['-e', childSource, descendantPidPath],
        timeoutMs: 2_000,
      });
      expect(result.exitCode).toBe(125);
      const descendantPid = Number(readFileSync(descendantPidPath, 'utf8'));
      let alive = true;
      for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          alive = false;
        }
      }
      expect(alive).toBe(false);
    },
    10_000,
  );

  it.each([
    ['SIGINT', 'capture'],
    ['SIGTERM', 'capture'],
    ['SIGINT', 'review'],
    ['SIGTERM', 'review'],
  ] as const)('aborts the real %s %s prompt and completes cleanup', async (signal, boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-prompt-signal-'));
    roots.push(root);
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const marker = join(root, 'cleanup.txt');
    mkdirSync(home);
    mkdirSync(bin);
    const xdgOpen = join(bin, 'xdg-open');
    writeFileSync(xdgOpen, '#!/bin/sh\nexit 0\n');
    chmodSync(xdgOpen, 0o755);
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/test-omarchy-live.mjs')).href;
    const childSource = `
      import { writeFileSync } from 'node:fs';
      import { createRealDependencies } from ${JSON.stringify(moduleUrl)};
      const [root, home, boundary, marker, bin] = process.argv.slice(1);
      process.env.PATH = bin + ':' + process.env.PATH;
      const dependencies = createRealDependencies(${JSON.stringify(process.cwd())}, home, {
        dataDirectory: root + '/data', screenshotDirectory: root + '/screenshots', existingPaths: []
      });
      let finishCleanup;
      const cleanupDone = new Promise((resolve) => { finishCleanup = resolve; });
      const unregister = dependencies.registerSignalHandler(async (signal) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        writeFileSync(marker, 'cleaned:' + signal);
        finishCleanup();
      });
      process.stdout.write('READY\\n');
      try {
        if (boundary === 'capture') {
          await dependencies.prepareScreenshot('activePopout', { instruction: 'wait' });
        } else {
          await dependencies.requestVisualReview({
            screenshots: { activePopout: { path: marker, sha256: '0'.repeat(64) } },
            checklist: { activeCount: 'activePopout' }, artifactSetHash: '1'.repeat(64)
          });
        }
        process.exitCode = 2;
      } catch {
        await cleanupDone;
        unregister();
        process.exitCode = 0;
      }
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource, root, home, boundary, marker, bin],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const result = await waitForChild(child, signal);
    expect(result.code, result.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe(`cleaned:${signal}`);
  });

  it('rejects a symlink above the allowed evidence root from its trusted anchor', async () => {
    const harness = createHarness();
    const repository = join(harness.root, 'real-repository');
    mkdirSync(repository);
    const linkedRepository = join(harness.root, 'linked-repository');
    symlinkSync(repository, linkedRepository, 'dir');
    const linkedEvidenceRoot = join(linkedRepository, 'evidence');
    harness.evidencePath = join(linkedEvidenceRoot, 'quattro-live.json');
    const dependencies = harness.dependencies as Record<string, unknown>;
    dependencies.allowedEvidenceRoot = linkedEvidenceRoot;
    dependencies.trustedEvidenceAnchor = harness.root;
    await expect(runHarness(harness)).rejects.toThrow('Evidence ancestor must be a real directory');
    const execute = (dependencies as { execute: ReturnType<typeof vi.fn> }).execute;
    expect(execute).not.toHaveBeenCalled();
    const checked = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts/check-quattro-evidence.mjs'),
        harness.evidencePath,
        harness.candidate,
        harness.root,
        linkedEvidenceRoot,
      ],
      { encoding: 'utf8' },
    );
    expect(checked.status).not.toBe(0);
    expect(checked.stderr).toContain('production evidence ancestor is unsafe');
  });
});
