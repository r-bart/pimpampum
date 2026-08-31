import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

type BundleResult = {
  valid: true;
  target: string;
  version: string;
  archiveSha256: string;
};

type BuilderModule = {
  assembleRuntimeBundle(input: {
    targetId: string;
    outputDirectory: string;
    applicationDirectory: string;
    nodeBinaryPath: string;
    nodeLicensePath: string;
    nodeVersion: string;
    packagePath: string;
    lockfilePath: string;
  }): BundleResult;
  createDeterministicArchive(
    entries: Array<{ path: string; mode: number; content: Buffer }>,
  ): Buffer;
};

type CheckerModule = {
  checkRuntimeBundle(
    root: string,
    options: { targetId: string; lockfilePath: string },
  ): BundleResult;
};

let builder: BuilderModule;
let checker: CheckerModule;
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  // These release scripts are deliberately self-contained JavaScript entrypoints.
  // @ts-expect-error There is no declaration output for build-time .mjs scripts.
  const builderModule = await import('../scripts/build-runtime-bundle.mjs');
  // @ts-expect-error There is no declaration output for build-time .mjs scripts.
  const checkerModule = await import('../scripts/check-runtime-bundle.mjs');
  [builder, checker] = await Promise.all([
    Promise.resolve(builderModule as BuilderModule),
    Promise.resolve(checkerModule as CheckerModule),
  ]);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-runtime-bundle-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function nativeBinary(target: 'linux-x64' | 'linux-arm64' | 'darwin-arm64'): Buffer {
  const bytes = Buffer.alloc(64);
  if (target === 'darwin-arm64') {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
  } else {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes);
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(target === 'linux-x64' ? 62 : 183, 18);
  }
  return bytes;
}

function write(path: string, content: string | Buffer, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function fixture(label: string, target: 'linux-x64' | 'linux-arm64' = 'linux-x64') {
  const root = temporaryDirectory(label);
  const applicationDirectory = join(root, 'application');
  const outputDirectory = join(root, 'output');
  const packagePath = join(root, 'package.json');
  const lockfilePath = join(root, 'package-lock.json');
  write(packagePath, `${JSON.stringify({ name: 'pimpampum', version: '2.0.0' }, null, 2)}\n`);
  write(
    lockfilePath,
    `${JSON.stringify(
      {
        name: 'pimpampum',
        version: '2.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'pimpampum', version: '2.0.0' },
          'node_modules/better-sqlite3': { version: '13.0.3', license: 'MIT' },
          'node_modules/production': {
            version: '1.2.3',
            resolved: 'https://registry.npmjs.org/production/-/production-1.2.3.tgz',
            license: 'MIT',
          },
          'node_modules/development-only': { version: '9.0.0', dev: true },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(join(applicationDirectory, 'package.json'), '{}\n');
  write(join(applicationDirectory, 'dist/cli.js'), 'export const cli = true;\n');
  write(join(applicationDirectory, 'dist/mcpStdio.js'), 'export const mcp = true;\n');
  write(join(applicationDirectory, 'node_modules/production/index.js'), 'module.exports = true;\n');
  write(join(applicationDirectory, 'node_modules/.package-lock.json'), '{}\n');
  write(join(applicationDirectory, 'node_modules/production/.eslintrc'), '{}\n');
  write(join(applicationDirectory, 'node_modules/production/.github/FUNDING.yml'), 'ignored\n');
  write(
    join(applicationDirectory, `node_modules/better-sqlite3/prebuilds/${target}.node`),
    nativeBinary(target),
  );
  const otherTarget = target === 'linux-x64' ? 'linux-arm64' : 'linux-x64';
  write(
    join(applicationDirectory, `node_modules/better-sqlite3/prebuilds/${otherTarget}.node`),
    nativeBinary(otherTarget),
  );
  write(
    join(applicationDirectory, 'node_modules/better-sqlite3/lib/index.js'),
    'module.exports = {};\n',
  );
  write(
    join(applicationDirectory, 'node_modules/better-sqlite3/src/addon.cpp'),
    'source excluded\n',
  );
  const nodeBinaryPath = join(root, 'node');
  const nodeLicensePath = join(root, 'LICENSE.node.source');
  write(nodeBinaryPath, nativeBinary(target), 0o755);
  write(nodeLicensePath, 'Node fixture license\n');
  mkdirSync(outputDirectory);
  return {
    root,
    target,
    applicationDirectory,
    outputDirectory,
    packagePath,
    lockfilePath,
    nodeBinaryPath,
    nodeLicensePath,
  };
}

function assemble(state: ReturnType<typeof fixture>, outputDirectory = state.outputDirectory) {
  return builder.assembleRuntimeBundle({
    targetId: state.target,
    outputDirectory,
    applicationDirectory: state.applicationDirectory,
    nodeBinaryPath: state.nodeBinaryPath,
    nodeLicensePath: state.nodeLicensePath,
    nodeVersion: '24.19.0',
    packagePath: state.packagePath,
    lockfilePath: state.lockfilePath,
  });
}

function bundleDirectory(
  state: ReturnType<typeof fixture>,
  outputDirectory = state.outputDirectory,
) {
  return join(outputDirectory, `pimpampum-runtime-2.0.0-${state.target}`);
}

function archivePath(state: ReturnType<typeof fixture>, root = bundleDirectory(state)): string {
  return join(root, `pimpampum-runtime-2.0.0-${state.target}.tar.gz`);
}

describe('runtime bundle release scripts', () => {
  it('builds a deterministic lockfile-derived target bundle and SPDX inventory', () => {
    const state = fixture('deterministic');
    const secondOutput = join(state.root, 'second-output');
    mkdirSync(secondOutput);

    const first = assemble(state);
    const second = assemble(state, secondOutput);

    expect(first).toMatchObject({ valid: true, target: 'linux-x64', version: '2.0.0' });
    expect(second.archiveSha256).toBe(first.archiveSha256);
    const root = bundleDirectory(state);
    expect(readFileSync(archivePath(state))).toEqual(
      readFileSync(archivePath(state, bundleDirectory(state, secondOutput))),
    );
    const sbom = JSON.parse(readFileSync(join(root, 'runtime-sbom.spdx.json'), 'utf8')) as {
      packages: Array<{ name: string }>;
    };
    expect(sbom.packages.map((entry) => entry.name)).toContain('production');
    expect(sbom.packages.map((entry) => entry.name)).not.toContain('development-only');
  });

  it('prunes every nonmatching addon and source/build input', () => {
    const state = fixture('pruned');
    assemble(state);
    const root = bundleDirectory(state);
    const manifest = JSON.parse(readFileSync(join(root, 'runtime-manifest.json'), 'utf8')) as {
      files: Array<{ path: string }>;
    };
    const paths = manifest.files.map((file) => file.path);

    expect(paths.filter((path) => path.endsWith('.node'))).toEqual([
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ]);
    expect(
      paths.some(
        (path) =>
          path.includes('/src/') || path.includes('/deps/') || path.endsWith('/binding.gyp'),
      ),
    ).toBe(false);
    expect(paths).not.toContain('node_modules/better-sqlite3/prebuilds/linux-arm64.node');
    expect(paths).not.toContain('node_modules/better-sqlite3/prebuilds/linux-x64.node');
    expect(paths.some((path) => path.split('/').some((part) => part.startsWith('.')))).toBe(false);
  });

  it.each([
    ['extra file', (root: string) => write(join(root, 'payload/extra.txt'), 'extra')],
    [
      'missing addon',
      (root: string) =>
        unlinkSync(
          join(root, 'payload/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
        ),
    ],
    ['hash drift', (root: string) => write(join(root, 'payload/dist/cli.js'), 'X'.repeat(25))],
    ['mode drift', (root: string) => chmodSync(join(root, 'payload/dist/cli.js'), 0o755)],
  ])('rejects %s', (_label, mutate) => {
    const state = fixture(`reject-${_label.replaceAll(' ', '-')}`);
    assemble(state);
    const root = bundleDirectory(state);
    mutate(root);

    expect(() =>
      checker.checkRuntimeBundle(root, {
        targetId: state.target,
        lockfilePath: state.lockfilePath,
      }),
    ).toThrow(/invalid runtime bundle/iu);
  });

  it('rejects a wrong expected target and an unsafe archive input path', () => {
    const state = fixture('wrong-target');
    assemble(state);

    expect(() =>
      checker.checkRuntimeBundle(bundleDirectory(state), {
        targetId: 'linux-arm64',
        lockfilePath: state.lockfilePath,
      }),
    ).toThrow(/wrong target/iu);
    expect(() =>
      builder.createDeterministicArchive([
        { path: '../escape', mode: 0o644, content: Buffer.from('escape') },
      ]),
    ).toThrow(/traversal|unsafe/iu);
  });

  it('rejects traversal inside an otherwise correctly hashed archive', () => {
    const state = fixture('archive-traversal');
    assemble(state);
    const root = bundleDirectory(state);
    const path = archivePath(state);
    const tar = gunzipSync(readFileSync(path));
    const originalName = tar.subarray(0, 100).indexOf(0);
    tar.fill(0, 0, originalName === -1 ? 100 : originalName);
    tar.write('../evil', 0, 'utf8');
    tar.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of tar.subarray(0, 512)) checksum += byte;
    tar.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
    tar[154] = 0;
    tar[155] = 0x20;
    const archive = gzipSync(tar, { level: 9 });
    writeFileSync(path, archive);
    writeFileSync(
      join(root, 'archive-sha256.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          file: `pimpampum-runtime-2.0.0-${state.target}.tar.gz`,
          sha256: createHash('sha256').update(archive).digest('hex'),
          size: archive.length,
        },
        null,
        2,
      )}\n`,
    );

    expect(() =>
      checker.checkRuntimeBundle(root, {
        targetId: state.target,
        lockfilePath: state.lockfilePath,
      }),
    ).toThrow(/traversal|unsafe/iu);
  });

  it('rejects root symlinks and archives without two zero end blocks', () => {
    const symlinkState = fixture('root-symlink');
    assemble(symlinkState);
    const symlinkRoot = bundleDirectory(symlinkState);
    const inventoryPath = join(symlinkRoot, 'runtime-inventory.json');
    const externalInventory = join(symlinkState.root, 'external-inventory.json');
    writeFileSync(externalInventory, readFileSync(inventoryPath));
    unlinkSync(inventoryPath);
    symlinkSync(externalInventory, inventoryPath);
    expect(() =>
      checker.checkRuntimeBundle(symlinkRoot, {
        targetId: symlinkState.target,
        lockfilePath: symlinkState.lockfilePath,
      }),
    ).toThrow(/symlink/iu);

    const archiveState = fixture('missing-end-marker');
    assemble(archiveState);
    const archiveRoot = bundleDirectory(archiveState);
    const path = archivePath(archiveState);
    const tar = gunzipSync(readFileSync(path));
    const archive = gzipSync(tar.subarray(0, tar.length - 512), { level: 9 });
    writeFileSync(path, archive);
    writeFileSync(
      join(archiveRoot, 'archive-sha256.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          file: `pimpampum-runtime-2.0.0-${archiveState.target}.tar.gz`,
          sha256: createHash('sha256').update(archive).digest('hex'),
          size: archive.length,
        },
        null,
        2,
      )}\n`,
    );
    expect(() =>
      checker.checkRuntimeBundle(archiveRoot, {
        targetId: archiveState.target,
        lockfilePath: archiveState.lockfilePath,
      }),
    ).toThrow(/end marker/iu);
  });

  it('detects wrong native architecture before emitting a bundle', () => {
    const state = fixture('wrong-native');
    writeFileSync(state.nodeBinaryPath, nativeBinary('linux-arm64'));

    expect(() => assemble(state)).toThrow(/wrong architecture/iu);

    const wrongClassState = fixture('wrong-elf-class');
    const wrongClass = nativeBinary('linux-x64');
    wrongClass[4] = 1;
    writeFileSync(wrongClassState.nodeBinaryPath, wrongClass);
    expect(() => assemble(wrongClassState)).toThrow(/64-bit/iu);
  });
});
