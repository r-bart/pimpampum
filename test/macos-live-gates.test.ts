import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const checker = join(repositoryRoot, 'scripts/check-macos-evidence.mjs');
const runner = join(repositoryRoot, 'scripts/test-macos-live.mjs');
const roots: string[] = [];

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function treeSha256(root: string): string {
  const files: Array<{ path: string; mode: number }> = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = statSync(path);
      if (metadata.isDirectory()) visit(path);
      else files.push({ path, mode: metadata.mode & 0o777 });
    }
  };
  visit(root);
  const digest = createHash('sha256');
  for (const file of files) {
    const bytes = readFileSync(file.path);
    digest.update(relative(root, file.path).split(sep).join('/'));
    digest.update('\0');
    digest.update(String(file.mode));
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-macos-evidence-'));
  roots.push(root);
  const app = join(root, 'Pimpampum.app');
  const metadataPath = join(root, 'PimpampumMenuBar.artifact.json');
  const evidencePath = join(root, 'macos-live.json');
  const paths = {
    appBinarySha256: join(app, 'Contents/MacOS/PimpampumMenuBar'),
    compactMarkSha256: join(app, 'Contents/Resources/PimpampumCompact.pdf'),
    runtimeManifestSha256: join(app, 'Contents/Resources/PimpampumRuntime/runtime-manifest.json'),
    runtimeInventorySha256: join(app, 'Contents/Resources/PimpampumRuntime/runtime-inventory.json'),
    runtimeSbomSha256: join(app, 'Contents/Resources/PimpampumRuntime/runtime-sbom.spdx.json'),
    runtimeNodeSha256: join(app, 'Contents/Resources/PimpampumRuntime/payload/bin/node'),
    runtimeAddonSha256: join(
      app,
      'Contents/Resources/PimpampumRuntime/payload/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ),
  };
  for (const [name, path] of Object.entries(paths)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${name}\n`);
  }
  chmodSync(paths.appBinarySha256, 0o755);
  chmodSync(paths.runtimeNodeSha256, 0o755);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
  const metadata = {
    schemaVersion: 3,
    sourceGitCommit: commit,
    sourceInputSha256: 'a'.repeat(64),
    appVersion: '1.1.3',
  };
  writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
  const artifactHashes: Record<string, string> = {
    artifactMetadataSha256: sha256(readFileSync(metadataPath)),
    appBundleSha256: treeSha256(app),
    ...Object.fromEntries(
      Object.entries(paths).map(([name, path]) => [name, sha256(readFileSync(path))]),
    ),
  };
  const evidence = {
    schemaVersion: 3,
    status: 'passed',
    testedAt: new Date().toISOString(),
    durationMilliseconds: 90_000,
    platform: 'macOS',
    architecture: 'arm64',
    gitCommit: commit,
    sourceInputSha256: metadata.sourceInputSha256,
    releaseSequence: ['sign-nested-runtime', 'sign-outer-app', 'notarize', 'staple', 'approve'],
    loginItem: 'enabled',
    versions: {
      pimpampum: metadata.appVersion,
      node: 'v24.19.0',
      macOS: '15.6',
      codex: 'codex-cli 1.0.0',
      claudeCode: '1.0.0 (Claude Code)',
    },
    artifactHashes,
    scenarios: Object.fromEntries(
      [
        'cleanNoNode',
        'guidedSetupPopover',
        'legacyNpmMigration',
        'noAgent',
        'oneAgent',
        'twoAgents',
        'partialFailure',
        'conflictDecision',
        'popoverRestartResume',
        'packagedUpdate',
        'disconnect',
        'removal',
      ].map((name) => [name, true]),
    ),
    sessionRestart: {
      required: true,
      observedAfterNewSession: true,
      connectors: ['codex'],
    },
    checks: Object.fromEntries(
      [
        'empty',
        'activeClaim',
        'completion',
        'daemonOffline',
        'nativePopoverRendering',
        'staleRecovery',
        'projectRowActivation',
        'finderRevealExactPath',
        'noDockIcon',
        'repeatInstallRecovery',
        'uninstallCleanup',
        'guidedSetupPopover',
      ].map((name) => [name, true]),
    ),
    renderings: Object.fromEntries(
      ['setupRequired', 'empty', 'active', 'complete', 'stale', 'recovered'].map((name, index) => [
        name,
        String(index + 1).repeat(64),
      ]),
    ),
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
  return { app, evidence, evidencePath, metadataPath };
}

function check(input: ReturnType<typeof fixture>) {
  return spawnSync(
    process.execPath,
    [
      checker,
      '--evidence',
      input.evidencePath,
      '--app',
      input.app,
      '--metadata',
      input.metadataPath,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('expanded macOS live release gates', () => {
  it('accepts evidence bound to one commit and the exact final app tree', () => {
    const input = fixture();
    const result = check(input);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(input.evidence.gitCommit);
  });

  it.each([
    [
      'over budget',
      (input: ReturnType<typeof fixture>) => (input.evidence.durationMilliseconds = 120_000),
    ],
    [
      'missing scenario',
      (input: ReturnType<typeof fixture>) => (input.evidence.scenarios.partialFailure = false),
    ],
    [
      'wrong artifact',
      (input: ReturnType<typeof fixture>) =>
        (input.evidence.artifactHashes.runtimeNodeSha256 = 'f'.repeat(64)),
    ],
    [
      'wrong order',
      (input: ReturnType<typeof fixture>) => input.evidence.releaseSequence.reverse(),
    ],
  ])('rejects %s evidence', (_label, mutate) => {
    const input = fixture();
    mutate(input);
    writeFileSync(input.evidencePath, `${JSON.stringify(input.evidence)}\n`);
    expect(check(input).status).not.toBe(0);
  });

  it('keeps the live runner opt-in and leaves existing approved evidence untouched', () => {
    const approved = join(repositoryRoot, 'thoughts/evidence/macos-live.json');
    const before = readFileSync(approved);
    const result = spawnSync(process.execPath, [runner], {
      cwd: repositoryRoot,
      env: { ...process.env, PIMPAMPUM_RUN_LIVE_MACOS: '' },
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(approved)).toEqual(before);
  });

  it('enforces release ordering and enumerates every live setup lifecycle case', () => {
    const workflow = readFileSync(join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
    const source = readFileSync(runner, 'utf8');
    const nested = workflow.indexOf('Verify nested runtime and sign final app');
    const notarize = workflow.indexOf('Notarize and staple');
    const approve = workflow.indexOf('Approve and exercise the exact notarized artifact');
    expect(nested).toBeGreaterThan(0);
    expect(notarize).toBeGreaterThan(nested);
    expect(approve).toBeGreaterThan(notarize);
    expect(workflow.slice(notarize, approve)).not.toContain(
      'node scripts/check-macos-artifact.mjs',
    );
    expect(workflow.slice(approve)).toContain(
      '--approve --require-signature --require-notarization',
    );
    for (const scenario of [
      'cleanNoNode',
      'legacyNpmMigration',
      'noAgent',
      'oneAgent',
      'twoAgents',
      'partialFailure',
      'conflictDecision',
      'popoverRestartResume',
      'packagedUpdate',
      'disconnect',
      'removal',
    ]) {
      expect(source).toContain(scenario);
    }
    expect(source).toContain('config="$HOME/.claude.json"');
    expect(source).toContain('"mcpServers":{"pimpampum"');
    expect(source).toContain("spawnSync(controlNode, [cli, 'backup', 'retry']");
    expect(source).toContain('connector.newSessionRequired');
    expect(source).toContain('durationMilliseconds >= 120_000');
    expect(source).toContain("environment.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'");
  });

  it('preserves complete runtime artifacts and addresses their versioned download layout', () => {
    const quality = readFileSync(join(repositoryRoot, '.github/workflows/quality.yml'), 'utf8');
    const release = readFileSync(join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');

    for (const workflow of [quality, release]) {
      expect(workflow).toContain('include-hidden-files: true');
      expect(workflow).toContain('pimpampum-runtime-$version-darwin-arm64');
      expect(workflow).toContain('Pack mode-preserving runtime transport');
      expect(workflow).toContain('runtime-${{ matrix.target }}.tar.gz');
    }
    expect(quality).toContain('Unpack mode-preserving runtime transport');
    expect(release).toContain('merge-multiple: true');
    expect(release).toContain('Unpack mode-preserving runtime transports');
  });
});
