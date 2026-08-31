#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  MAXIMUM_UNPACKED_BYTES,
  RUNTIME_TARGETS,
  assertNativeBinaryTarget,
  checkRuntimeBundle,
  parseBundleManifest,
  sha256,
  validateBundlePath,
} from './check-runtime-bundle.mjs';

export const PINNED_NODE_VERSION = '24.19.0';
export const NODE_DISTRIBUTIONS = Object.freeze({
  'darwin-arm64': Object.freeze({
    archive: 'node-v24.19.0-darwin-arm64.tar.xz',
    sha256: '3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94',
  }),
  'linux-arm64': Object.freeze({
    archive: 'node-v24.19.0-linux-arm64.tar.xz',
    sha256: '01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc',
  }),
  'linux-x64': Object.freeze({
    archive: 'node-v24.19.0-linux-x64.tar.xz',
    sha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
  }),
});
export const PINNED_BETTER_SQLITE3_VERSION = '13.0.3';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAXIMUM_NODE_ARCHIVE_BYTES = 80 * 1024 * 1024;
const REQUIRED_ENTRYPOINTS = Object.freeze({
  node: 'bin/node',
  cli: 'dist/cli.js',
  mcp: 'dist/mcpStdio.js',
});
const INSTALLED_ADDON_PATH = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node';

function fail(message) {
  throw new Error(`Runtime bundle build failed: ${message}`);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertTarget(value) {
  if (!Object.hasOwn(RUNTIME_TARGETS, value)) fail(`unsupported target ${value}`);
  return value;
}

function assertReleaseInputs(packagePath, lockfilePath) {
  const packageManifest = readJson(packagePath, 'package.json');
  const lockfile = readJson(lockfilePath, 'package-lock.json');
  if (
    lockfile.lockfileVersion !== 3 ||
    lockfile.packages?.['']?.version !== packageManifest.version
  ) {
    fail('package.json and package-lock.json root versions must agree at lockfileVersion 3');
  }
  if (
    lockfile.packages?.['node_modules/better-sqlite3']?.version !== PINNED_BETTER_SQLITE3_VERSION
  ) {
    fail(`package-lock.json must pin better-sqlite3 ${PINNED_BETTER_SQLITE3_VERSION}`);
  }
  if (typeof packageManifest.version !== 'string') fail('package.json version is missing');
  return { packageManifest, lockfile };
}

function shouldSkipApplicationPath(relativePath) {
  const parts = relativePath.split('/');
  // npm pack removes dot-prefixed files from nested package contents. Excluding
  // them here keeps the signed app, npm package, manifest, and private runtime
  // byte-for-byte compatible across every supported delivery surface.
  if (parts.some((part) => part.startsWith('.'))) return true;
  const betterRoot = 'node_modules/better-sqlite3/';
  if (!relativePath.startsWith(betterRoot)) return false;
  const betterRelative = relativePath.slice(betterRoot.length);
  if (
    betterRelative === 'binding.gyp' ||
    betterRelative === 'build' ||
    betterRelative.startsWith('build/') ||
    betterRelative === 'deps' ||
    betterRelative.startsWith('deps/') ||
    betterRelative === 'src' ||
    betterRelative.startsWith('src/')
  ) {
    return true;
  }
  if (betterRelative.startsWith('prebuilds/')) {
    return true;
  }
  return false;
}

function copyRegularTree(sourceRoot, destinationRoot) {
  const visit = (sourceDirectory) => {
    for (const name of readdirSync(sourceDirectory).sort()) {
      const source = join(sourceDirectory, name);
      const relativePath = relative(sourceRoot, source).split(sep).join('/');
      if (shouldSkipApplicationPath(relativePath)) continue;
      validateBundlePath(relativePath, 'application path');
      const metadata = lstatSync(source);
      if (metadata.isSymbolicLink()) fail(`application contains symlink ${relativePath}`);
      if (metadata.isDirectory()) {
        visit(source);
      } else if (metadata.isFile()) {
        const destination = join(destinationRoot, ...relativePath.split('/'));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
        copyFileSync(source, destination);
        chmodSync(destination, 0o644);
      } else {
        fail(`application contains device or special file ${relativePath}`);
      }
    }
  };
  visit(sourceRoot);
}

function payloadFiles(payloadRoot) {
  const paths = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const relativePath = relative(payloadRoot, path).split(sep).join('/');
      validateBundlePath(relativePath, 'payload path');
      if (metadata.isSymbolicLink()) fail(`payload contains symlink ${relativePath}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) paths.push(path);
      else fail(`payload contains device or special file ${relativePath}`);
    }
  };
  visit(payloadRoot);
  return paths;
}

function packageSpdx(lockfile, lockfileBytes, version, targetId) {
  const packages = Object.entries(lockfile.packages)
    .filter(
      ([path, value]) => path !== '' && value.dev !== true && typeof value.version === 'string',
    )
    .map(([path, value]) => {
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      return {
        SPDXID: `SPDXRef-Package-${sha256(path).slice(0, 16)}`,
        name,
        versionInfo: value.version,
        downloadLocation: value.resolved ?? 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: typeof value.license === 'string' ? value.license : 'NOASSERTION',
      };
    })
    .sort(
      (left, right) =>
        compareCanonicalText(left.name, right.name) ||
        compareCanonicalText(left.versionInfo, right.versionInfo),
    );
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `pimpampum-runtime-${version}-${targetId}`,
    documentNamespace: `https://pimpampum.dev/spdx/runtime/${version}/${targetId}/${sha256(lockfileBytes)}`,
    documentComment: `package-lock.json sha256:${sha256(lockfileBytes)}`,
    creationInfo: {
      created: '1970-01-01T00:00:00Z',
      creators: ['Tool: scripts/build-runtime-bundle.mjs'],
    },
    packages,
  };
}

function tarOctal(buffer, value, offset, length) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) fail('tar numeric field overflow');
  buffer.write(encoded, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function tarPath(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: '' };
  for (let index = path.length - 1; index > 0; index = path.lastIndexOf('/', index - 1)) {
    if (index <= 0) break;
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
  }
  fail(`tar path is too long: ${path}`);
}

function tarHeader(path, mode, size) {
  const header = Buffer.alloc(512);
  const splitPath = tarPath(path);
  header.write(splitPath.name, 0, 100, 'utf8');
  tarOctal(header, mode, 100, 8);
  tarOctal(header, 0, 108, 8);
  tarOctal(header, 0, 116, 8);
  tarOctal(header, size, 124, 12);
  tarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(splitPath.prefix, 345, 155, 'utf8');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function createDeterministicArchive(entries) {
  const chunks = [];
  const paths = new Set();
  for (const entry of [...entries].sort((left, right) =>
    compareCanonicalText(left.path, right.path),
  )) {
    const path = validateBundlePath(entry.path, 'archive input path');
    if (paths.has(path)) fail(`duplicate archive input path ${path}`);
    paths.add(path);
    if (!Buffer.isBuffer(entry.content)) fail(`archive content must be a Buffer for ${path}`);
    if (entry.mode !== 0o644 && entry.mode !== 0o755) fail(`archive mode is invalid for ${path}`);
    chunks.push(tarHeader(path, entry.mode, entry.content.length), entry.content);
    const padding = (512 - (entry.content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

function writeExclusive(path, content, mode = 0o644) {
  writeFileSync(path, content, { flag: 'wx', mode });
}

export function assembleRuntimeBundle(input) {
  const targetId = assertTarget(input.targetId);
  const outputRoot = resolve(input.outputDirectory);
  const packagePath = resolve(input.packagePath);
  const lockfilePath = resolve(input.lockfilePath);
  const applicationDirectory = resolve(input.applicationDirectory);
  const nodeBinaryPath = resolve(input.nodeBinaryPath);
  const nodeLicensePath = resolve(input.nodeLicensePath);
  const { packageManifest, lockfile } = assertReleaseInputs(packagePath, lockfilePath);
  const version = packageManifest.version;
  const bundleName = `pimpampum-runtime-${version}-${targetId}`;
  const finalDirectory = join(outputRoot, bundleName);
  if (existsSync(finalDirectory)) fail(`refusing to overwrite existing bundle ${finalDirectory}`);
  mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
  const stagingParent = mkdtempSync(join(outputRoot, `.${bundleName}.stage-`));
  const stagingDirectory = join(stagingParent, bundleName);
  try {
    const payloadRoot = join(stagingDirectory, 'payload');
    mkdirSync(payloadRoot, { recursive: true, mode: 0o755 });
    const sourceAddonPath = join(
      applicationDirectory,
      'node_modules',
      'better-sqlite3',
      'prebuilds',
      `${targetId}.node`,
    );
    if (!existsSync(sourceAddonPath))
      fail(`missing target-specific better-sqlite3 addon ${targetId}`);
    const sourceAddonMetadata = lstatSync(sourceAddonPath);
    if (sourceAddonMetadata.isSymbolicLink() || !sourceAddonMetadata.isFile()) {
      fail(`target-specific better-sqlite3 addon ${targetId} must be a regular file`);
    }
    copyRegularTree(applicationDirectory, payloadRoot);
    const nodeDestination = join(payloadRoot, 'bin', 'node');
    mkdirSync(dirname(nodeDestination), { recursive: true, mode: 0o755 });
    copyFileSync(nodeBinaryPath, nodeDestination);
    chmodSync(nodeDestination, 0o755);
    copyFileSync(nodeLicensePath, join(payloadRoot, 'LICENSE.node.txt'));
    chmodSync(join(payloadRoot, 'LICENSE.node.txt'), 0o644);
    for (const entrypoint of [REQUIRED_ENTRYPOINTS.cli, REQUIRED_ENTRYPOINTS.mcp]) {
      if (!existsSync(join(payloadRoot, ...entrypoint.split('/'))))
        fail(`missing required entrypoint ${entrypoint}`);
    }
    const addonPath = join(payloadRoot, ...INSTALLED_ADDON_PATH.split('/'));
    mkdirSync(dirname(addonPath), { recursive: true, mode: 0o755 });
    copyFileSync(sourceAddonPath, addonPath);
    chmodSync(addonPath, 0o644);
    assertNativeBinaryTarget(nodeDestination, targetId, 'Node binary');
    assertNativeBinaryTarget(addonPath, targetId, 'better-sqlite3 addon');
    const files = payloadFiles(payloadRoot)
      .map((path) => {
        const content = readFileSync(path);
        return {
          path: relative(payloadRoot, path).split(sep).join('/'),
          sha256: sha256(content),
          mode: statSync(path).mode & 0o777,
          size: content.length,
        };
      })
      .sort((left, right) => compareCanonicalText(left.path, right.path));
    const unpackedBytes = files.reduce((total, file) => total + file.size, 0);
    if (unpackedBytes > MAXIMUM_UNPACKED_BYTES) fail('payload exceeds the 175 MiB unpacked limit');
    const manifest = parseBundleManifest(
      {
        schemaVersion: 1,
        pimpampumVersion: version,
        nodeVersion: input.nodeVersion,
        target: RUNTIME_TARGETS[targetId],
        unpackedBytes,
        entrypoints: REQUIRED_ENTRYPOINTS,
        files,
      },
      targetId,
    );
    const inventory = { schemaVersion: 1, target: targetId, files: manifest.files };
    const lockfileBytes = readFileSync(lockfilePath);
    const sbom = packageSpdx(lockfile, lockfileBytes, version, targetId);
    const metadata = {
      'runtime-inventory.json': Buffer.from(canonicalJson(inventory)),
      'runtime-manifest.json': Buffer.from(canonicalJson(manifest)),
      'runtime-sbom.spdx.json': Buffer.from(canonicalJson(sbom)),
    };
    for (const [name, content] of Object.entries(metadata)) {
      writeExclusive(join(stagingDirectory, name), content);
    }
    const archiveEntries = [
      ...Object.entries(metadata).map(([path, content]) => ({ path, content, mode: 0o644 })),
      ...manifest.files.map((file) => ({
        path: `payload/${file.path}`,
        content: readFileSync(join(payloadRoot, ...file.path.split('/'))),
        mode: file.mode,
      })),
    ];
    const archive = createDeterministicArchive(archiveEntries);
    const archiveName = `${bundleName}.tar.gz`;
    writeExclusive(join(stagingDirectory, archiveName), archive);
    writeExclusive(
      join(stagingDirectory, 'archive-sha256.json'),
      canonicalJson({
        schemaVersion: 1,
        file: archiveName,
        sha256: sha256(archive),
        size: archive.length,
      }),
    );
    checkRuntimeBundle(stagingDirectory, { targetId, lockfilePath });
    mkdirSync(outputRoot, { recursive: true, mode: 0o755 });
    renameSync(stagingDirectory, finalDirectory);
    return checkRuntimeBundle(finalDirectory, { targetId, lockfilePath });
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

async function downloadPinnedNodeArchive(targetId, destination) {
  const distribution = NODE_DISTRIBUTIONS[targetId];
  const url = `https://nodejs.org/dist/v${PINNED_NODE_VERSION}/${distribution.archive}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) fail(`Node download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAXIMUM_NODE_ARCHIVE_BYTES) {
    fail('Node archive Content-Length exceeds limit');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAXIMUM_NODE_ARCHIVE_BYTES)
    fail('Node archive size exceeds limit');
  if (sha256(bytes) !== distribution.sha256) fail('official Node archive SHA-256 mismatch');
  writeExclusive(destination, bytes);
  return destination;
}

function prepareApplication(workDirectory, root) {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const appDirectory = join(workDirectory, 'application');
  mkdirSync(appDirectory, { mode: 0o755 });
  copyFileSync(join(root, 'package.json'), join(appDirectory, 'package.json'));
  copyFileSync(join(root, 'package-lock.json'), join(appDirectory, 'package-lock.json'));
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDirectory,
    stdio: 'inherit',
  });
  copyRegularTree(join(root, 'dist'), join(appDirectory, 'dist'));
  return appDirectory;
}

export async function buildRuntimeBundle(input) {
  const targetId = assertTarget(input.targetId);
  const root = resolve(input.repositoryRoot ?? repositoryRoot);
  const outputDirectory = resolve(input.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
  const workDirectory = mkdtempSync(join(tmpdir(), `pimpampum-runtime-${targetId}-`));
  try {
    const applicationDirectory = prepareApplication(workDirectory, root);
    const nodeArchive = join(workDirectory, NODE_DISTRIBUTIONS[targetId].archive);
    await downloadPinnedNodeArchive(targetId, nodeArchive);
    const extracted = join(workDirectory, 'node');
    mkdirSync(extracted, { mode: 0o755 });
    execFileSync('/usr/bin/tar', ['-xJf', nodeArchive, '-C', extracted], { stdio: 'inherit' });
    const distributionRoot = join(extracted, basename(nodeArchive, '.tar.xz'));
    const nodeBinaryPath = join(distributionRoot, 'bin', 'node');
    const nodeLicensePath = join(distributionRoot, 'LICENSE');
    if (!existsSync(nodeBinaryPath) || !existsSync(nodeLicensePath))
      fail('Node archive layout is invalid');
    return assembleRuntimeBundle({
      targetId,
      outputDirectory,
      applicationDirectory,
      nodeBinaryPath,
      nodeLicensePath,
      nodeVersion: PINNED_NODE_VERSION,
      packagePath: join(root, 'package.json'),
      lockfilePath: join(root, 'package-lock.json'),
    });
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}

function cliArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--target') options.targetId = arguments_[++index];
    else if (argument === '--output') options.outputDirectory = arguments_[++index];
    else if (argument === '--repository') options.repositoryRoot = arguments_[++index];
    else fail(`unknown argument ${argument}`);
  }
  if (!options.targetId || !options.outputDirectory) {
    fail(
      'usage: build-runtime-bundle.mjs --target <target> --output <directory> [--repository <root>]',
    );
  }
  return options;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await buildRuntimeBundle(cliArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
