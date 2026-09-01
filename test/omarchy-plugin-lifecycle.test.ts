import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const lifecycle = join(
  process.cwd(),
  'integrations/omarchy/pimpampum-status/pimpampum-plugin-lifecycle',
);
const connections = join(
  process.cwd(),
  'integrations/omarchy/pimpampum-status/pimpampum-connections',
);
const version = '1.1.3';
const target = 'linux-x64';
const temporaryDirectories: string[] = [];

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

// Every fixture starts from the same home skeleton (runtime payload, launchers, private data), so
// it is written once per file and copied; only the receipt, which embeds absolute paths, is written
// per fixture.
let cachedRoot: string;
let cachedHome: string;
let cachedTools: string;

beforeAll(() => {
  cachedRoot = mkdtempSync(join(tmpdir(), 'pimpampum-plugin-lifecycle-cache-'));
  cachedHome = join(cachedRoot, 'home');
  cachedTools = join(cachedRoot, 'tools');
  const runtime = join(cachedHome, '.local/share/pimpampum/runtime', version, target);
  write(join(runtime, 'bin/node'), '#!/bin/sh\nexit 0\n', 0o755);
  write(join(runtime, 'dist/cli.js'), 'fixture cli\n');
  write(join(runtime, 'dist/mcpStdio.js'), 'fixture mcp\n');
  write(join(cachedHome, '.local/share/pimpampum/bin/pimpampum-mcp'), '#!/bin/sh\nexit 0\n', 0o755);
  write(
    join(cachedHome, '.local/share/pimpampum/bin/pimpampum-control'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$PIMPAMPUM_TEST_LOG"
case "$*" in
  "disconnect codex --yes") printf '{"data":{"id":"codex","disconnected":%s}}\\n' "\${PIMPAMPUM_TEST_CODEX_DISCONNECTED:-true}"; exit 0 ;;
  "connect codex --yes"|install) exit 0 ;;
  "disconnect claude-code --yes") exit 10 ;;
  uninstall) exit "\${PIMPAMPUM_TEST_UNINSTALL_EXIT:-0}" ;;
  *) printf '{"data":{}}\\n' ;;
esac
`,
    0o755,
  );
  write(join(cachedHome, '.pimpampum/pimpampum.sqlite'), 'database');
  write(join(cachedHome, '.pimpampum/export.md'), '# export');
  write(join(cachedHome, '.pimpampum/backups/pimpampum-latest.sqlite'), 'backup');
  write(join(cachedHome, '.pimpampum/sync/snapshot.json'), '{}');
  write(
    join(cachedTools, 'uname'),
    '#!/bin/sh\n[ "$1" = -s ] && printf "Linux\\n" || printf "x86_64\\n"\n',
    0o755,
  );
  write(join(cachedTools, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n', 0o755);
  write(
    join(cachedTools, 'bootstrap'),
    '#!/bin/sh\nprintf "bootstrap\\n" >> "$PIMPAMPUM_TEST_LOG"\n',
    0o755,
  );
});

afterAll(() => {
  rmSync(cachedRoot, { recursive: true, force: true });
});

type OwnedVersion = { version: string; targetId: string; directory: string };

function fixture(label: string, homeName = 'home') {
  const root = mkdtempSync(join(tmpdir(), `pimpampum-plugin-lifecycle-${label}-`));
  temporaryDirectories.push(root);
  const home = join(root, homeName);
  const data = join(home, '.pimpampum');
  const runtime = join(home, '.local/share/pimpampum/runtime', version, target);
  const launcher = join(home, '.local/share/pimpampum/bin/pimpampum-control');
  const mcpLauncher = join(home, '.local/share/pimpampum/bin/pimpampum-mcp');
  const receipt = join(data, 'runtime-install-receipt.json');
  const manifest = join(root, 'runtime-manifest.json');
  const bootstrap = join(root, 'bootstrap');
  const uname = join(root, 'uname');
  const timeout = join(root, 'timeout');
  const log = join(root, 'commands.log');
  cpSync(cachedHome, home, { recursive: true });
  cpSync(join(cachedTools, 'uname'), uname);
  cpSync(join(cachedTools, 'timeout'), timeout);
  cpSync(join(cachedTools, 'bootstrap'), bootstrap);
  write(
    manifest,
    `${JSON.stringify(
      {
        version,
        targets: {
          [target]: {
            url: `https://example.invalid/${version}/${target}`,
            sha256: 'a'.repeat(64),
            maximumBytes: 1024,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(log, '');
  const launcherSha256 = createHash('sha256').update(readFileSync(launcher)).digest('hex');
  const mcpLauncherSha256 = createHash('sha256').update(readFileSync(mcpLauncher)).digest('hex');
  write(
    receipt,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        currentVersion: version,
        targetId: target,
        nodePath: join(runtime, 'bin/node'),
        cliPath: join(runtime, 'dist/cli.js'),
        mcpPath: join(runtime, 'dist/mcpStdio.js'),
        controlLauncherPath: launcher,
        controlLauncherSha256: launcherSha256,
        mcpLauncherPath: mcpLauncher,
        mcpLauncherSha256,
        ownedVersions: [{ version, targetId: target, directory: runtime }],
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  return { root, home, data, runtime, launcher, receipt, manifest, bootstrap, uname, timeout, log };
}

function run(
  state: ReturnType<typeof fixture>,
  action: 'reconcile' | 'remove',
  overrides: NodeJS.ProcessEnv = {},
) {
  return spawnSync('/bin/sh', [lifecycle, action], {
    encoding: 'utf8',
    env: {
      HOME: state.home,
      PIMPAMPUM_LIFECYCLE_MANIFEST: state.manifest,
      PIMPAMPUM_LIFECYCLE_UNAME: state.uname,
      PIMPAMPUM_LIFECYCLE_BOOTSTRAP: state.bootstrap,
      PIMPAMPUM_LIFECYCLE_CONNECTIONS: connections,
      PIMPAMPUM_CONNECTIONS_TIMEOUT: state.timeout,
      PIMPAMPUM_TEST_LOG: state.log,
      ...overrides,
    },
  });
}

function expectRemoved(state: ReturnType<typeof fixture>, result: ReturnType<typeof run>): void {
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    schemaVersion: 1,
    removed: true,
    dataPreserved: true,
    manualGuidance: true,
  });
  expect(result.stderr).toContain('not proven receipt-owned');
  expect(() => readFileSync(state.receipt)).toThrow();
  expect(() => readFileSync(state.launcher)).toThrow();
  expect(() => readFileSync(join(state.runtime, 'bin/node'))).toThrow();
  expect(readFileSync(join(state.data, 'pimpampum.sqlite'), 'utf8')).toBe('database');
  expect(readFileSync(join(state.data, 'export.md'), 'utf8')).toBe('# export');
  expect(readFileSync(join(state.data, 'backups/pimpampum-latest.sqlite'), 'utf8')).toBe('backup');
  expect(readFileSync(join(state.data, 'sync/snapshot.json'), 'utf8')).toBe('{}');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Omarchy plugin runtime lifecycle', () => {
  it('reconciles exact version/target changes and rejects checksum drift for one version', () => {
    const state = fixture('reconcile');
    const first = run(state, 'reconcile');
    const unchanged = run(state, 'reconcile');
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ changed: true, reconciled: true });
    expect(unchanged.status, unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({ changed: false, reconciled: false });
    expect(readFileSync(state.log, 'utf8').trim().split('\n')).toEqual(['bootstrap']);

    const manifest = JSON.parse(readFileSync(state.manifest, 'utf8')) as {
      targets: Record<string, { sha256: string }>;
    };
    manifest.targets['linux-x64']!.sha256 = 'd'.repeat(64);
    writeFileSync(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    const drift = run(state, 'reconcile');
    expect(drift.status).toBe(70);
    expect(drift.stderr).toContain('checksum changed without a version change');
    expect(readFileSync(state.log, 'utf8').trim().split('\n')).toEqual(['bootstrap']);
  });

  it('removes the receipt-owned runtime and launchers while preserving all private data', () => {
    const state = fixture('remove');
    expectRemoved(state, run(state, 'remove'));
    // L-28: the now-empty version directory goes with its payload.
    expect(existsSync(dirname(state.runtime))).toBe(false);
  });

  it('removes earlier receipt-owned runtime versions and leaves unowned directories alone', () => {
    const runtimeRoot = (home: string) => join(home, '.local/share/pimpampum/runtime');
    const state = fixture('owned-versions');
    // The receipt lists two earlier payloads, one under the private runtime root and one outside
    // it, plus a traversal attempt; only the first may be removed.
    const earlier = join(runtimeRoot(state.home), '1.1.2', target);
    const foreign = join(state.root, 'outside');
    const unowned = join(runtimeRoot(state.home), '9.9.9', target);
    const receipt = JSON.parse(readFileSync(state.receipt, 'utf8')) as {
      ownedVersions: OwnedVersion[];
    };
    receipt.ownedVersions = [
      { version: '1.1.2', targetId: target, directory: earlier },
      { version: '1.1.1', targetId: target, directory: foreign },
      { version: '1.1.0', targetId: target, directory: join(runtimeRoot(state.home), '..', 'bin') },
      { version, targetId: target, directory: state.runtime },
    ];
    writeFileSync(state.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    write(join(earlier, 'bin/node'), 'old node');
    write(join(foreign, 'keep.txt'), 'outside the runtime root');
    write(join(unowned, 'bin/node'), 'not in the receipt');

    expectRemoved(state, run(state, 'remove'));
    expect(existsSync(join(runtimeRoot(state.home), '1.1.2'))).toBe(false);
    expect(existsSync(dirname(state.runtime))).toBe(false);
    expect(readFileSync(join(unowned, 'bin/node'), 'utf8')).toBe('not in the receipt');
    expect(readFileSync(join(foreign, 'keep.txt'), 'utf8')).toBe('outside the runtime root');
    expect(existsSync(join(state.home, '.local/share/pimpampum/bin'))).toBe(true);
  });

  it('reconciles and removes under a HOME with spaces and non-ASCII letters', () => {
    const state = fixture('home-unicode', 'Home With Spaces ü ñ');
    const reconciled = run(state, 'reconcile');
    expect(reconciled.status, reconciled.stderr).toBe(0);
    expect(JSON.parse(reconciled.stdout)).toMatchObject({ changed: true, reconciled: true });
    expectRemoved(state, run(state, 'remove'));

    const quoted = fixture('home-quoted', "Home 'quoted'");
    const rejected = run(quoted, 'reconcile');
    expect(rejected.status).toBe(73);
    expect(rejected.stderr).toContain('HOME contains');
    expect(readFileSync(quoted.log, 'utf8')).toBe('');
  });

  it('restores already disconnected owned routes when mandatory service removal fails', () => {
    const state = fixture('rollback');
    const before = readFileSync(state.receipt, 'utf8');
    const result = run(state, 'remove', { PIMPAMPUM_TEST_UNINSTALL_EXIT: '42' });

    expect(result.status).toBe(70);
    expect(result.stderr).toContain('previously disconnected owned routes were restored');
    expect(readFileSync(state.receipt, 'utf8')).toBe(before);
    expect(readFileSync(join(state.runtime, 'bin/node'), 'utf8')).toContain('#!/bin/sh');
    expect(readFileSync(state.log, 'utf8').trim().split('\n')).toContain('connect codex --yes');
  });

  it('does not adopt or restore a connector when disconnect succeeds without changing it', () => {
    const state = fixture('disconnect-noop');
    const result = run(state, 'remove', {
      PIMPAMPUM_TEST_CODEX_DISCONNECTED: 'false',
      PIMPAMPUM_TEST_UNINSTALL_EXIT: '42',
    });

    expect(result.status).toBe(70);
    expect(readFileSync(state.log, 'utf8').trim().split('\n')).not.toContain('connect codex --yes');
  });

  it('fails closed before mutation when launcher ownership is stale and recovers a dead lock', () => {
    const stale = fixture('stale-lock');
    write(
      join(stale.data, '.setup-lifecycle.lock'),
      '{"schemaVersion":1,"pid":999999,"nonce":"00000000-0000-4000-8000-000000000000"}\n',
      0o600,
    );
    expect(run(stale, 'reconcile').status).toBe(0);

    const tampered = fixture('tampered-launcher');
    writeFileSync(tampered.launcher, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    const result = run(tampered, 'remove');
    expect(result.status).toBe(69);
    expect(result.stderr).toContain('launcher content');
    expect(readFileSync(tampered.receipt, 'utf8')).toContain('currentVersion');
    expect(readFileSync(join(tampered.data, 'pimpampum.sqlite'), 'utf8')).toBe('database');
    expect(readFileSync(tampered.log, 'utf8')).toBe('');
  });
});
