import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseSignatureVerifier } from '../src/cliMain.js';
import {
  releaseSignaturePayload,
  RELEASE_PUBLIC_KEY_PEM,
  type PackagedReleaseTarget,
} from '../src/update.js';
import { PIMPAMPUM_VERSION } from '../src/version.js';
import { parsePlist } from './helpers/serviceArtifacts.js';
import {
  readWorkflow,
  stepIndex,
  stepsNamed,
  usedActions,
  type WorkflowStep,
  type YamlMapping,
} from './helpers/workflowYaml.js';

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const release = readWorkflow(join(root, '.github/workflows/release.yml'));
const quality = readWorkflow(join(root, '.github/workflows/quality.yml'));
const audit = readWorkflow(join(root, '.github/workflows/audit.yml'));

function ordered(steps: WorkflowStep[], names: string[]): number[] {
  const indexes = names.map((name) => stepIndex(steps, name));
  expect(
    indexes.every((index) => index >= 0),
    `missing step among ${names.join(', ')}`,
  ).toBe(true);
  expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  return indexes;
}

describe('runtime release integration', () => {
  it('signs nested runtime code before the outer app, notarizes, then approves that exact artifact', () => {
    const steps = release.jobs.publish!.steps;
    ordered(steps, [
      'Build app and sign nested runtime first',
      'Verify nested runtime and sign final app',
      'Notarize and staple',
      'Approve and exercise the exact notarized artifact',
      'Build release assets',
    ]);
    const [verify, approve] = stepsNamed(steps, [
      'Verify nested runtime and sign final app',
      'Approve and exercise the exact notarized artifact',
    ]);
    // Inside the one signing step: the embedded node, then the SQLite addon, then the outer app.
    const script = verify!.run ?? '';
    const nodeSign = script.indexOf('bin/node');
    const addonSign = script.indexOf('better_sqlite3.node');
    const outerSign = script.indexOf('--sign');
    expect(nodeSign).toBeGreaterThanOrEqual(0);
    expect(addonSign).toBeGreaterThan(nodeSign);
    expect(outerSign).toBeGreaterThan(addonSign);
    expect(approve!.run).toContain('--approve --require-signature --require-notarization');
  });

  it('grants the embedded Node the JIT entitlement and nothing that weakens the hardened runtime', () => {
    const entitlements = parsePlist(source('platforms/macos/Resources/Node.entitlements'));
    expect(entitlements).toEqual({ 'com.apple.security.cs.allow-jit': true });
  });

  it('builds every runtime target on both workflows with the pinned Node and reviewed pins', () => {
    for (const workflow of [quality, release]) {
      const runtime = workflow.jobs.runtime!;
      const matrix = runtime.strategy?.matrix as YamlMapping;
      const include = matrix.include as YamlMapping[];
      expect(include.map((entry) => entry.target).sort()).toEqual([
        'darwin-arm64',
        'linux-arm64',
        'linux-x64',
      ]);
      const setupNode = runtime.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
      expect(setupNode?.with?.['node-version']).toBe('24.19.0');
      expect(workflow.jobs['runtime-manifest']?.needs).toBe('runtime');
      const [match] = stepsNamed(workflow.jobs['runtime-manifest']!.steps, [
        'Match reviewed Omarchy pins to exact release archives',
      ]);
      expect(match!.run).toContain('check-reviewed-runtime-manifest.mjs');
    }
  });

  it('pins Omarchy to versioned bounded Linux assets', () => {
    const manifest = JSON.parse(
      source('integrations/omarchy/pimpampum-status/runtime-manifest.json'),
    ) as {
      version: string;
      targets: Record<string, { url: string; sha256: string; maximumBytes: number }>;
    };

    expect(Object.keys(manifest.targets).sort()).toEqual(['linux-arm64', 'linux-x64']);
    for (const [target, descriptor] of Object.entries(manifest.targets)) {
      expect(descriptor.url).toContain(`/v${manifest.version}/`);
      expect(descriptor.url).toContain(`-${manifest.version}-${target}.tar.gz`);
      expect(descriptor.url).not.toMatch(/latest/iu);
      expect(descriptor.sha256).toMatch(/^(?!0{64})[a-f0-9]{64}$/u);
      expect(descriptor.maximumBytes).toBe(100_663_296);
    }
  });
});

describe('release channel pipeline scripts', () => {
  const temporaryRoots: string[] = [];
  afterEach(() => {
    for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  function temporary(): string {
    const path = mkdtempSync(join(tmpdir(), 'pimpampum-release-scripts-'));
    temporaryRoots.push(path);
    return path;
  }
  function unsignedManifest(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      channel: 'stable',
      version: '1.2.12',
      targets: {
        'darwin-arm64': {
          url: 'https://github.com/r-bart/pimpampum/releases/download/v1.2.12/Pimpampum-1.2.12-macos-arm64.zip',
          sha256: 'a'.repeat(64),
          size: 4096,
        },
        'linux-x64': {
          url: 'https://github.com/r-bart/pimpampum/releases/download/v1.2.12/pimpampum-runtime-1.2.12-linux-x64.tar.gz',
          sha256: 'b'.repeat(64),
          size: 8192,
        },
      },
    };
  }

  it('embeds the same Ed25519 public key the signing script extracts', () => {
    const extracted = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "import { embeddedReleasePublicKeyPem } from './scripts/sign-release-manifest.mjs'; process.stdout.write(embeddedReleasePublicKeyPem());",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(extracted.stdout).toBe(RELEASE_PUBLIC_KEY_PEM);
    expect(createPublicKey(RELEASE_PUBLIC_KEY_PEM).asymmetricKeyType).toBe('ed25519');
  });

  it('signs every target so the CLI verifier accepts it, and --check rejects a tampered copy', () => {
    const work = temporary();
    const pair = generateKeyPairSync('ed25519');
    const privateKeyPath = join(work, 'private.pem');
    const publicKeyPath = join(work, 'public.pem');
    writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const unsignedPath = join(work, 'unsigned.json');
    writeFileSync(unsignedPath, JSON.stringify(unsignedManifest()));
    const signer = join(root, 'scripts/sign-release-manifest.mjs');
    const signed = spawnSync(
      process.execPath,
      [
        signer,
        '--input',
        unsignedPath,
        '--output',
        join(work, 'channel'),
        '--key',
        privateKeyPath,
        '--public-key',
        publicKeyPath,
        '--issued-at',
        '2026-09-01T12:00:00.000Z',
      ],
      { encoding: 'utf8' },
    );
    expect(signed.status, signed.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(work, 'channel/release-manifest.json'), 'utf8'),
    ) as {
      version: string;
      issuedAt: string;
      targets: Record<string, { url: string; sha256: string; signature: string; size: number }>;
    };
    expect(readFileSync(join(work, 'channel/pimpampum-release-public-key.pem'), 'utf8')).toBe(
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
    );
    expect(manifest.issuedAt).toBe('2026-09-01T12:00:00.000Z');
    const verifier = createReleaseSignatureVerifier({
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    });
    for (const [target, entry] of Object.entries(manifest.targets)) {
      expect(
        verifier({
          payload: releaseSignaturePayload({
            version: manifest.version,
            issuedAt: manifest.issuedAt,
            target: target as PackagedReleaseTarget,
            url: entry.url,
            sha256: entry.sha256,
            size: entry.size,
          }),
          signature: entry.signature,
          target: target as PackagedReleaseTarget,
        }),
      ).toBe(true);
    }

    const check = spawnSync(
      process.execPath,
      [
        signer,
        '--check',
        join(work, 'channel/release-manifest.json'),
        '--public-key',
        publicKeyPath,
      ],
      { encoding: 'utf8' },
    );
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain('verifies 2 target signature(s)');

    manifest.targets['linux-x64']!.size = 8193;
    const tamperedPath = join(work, 'tampered.json');
    writeFileSync(tamperedPath, JSON.stringify(manifest));
    const tampered = spawnSync(
      process.execPath,
      [signer, '--check', tamperedPath, '--public-key', publicKeyPath],
      { encoding: 'utf8' },
    );
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('linux-x64 signature does not verify');

    // The embedded key is the trust root; a stranger's private key must not produce a manifest.
    const stranger = spawnSync(
      process.execPath,
      [
        signer,
        '--input',
        unsignedPath,
        '--output',
        join(work, 'stranger'),
        '--key',
        privateKeyPath,
      ],
      { encoding: 'utf8' },
    );
    expect(stranger.status).not.toBe(0);
    expect(stranger.stderr).toContain('does not match the trusted public key');
  });

  it('checks the tag against every version source and a literal-free site page', () => {
    const work = temporary();
    const write = (path: string, value: unknown) => {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { version: '1.2.12' });
    write('server.json', { version: '1.2.12', packages: [{ version: '1.2.12' }] });
    write('integrations/omarchy/pimpampum-status/manifest.json', { version: '1.2.12' });
    write('integrations/omarchy/pimpampum-status/runtime-manifest.json', { version: '1.2.12' });
    write('site/src/pages/index.astro', '<p>version {version}</p>\n');
    const checker = join(root, 'scripts/check-release-versions.mjs');
    const run = (tag: string) =>
      spawnSync(process.execPath, [checker, tag, work], { encoding: 'utf8' });
    expect(run('v1.2.12').status).toBe(0);
    expect(run('v1.2.13').stderr).toContain('package.json#version is 1.2.12');
    expect(run('1.2.12').stderr).toContain('must be v<major>.<minor>.<patch>');

    write('server.json', { version: '1.2.12', packages: [{ version: '1.2.11' }] });
    expect(run('v1.2.12').stderr).toContain('server.json#packages[0].version is 1.2.11');
    write('server.json', { version: '1.2.12', packages: [{ version: '1.2.12' }] });
    write('site/src/pages/index.astro', '<p>version 1.2.12</p>\n');
    expect(run('v1.2.12').stderr).toContain('spells a version literally (1.2.12)');
  });

  it('keeps the repository versions aligned with the current package version', () => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/check-release-versions.mjs'), `v${PIMPAMPUM_VERSION}`],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails the package gate on the budget or on any app or runtime path', () => {
    const evaluate = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "import { evaluatePackList } from './scripts/check-package-size.mjs';",
          'const cases = [',
          "  { unpackedSize: 7_000_000, files: [{ path: 'dist/cli.js' }] },",
          "  { unpackedSize: 11_000_000, files: [{ path: 'dist/cli.js' }] },",
          "  { unpackedSize: 7_000_000, files: [{ path: 'platforms/macos/dist/Pimpampum.app/Contents/Info.plist' }] },",
          "  { unpackedSize: 7_000_000, files: [{ path: 'x/PimpampumRuntime/payload/bin/node' }] },",
          '  {},',
          '];',
          'process.stdout.write(JSON.stringify(cases.map((entry) => evaluatePackList(entry))));',
        ].join('\n'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(evaluate.status, evaluate.stderr).toBe(0);
    const [ok, oversized, app, runtime, empty] = JSON.parse(evaluate.stdout) as string[][];
    expect(ok).toEqual([]);
    expect(oversized![0]).toMatch(/exceeds the 10485760 byte budget/u);
    expect(app![0]).toMatch(/forbidden path .*Pimpampum\.app/u);
    expect(runtime![0]).toMatch(/forbidden path .*PimpampumRuntime/u);
    expect(empty).toHaveLength(1);
    expect(JSON.parse(source('package.json')).files).not.toContain('platforms/macos/dist');
  });

  it('publishes draft-first, then npm, then undrafts, then the channel and the mirror', () => {
    const steps = release.jobs.publish!.steps;
    const names = [
      'Sign the update-channel manifest',
      'Create the draft GitHub Release with every asset',
      'Publish npm package with provenance',
      'Publish the GitHub Release',
      'Publish the update channel',
    ];
    ordered(steps, names);
    const [sign, draft, npmPublish, undraft, channel] = stepsNamed(steps, names);
    expect(sign!.env?.RELEASE_MANIFEST_SIGNING_KEY).toBe(
      '${{ secrets.RELEASE_MANIFEST_SIGNING_KEY }}',
    );
    expect(sign!.run).toContain('sign-release-manifest.mjs --check');
    expect(draft!.run).toContain('--draft --generate-notes --verify-tag');
    expect(npmPublish!.env?.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
    expect(npmPublish!.run).toContain('npm publish');
    expect(undraft!.run).toContain('gh release edit "$GITHUB_REF_NAME" --draft=false');
    expect(channel!.run).toContain('gh release upload update-channel-stable');

    expect(release.jobs.publish!.needs).toEqual(['validate', 'runtime', 'runtime-manifest']);
    expect(release.jobs.mirror!.needs).toBe('publish');
    const [push, verifyMirror] = stepsNamed(release.jobs.mirror!.steps, [
      'Push the Omarchy plugin to its mirror',
      'Verify the mirror carries this release',
    ]);
    expect(push!.env?.OMARCHY_MIRROR_DEPLOY_KEY).toBe('${{ secrets.OMARCHY_MIRROR_DEPLOY_KEY }}');
    expect(push!.run).toContain('git subtree split --prefix integrations/omarchy/pimpampum-status');
    expect(verifyMirror!.run).toContain('check-omarchy-mirror.mjs');

    // The workflow holds no token scope; each job requests what it needs.
    expect(release.permissions).toEqual({});
    for (const job of Object.values(release.jobs)) expect(job.permissions).toBeDefined();
    expect(quality.on.push).toEqual({ branches: ['master', 'develop'] });
    expect(audit.on.schedule).toEqual([{ cron: '0 6 * * 1' }]);
    for (const workflow of [release, quality, audit]) {
      expect(workflow.concurrency).not.toBeNull();
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) expect(step.run ?? '').not.toContain('test:evals');
      }
      for (const { step } of usedActions(workflow)) {
        expect(step.uses).toMatch(/^actions\/[a-z-]+@[a-f0-9]{40}$/u);
        if (step.uses!.startsWith('actions/checkout@')) {
          expect(step.with?.['persist-credentials']).toBe(false);
        }
      }
    }
    const tagAudit = release.jobs.validate!.steps.find((step) => step.run?.startsWith('npm audit'));
    expect(tagAudit?.run).toBe('npm audit --omit=dev --audit-level=high');
  });
});
