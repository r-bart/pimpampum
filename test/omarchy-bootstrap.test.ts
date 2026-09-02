import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const bootstrap = join(process.cwd(), 'integrations/omarchy/pimpampum-status/pimpampum-bootstrap');
const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-bootstrap-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

type Fixture = {
  root: string;
  home: string;
  archive: string;
  manifest: string;
  uname: string;
  log: string;
};

// The runtime archive is identical for every fixture, so it is built once per file and copied;
// spawning tar for each test was the slowest part of this suite.
let cachedRoot: string;
let cachedArchive: string;
let cachedArchiveSha256: string;

beforeAll(() => {
  cachedRoot = mkdtempSync(join(tmpdir(), 'pimpampum-bootstrap-cache-'));
  const source = join(cachedRoot, 'archive');
  cachedArchive = join(cachedRoot, 'runtime.tar.gz');
  write(
    join(source, 'payload/bin/node'),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$PIMPAMPUM_TEST_LOG"
[ "\${2:-}" = --version ] && exit 0
[ "\${PIMPAMPUM_TEST_INSTALL_EXIT:-0}" -eq 0 ] || exit "$PIMPAMPUM_TEST_INSTALL_EXIT"
mkdir -p "$HOME/.pimpampum"
runtime_node=$1
runtime_node=\${runtime_node%/dist/cli.js}/bin/node
printf '{"version": "1.1.3", "nodePath": "%s"}\n' "$runtime_node" > "$HOME/.pimpampum/install-receipt.json"
`,
    0o755,
  );
  write(join(source, 'payload/dist/cli.js'), 'fixture cli\n');
  write(join(source, 'payload/dist/mcpStdio.js'), 'fixture mcp\n');
  write(
    join(source, 'payload/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
    'fixture addon\n',
  );
  write(
    join(source, 'runtime-manifest.json'),
    '{"pimpampumVersion": "1.1.3", "target": {"platform": "linux", "architecture": "x64"}}\n',
  );
  write(join(source, 'runtime-inventory.json'), '{}\n');
  write(join(source, 'runtime-sbom.spdx.json'), '{}\n');
  const entries = [
    'runtime-manifest.json',
    'runtime-inventory.json',
    'runtime-sbom.spdx.json',
    'payload/bin/node',
    'payload/dist/cli.js',
    'payload/dist/mcpStdio.js',
    'payload/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  ];
  const tar = spawnSync('/usr/bin/tar', ['-czf', cachedArchive, ...entries], {
    cwd: source,
    encoding: 'utf8',
  });
  if (tar.status !== 0) throw new Error(tar.stderr);
  cachedArchiveSha256 = sha256(cachedArchive);
});

afterAll(() => {
  rmSync(cachedRoot, { recursive: true, force: true });
});

function fixture(label: string, homeName = 'home'): Fixture {
  const root = temporaryDirectory(label);
  const home = join(root, homeName);
  const archive = join(root, 'runtime.tar.gz');
  const manifest = join(root, 'runtime-manifest.json');
  const uname = join(root, 'uname');
  const log = join(root, 'cli.log');
  mkdirSync(home);
  cpSync(cachedArchive, archive);
  write(
    manifest,
    `${JSON.stringify(
      {
        version: '1.1.3',
        targets: {
          'linux-x64': {
            url: 'https://github.com/r-bart/pimpampum/releases/download/v1.1.3/pimpampum-runtime-1.1.3-linux-x64.tar.gz',
            sha256: cachedArchiveSha256,
            maximumBytes: readFileSync(archive).length + 1024,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    uname,
    `#!/bin/sh
case $1 in
  -s) printf '%s\n' Linux ;;
  -m) printf '%s\n' "\${PIMPAMPUM_TEST_ARCH:-x86_64}" ;;
  *) exit 64 ;;
esac
`,
    0o755,
  );
  return { root, home, archive, manifest, uname, log };
}

function run(state: Fixture, overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync('/bin/sh', [bootstrap], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: state.home,
      PIMPAMPUM_BOOTSTRAP_ARCHIVE: state.archive,
      PIMPAMPUM_BOOTSTRAP_MANIFEST: state.manifest,
      PIMPAMPUM_BOOTSTRAP_UNAME: state.uname,
      PIMPAMPUM_TEST_LOG: state.log,
      ...overrides,
    },
  });
}

function expectSuccessfulInstall(state: Fixture, result: ReturnType<typeof run>): void {
  const finalDirectory = join(state.home, '.local/share/pimpampum/runtime/1.1.3/linux-x64');

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    installed: true,
    version: '1.1.3',
    target: 'linux-x64',
  });
  expect(readFileSync(state.log, 'utf8')).toContain(
    `${join(finalDirectory, 'dist/cli.js')} install\n`,
  );
  expect(existsSync(join(finalDirectory, 'bin/node'))).toBe(true);
  expect(readFileSync(join(state.home, '.pimpampum/install-receipt.json'), 'utf8')).toContain(
    join(finalDirectory, 'bin/node'),
  );
  const runtimeReceiptPath = join(state.home, '.pimpampum/runtime-install-receipt.json');
  const runtimeReceipt = JSON.parse(readFileSync(runtimeReceiptPath, 'utf8')) as {
    controlLauncherPath: string;
    controlLauncherSha256: string;
    mcpLauncherPath: string;
    mcpLauncherSha256: string;
  };
  expect(runtimeReceipt.controlLauncherPath).toBe(
    join(state.home, '.local/share/pimpampum/bin/pimpampum-control'),
  );
  expect(runtimeReceipt.mcpLauncherPath).toBe(
    join(state.home, '.local/share/pimpampum/bin/pimpampum-mcp'),
  );
  expect(sha256(runtimeReceipt.controlLauncherPath)).toBe(runtimeReceipt.controlLauncherSha256);
  expect(sha256(runtimeReceipt.mcpLauncherPath)).toBe(runtimeReceipt.mcpLauncherSha256);
  expect(
    readdirSync(join(state.home, '.local/share/pimpampum/runtime/1.1.3')).some((name) =>
      name.startsWith('.bootstrap'),
    ),
  ).toBe(false);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Omarchy no-Node bootstrap', () => {
  it('verifies, stages and transfers the exact runtime to the receipt-owned CLI', () => {
    const state = fixture('success');
    expectSuccessfulInstall(state, run(state));

    expect(run(state).status).toBe(0);
    expect(readFileSync(state.log, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('installs into a HOME with spaces and non-ASCII letters and its launchers still execute', () => {
    // L-34: the launchers embed the runtime path in single quotes and the receipt embeds it in
    // JSON; neither quoting had a test with a path that needs it.
    const state = fixture('home-unicode', 'Home With Spaces ü ñ');
    expectSuccessfulInstall(state, run(state));
    const controlLauncher = join(state.home, '.local/share/pimpampum/bin/pimpampum-control');
    const launched = spawnSync('/bin/sh', [controlLauncher, 'status', '--json'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: state.home, PIMPAMPUM_TEST_LOG: state.log },
    });
    expect(launched.status, launched.stderr).toBe(0);
    expect(readFileSync(state.log, 'utf8')).toContain(
      `${join(state.home, '.local/share/pimpampum/runtime/1.1.3/linux-x64/dist/cli.js')} status --json\n`,
    );
  });

  it('rejects a HOME the launchers or receipts could not carry before touching the disk', () => {
    for (const [label, homeName] of [
      ['single-quote', "Home 'quoted'"],
      ['double-quote', 'Home "quoted"'],
      ['backslash', 'Home\\slash'],
      ['control', 'Home\tbroken'],
    ] as const) {
      const state = fixture(`home-${label}`, homeName);
      const result = run(state);
      expect(result.status, label).toBe(73);
      expect(result.stderr).toMatch(/HOME contains/u);
      expect(existsSync(join(state.home, '.local'))).toBe(false);
      expect(existsSync(state.log)).toBe(false);
    }
  });

  it('rejects wrong architecture, hash and oversize without activating a runtime', () => {
    for (const failure of ['architecture', 'hash', 'oversize'] as const) {
      const state = fixture(failure);
      const manifest = JSON.parse(readFileSync(state.manifest, 'utf8')) as {
        targets: Record<string, { sha256: string; maximumBytes: number }>;
      };
      const overrides: NodeJS.ProcessEnv = {};
      if (failure === 'architecture') overrides.PIMPAMPUM_TEST_ARCH = 'riscv64';
      if (failure === 'hash') manifest.targets['linux-x64']!.sha256 = 'a'.repeat(64);
      if (failure === 'oversize') manifest.targets['linux-x64']!.maximumBytes = 1;
      writeFileSync(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = run(state, overrides);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/architecture|SHA-256|maximumBytes/iu);
      expect(existsSync(join(state.home, '.local/share/pimpampum/runtime/1.1.3/linux-x64'))).toBe(
        false,
      );
    }
  });

  it('rejects unsafe archive entries and leaves unrelated files unchanged', () => {
    const state = fixture('unsafe');
    const source = join(state.root, 'unsafe-source');
    write(join(source, 'payload/bin/node'), 'node');
    symlinkSync('/etc/passwd', join(source, 'payload-link'));
    const tar = spawnSync('/usr/bin/tar', ['-czf', state.archive, 'payload-link'], {
      cwd: source,
      encoding: 'utf8',
    });
    expect(tar.status).toBe(0);
    const manifest = JSON.parse(readFileSync(state.manifest, 'utf8')) as {
      targets: Record<string, { sha256: string }>;
    };
    manifest.targets['linux-x64']!.sha256 = sha256(state.archive);
    writeFileSync(state.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    write(join(state.home, 'unrelated.txt'), 'unchanged');

    const result = run(state);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsafe|link|special/iu);
    expect(readFileSync(join(state.home, 'unrelated.txt'), 'utf8')).toBe('unchanged');
  });

  it('reports offline and read-only roots actionably without partial activation', () => {
    const offline = fixture('offline');
    const fakeCurl = join(offline.root, 'curl');
    write(
      fakeCurl,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$PIMPAMPUM_TEST_CURL_LOG"\nexit 7\n',
      0o755,
    );
    const curlLog = join(offline.root, 'curl.log');
    const offlineResult = run(offline, {
      PIMPAMPUM_BOOTSTRAP_ARCHIVE: '',
      PIMPAMPUM_BOOTSTRAP_CURL: fakeCurl,
      PIMPAMPUM_TEST_CURL_LOG: curlLog,
    });
    expect(offlineResult.status).toBe(69);
    expect(offlineResult.stderr).toMatch(/download failed|network/iu);
    // L-28: a redirect must not downgrade the pinned HTTPS download.
    expect(readFileSync(curlLog, 'utf8')).toContain(
      '--proto =https --proto-redir =https --tlsv1.2',
    );

    const readOnly = fixture('read-only');
    const homeFile = join(readOnly.root, 'not-a-directory');
    writeFileSync(homeFile, 'file');
    const readOnlyResult = run(readOnly, { HOME: homeFile });
    expect(readOnlyResult.status).toBe(73);
    expect(readOnlyResult.stderr).toMatch(/permissions|cannot create|regular directory/iu);
    expect(existsSync(join(readOnly.root, 'not-a-directory/.local'))).toBe(false);
  });

  it('resumes an interrupted owned activation without replacing unrelated state', () => {
    const state = fixture('interrupted');
    const recovered = join(state.root, 'recovered');
    mkdirSync(recovered);
    const extraction = spawnSync('/usr/bin/tar', ['-xzf', state.archive, '-C', recovered], {
      encoding: 'utf8',
    });
    expect(extraction.status, extraction.stderr).toBe(0);
    const versionsRoot = join(state.home, '.local/share/pimpampum/runtime/1.1.3');
    const finalDirectory = join(versionsRoot, 'linux-x64');
    mkdirSync(versionsRoot, { recursive: true });
    cpSync(join(recovered, 'payload'), finalDirectory, { recursive: true });
    write(join(versionsRoot, '.bootstrap-linux-x64.owner'), `${sha256(state.archive)}\n`, 0o600);
    write(join(state.home, 'unrelated.txt'), 'unchanged');

    const result = run(state);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(finalDirectory, 'bin/node'))).toBe(true);
    expect(existsSync(join(versionsRoot, '.bootstrap-linux-x64.owner'))).toBe(false);
    expect(readFileSync(join(state.home, 'unrelated.txt'), 'utf8')).toBe('unchanged');
  });

  it('rolls back a newly activated runtime and helpers when packaged setup fails', () => {
    const state = fixture('setup-failure');
    const result = run(state, { PIMPAMPUM_TEST_INSTALL_EXIT: '42' });
    expect(result.status).toBe(70);
    expect(result.stderr).toContain('setup failed');
    expect(existsSync(join(state.home, '.local/share/pimpampum/runtime/1.1.3/linux-x64'))).toBe(
      false,
    );
    expect(existsSync(join(state.home, '.local/share/pimpampum/bin/pimpampum-control'))).toBe(
      false,
    );
    expect(existsSync(join(state.home, '.pimpampum/runtime-install-receipt.json'))).toBe(false);
  });

  it('rejects a symlinked private runtime parent without touching its target', () => {
    const state = fixture('symlink-parent');
    const victim = join(state.root, 'victim');
    mkdirSync(victim);
    mkdirSync(join(state.home, '.local'), { recursive: true });
    symlinkSync(victim, join(state.home, '.local/share'));
    const result = run(state);
    expect(result.status).toBe(73);
    expect(result.stderr).toContain('symlink');
    expect(readdirSync(victim)).toEqual([]);
  });
});
