#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertNativeBinaryTarget, parseBundleManifest } from './check-runtime-bundle.mjs';
import { macosSourceHash, sourcePaths } from './macosSourceHash.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageVersion = JSON.parse(
  readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
).version;
const appRoot = resolve(process.argv[2] ?? 'platforms/macos/dist/PimpampumMenuBar.app');
const canonicalAppRoot = join(repositoryRoot, 'platforms/macos/dist/PimpampumMenuBar.app');
const approve = process.argv.includes('--approve');
const requireSignature = process.argv.includes('--require-signature');
const requireNotarization = process.argv.includes('--require-notarization');
const executable = join(appRoot, 'Contents/MacOS/PimpampumMenuBar');
const infoPlist = join(appRoot, 'Contents/Info.plist');
const metadataPath = join(dirname(appRoot), 'PimpampumMenuBar.artifact.json');
const sourceCompactMark = join(repositoryRoot, 'platforms/macos/Resources/PimpampumCompact.pdf');
const packagedCompactMark = join(appRoot, 'Contents/Resources/PimpampumCompact.pdf');
const packagedIcon = join(appRoot, 'Contents/Resources/Pimpampum.icns');
const packagedAssetCatalog = join(appRoot, 'Contents/Resources/Assets.car');
const runtimeRoot = join(appRoot, 'Contents/Resources/PimpampumRuntime');
const runtimeManifestPath = join(runtimeRoot, 'runtime-manifest.json');
const runtimeInventoryPath = join(runtimeRoot, 'runtime-inventory.json');
const runtimeSbomPath = join(runtimeRoot, 'runtime-sbom.spdx.json');
const runtimePayloadRoot = join(runtimeRoot, 'payload');
const runtimeNode = join(runtimePayloadRoot, 'bin/node');
const runtimeAddon = join(
  runtimePayloadRoot,
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
);

const knownArguments = new Set([
  appRoot,
  '--approve',
  '--require-signature',
  '--require-notarization',
]);
for (const argument of process.argv.slice(2)) {
  invariant(knownArguments.has(resolveArgument(argument)), `Unknown checker argument: ${argument}`);
}

function resolveArgument(argument) {
  return argument.startsWith('--') ? argument : resolve(argument);
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON.`, { cause: error });
  }
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function walkRuntimePayload(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      const displayPath = relative(root, path).split(sep).join('/');
      invariant(!metadata.isSymbolicLink(), `Packaged runtime contains symlink ${displayPath}.`);
      if (metadata.isDirectory()) visit(path);
      else {
        invariant(metadata.isFile(), `Packaged runtime contains special file ${displayPath}.`);
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function validateEmbeddedRuntime() {
  invariant(
    existsSync(runtimeRoot) && lstatSync(runtimeRoot).isDirectory(),
    'The packaged app is missing its private runtime.',
  );
  const rootEntries = readdirSync(runtimeRoot).sort();
  invariant(
    JSON.stringify(rootEntries) ===
      JSON.stringify(
        [
          'payload',
          'runtime-inventory.json',
          'runtime-manifest.json',
          'runtime-sbom.spdx.json',
        ].sort(),
      ),
    'The packaged runtime has missing or unexpected root entries.',
  );
  for (const path of [runtimeManifestPath, runtimeInventoryPath, runtimeSbomPath]) {
    invariant(
      existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
      `Missing packaged runtime metadata: ${path}`,
    );
  }
  invariant(
    existsSync(runtimePayloadRoot) && lstatSync(runtimePayloadRoot).isDirectory(),
    'The packaged runtime payload is missing.',
  );

  const manifest = parseBundleManifest(
    readJson(runtimeManifestPath, 'The packaged runtime manifest'),
    'darwin-arm64',
  );
  invariant(
    manifest.pimpampumVersion === packageVersion,
    `The packaged runtime version must be ${packageVersion}.`,
  );
  invariant(
    manifest.entrypoints.node === 'bin/node' &&
      manifest.entrypoints.cli === 'dist/cli.js' &&
      manifest.entrypoints.mcp === 'dist/mcpStdio.js',
    'The packaged runtime launchers do not resolve the reviewed entrypoints.',
  );

  const actualPaths = walkRuntimePayload(runtimePayloadRoot)
    .map((path) => relative(runtimePayloadRoot, path).split(sep).join('/'))
    .sort();
  const expectedPaths = manifest.files.map((file) => file.path).sort();
  invariant(
    JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
    'The packaged runtime payload has missing or unexpected files.',
  );
  for (const file of manifest.files) {
    const path = join(runtimePayloadRoot, ...file.path.split('/'));
    const metadata = statSync(path);
    const bytes = readFileSync(path);
    invariant((metadata.mode & 0o777) === file.mode, `Runtime mode drift for ${file.path}.`);
    invariant(bytes.length === file.size, `Runtime size drift for ${file.path}.`);
    invariant(sha256(bytes) === file.sha256, `Runtime hash drift for ${file.path}.`);
  }

  assertNativeBinaryTarget(runtimeNode, 'darwin-arm64', 'Packaged runtime bin/node');
  assertNativeBinaryTarget(runtimeAddon, 'darwin-arm64', 'Packaged runtime better_sqlite3.node');

  const inventory = readJson(runtimeInventoryPath, 'The packaged runtime inventory');
  invariant(
    inventory.schemaVersion === 1 &&
      inventory.target === 'darwin-arm64' &&
      canonicalJson(inventory.files) === canonicalJson(manifest.files),
    'The packaged runtime inventory differs from runtime-manifest.json.',
  );
  const sbom = readJson(runtimeSbomPath, 'The packaged runtime SBOM');
  const lockfileHash = sha256(readFileSync(join(repositoryRoot, 'package-lock.json')));
  invariant(
    sbom.spdxVersion === 'SPDX-2.3' &&
      sbom.dataLicense === 'CC0-1.0' &&
      Array.isArray(sbom.packages) &&
      sbom.documentComment === `package-lock.json sha256:${lockfileHash}`,
    'The packaged runtime SBOM does not match the reviewed package-lock.json.',
  );

  return {
    manifest,
    manifestSha256: sha256(readFileSync(runtimeManifestPath)),
    inventorySha256: sha256(readFileSync(runtimeInventoryPath)),
    sbomSha256: sha256(readFileSync(runtimeSbomPath)),
  };
}

function signatureDescription(path) {
  const result = spawnSync('/usr/bin/codesign', ['-dvvv', path], { encoding: 'utf8' });
  invariant(result.status === 0, `Unable to inspect code signature for ${path}.`);
  return `${result.stdout}${result.stderr}`;
}

function validateDistributionPolicy() {
  if (!requireSignature && !requireNotarization) return;
  invariant(process.platform === 'darwin', 'macOS signature verification requires macOS.');
  for (const nestedCode of [runtimeNode, runtimeAddon]) {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', nestedCode], {
      stdio: 'pipe',
    });
    const description = signatureDescription(nestedCode);
    invariant(
      /Authority=Developer ID Application:/u.test(description) &&
        /TeamIdentifier=/u.test(description),
      `Nested runtime code lacks a Developer ID Application signature: ${nestedCode}`,
    );
  }
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appRoot], {
    stdio: 'pipe',
  });
  const appSignature = signatureDescription(appRoot);
  invariant(
    /Authority=Developer ID Application:/u.test(appSignature) &&
      /TeamIdentifier=/u.test(appSignature),
    'The app lacks a Developer ID Application signature.',
  );
  if (requireNotarization) {
    execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appRoot], {
      stdio: 'pipe',
    });
    execFileSync('xcrun', ['stapler', 'validate', appRoot], { stdio: 'pipe' });
  }
}

function packedVersion(value) {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

function validateCompactVectorPDF(bytes, label) {
  invariant(bytes.length >= 256 && bytes.length <= 32_768, `${label} has an invalid file size.`);
  const pdf = bytes.toString('latin1');
  invariant(pdf.startsWith('%PDF-1.'), `${label} is not a PDF.`);
  invariant(pdf.trimEnd().endsWith('%%EOF'), `${label} has no PDF end marker.`);
  invariant(
    /\/MediaBox\s*\[\s*0\s+0\s+16\s+16\s*\]/u.test(pdf),
    `${label} must use the canonical 16 by 16 vector canvas.`,
  );
  invariant(
    !/(?:\/Subtype\s*\/Image|\/Font\b|\bBT\b|\bTj\b)/u.test(pdf),
    `${label} must contain outlined vector geometry only.`,
  );
  invariant(
    pdf.includes('15.5 8 m') && pdf.includes('4.8 12.1 m') && pdf.includes('6.3 8.8 m'),
    `${label} does not contain the canonical circle and lowercase-p outlines.`,
  );
  const colors = [...pdf.matchAll(/(?:^|\n)([\d.]+\s+[\d.]+\s+[\d.]+)\s+rg(?:\n|$)/gu)].map(
    (match) => match[1],
  );
  invariant(
    colors.length === 1 && colors[0] === '0 0 0' && pdf.includes('\nf*\n'),
    `${label} must contain monochrome product geometry only.`,
  );

  const streamMatch = /<<\s*\/Length\s+(\d+)\s*>>\s*stream\n/u.exec(pdf);
  invariant(streamMatch !== null, `${label} has no bounded vector content stream.`);
  const streamStart = streamMatch.index + streamMatch[0].length;
  const streamEnd = pdf.indexOf('endstream', streamStart);
  invariant(streamEnd >= streamStart, `${label} has a malformed vector content stream.`);
  invariant(
    Buffer.byteLength(pdf.slice(streamStart, streamEnd), 'latin1') === Number(streamMatch[1]),
    `${label} has an invalid vector content length.`,
  );

  const startXref = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(pdf);
  invariant(startXref !== null, `${label} has no valid cross-reference pointer.`);
  invariant(
    pdf.startsWith('xref\n', Number(startXref[1])),
    `${label} has a malformed cross-reference pointer.`,
  );
}

function validateAppIcon(iconBytes, assetCatalogBytes) {
  invariant(iconBytes.length >= 1_024, 'The packaged app icon is unexpectedly small.');
  invariant(iconBytes.subarray(0, 4).toString('ascii') === 'icns', 'The app icon is not ICNS.');
  invariant(
    iconBytes.readUInt32BE(4) === iconBytes.length,
    'The packaged app icon has an invalid length header.',
  );
  invariant(
    assetCatalogBytes.length >= 1_024 &&
      assetCatalogBytes.subarray(0, 8).toString('ascii') === 'BOMStore',
    'The packaged Icon Composer asset catalog is invalid.',
  );
}

function inspectArm64MachO(binary) {
  invariant(
    binary.length >= 32 && binary.readUInt32LE(0) === 0xfeedfacf,
    'The packaged executable is not a little-endian 64-bit Mach-O.',
  );
  invariant(binary.readUInt32LE(4) === 0x0100000c, 'The packaged executable is not arm64-only.');
  const commandCount = binary.readUInt32LE(16);
  let offset = 32;
  let minimumMacOS = null;
  for (let index = 0; index < commandCount; index += 1) {
    invariant(offset + 8 <= binary.length, 'The packaged Mach-O load commands are corrupt.');
    const command = binary.readUInt32LE(offset);
    const commandSize = binary.readUInt32LE(offset + 4);
    invariant(
      commandSize >= 8 && offset + commandSize <= binary.length,
      'The packaged Mach-O load command size is invalid.',
    );
    if (command === 0x32 && commandSize >= 24) {
      if (binary.readUInt32LE(offset + 8) === 1) {
        minimumMacOS = packedVersion(binary.readUInt32LE(offset + 12));
      }
    } else if (command === 0x24 && commandSize >= 16) {
      minimumMacOS = packedVersion(binary.readUInt32LE(offset + 8));
    }
    offset += commandSize;
  }
  invariant(
    minimumMacOS === '13.0.0',
    `The deployment target is ${minimumMacOS ?? 'missing'}, expected 13.0.0.`,
  );
  return minimumMacOS;
}

function keyCount(plist, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [...plist.matchAll(new RegExp(`<key>\\s*${escaped}\\s*</key>`, 'gu'))].length;
}

function validateCanonicalPlist(plistBytes) {
  invariant(process.platform === 'darwin', 'Canonical plist parsing requires macOS.');
  const source = plistBytes.toString('utf8');
  for (const key of [
    'LSUIElement',
    'LSMinimumSystemVersion',
    'CFBundleIdentifier',
    'CFBundleExecutable',
    'CFBundleName',
    'CFBundleDisplayName',
    'CFBundleIconFile',
    'CFBundleIconName',
    'CFBundleShortVersionString',
  ]) {
    invariant(keyCount(source, key) === 1, `Info.plist must contain exactly one ${key}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(
      execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPlist], {
        encoding: 'utf8',
      }),
    );
  } catch (error) {
    throw new Error('Info.plist is not a canonical valid property list.', { cause: error });
  }
  invariant(parsed.LSUIElement === true, 'The packaged app must declare LSUIElement=true.');
  invariant(
    parsed.LSMinimumSystemVersion === '13.0',
    'The packaged app must declare LSMinimumSystemVersion=13.0.',
  );
  invariant(
    parsed.CFBundleIdentifier === 'dev.pimpampum.menubar',
    'The packaged app has an unexpected bundle identifier.',
  );
  invariant(
    parsed.CFBundleExecutable === 'PimpampumMenuBar',
    'The packaged app has an unexpected executable name.',
  );
  invariant(parsed.CFBundleName === 'pim • pam • pum', 'The packaged app has an unexpected name.');
  invariant(
    parsed.CFBundleDisplayName === 'pim • pam • pum',
    'The packaged app has an unexpected display name.',
  );
  invariant(parsed.CFBundleIconFile === 'Pimpampum', 'The packaged app icon file is missing.');
  invariant(parsed.CFBundleIconName === 'Pimpampum', 'The packaged app icon name is missing.');
  invariant(
    parsed.CFBundleShortVersionString === packageVersion,
    `The packaged app must use the package release version ${packageVersion}.`,
  );
}

function approvedSourceCommit() {
  if (appRoot === canonicalAppRoot) {
    const approvalPaths = [
      ...sourcePaths,
      'package.json',
      'package-lock.json',
      'scripts/build-runtime-bundle.mjs',
      'scripts/check-runtime-bundle.mjs',
      'scripts/check-macos-artifact.mjs',
    ];
    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', ...approvalPaths],
      { cwd: repositoryRoot, encoding: 'utf8' },
    ).trim();
    invariant(
      status.length === 0,
      `Refusing to approve a macOS artifact from uncommitted build inputs:\n${status}`,
    );
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim();
}

invariant(
  existsSync(sourceCompactMark) && lstatSync(sourceCompactMark).isFile(),
  `Missing source compact mark: ${sourceCompactMark}`,
);
for (const path of [
  executable,
  infoPlist,
  packagedCompactMark,
  packagedIcon,
  packagedAssetCatalog,
]) {
  invariant(existsSync(path) && lstatSync(path).isFile(), `Missing packaged artifact: ${path}`);
}
invariant(
  (lstatSync(executable).mode & 0o111) !== 0,
  'The packaged macOS app executable is not executable.',
);

const binary = readFileSync(executable);
const plistBytes = readFileSync(infoPlist);
const sourceCompactMarkBytes = readFileSync(sourceCompactMark);
const packagedCompactMarkBytes = readFileSync(packagedCompactMark);
const packagedIconBytes = readFileSync(packagedIcon);
const packagedAssetCatalogBytes = readFileSync(packagedAssetCatalog);
validateCompactVectorPDF(sourceCompactMarkBytes, 'The source compact mark');
validateCompactVectorPDF(packagedCompactMarkBytes, 'The packaged compact mark');
validateAppIcon(packagedIconBytes, packagedAssetCatalogBytes);
const embeddedRuntime = validateEmbeddedRuntime();
invariant(
  packagedCompactMarkBytes.equals(sourceCompactMarkBytes),
  'The packaged compact mark differs from the reviewed source vector.',
);
const metadata = {
  schemaVersion: 3,
  sourceInputSha256: macosSourceHash(repositoryRoot),
  binarySha256: sha256(binary),
  plistSha256: sha256(plistBytes),
  compactMarkSha256: sha256(packagedCompactMarkBytes),
  appIconSha256: sha256(packagedIconBytes),
  assetCatalogSha256: sha256(packagedAssetCatalogBytes),
  runtimeManifestSha256: embeddedRuntime.manifestSha256,
  runtimeInventorySha256: embeddedRuntime.inventorySha256,
  runtimeSbomSha256: embeddedRuntime.sbomSha256,
  runtimeFileCount: embeddedRuntime.manifest.files.length,
  runtimeTarget: 'darwin-arm64',
  binaryFormat: 'Mach-O 64-bit',
  architecture: 'arm64',
  minimumMacOS: inspectArm64MachO(binary),
  lsMinimumSystemVersion: '13.0',
  lsUIElement: true,
  bundleIdentifier: 'dev.pimpampum.menubar',
  executable: 'PimpampumMenuBar',
  appBundle: 'PimpampumMenuBar.app',
  appName: 'pim • pam • pum',
  appVersion: packageVersion,
};

validateDistributionPolicy();

if (approve) {
  invariant(process.platform === 'darwin', 'Artifact approval is allowed only on macOS.');
  validateCanonicalPlist(plistBytes);
  writeFileSync(
    metadataPath,
    `${JSON.stringify({ ...metadata, sourceGitCommit: approvedSourceCommit() }, null, 2)}\n`,
    { mode: 0o644 },
  );
} else {
  invariant(
    existsSync(metadataPath) && lstatSync(metadataPath).isFile(),
    'Approved macOS artifact metadata is missing.',
  );
  let approved;
  try {
    approved = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    throw new Error('Approved macOS artifact metadata is invalid.', { cause: error });
  }
  const { sourceGitCommit, ...approvedArtifact } = approved;
  invariant(
    typeof sourceGitCommit === 'string' && /^[a-f0-9]{40}$/u.test(sourceGitCommit),
    'The approved macOS artifact has no valid source commit.',
  );
  try {
    execFileSync('git', ['cat-file', '-e', `${sourceGitCommit}^{commit}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  } catch (error) {
    throw new Error('The approved macOS artifact source commit is not available.', {
      cause: error,
    });
  }
  invariant(
    JSON.stringify(approvedArtifact) === JSON.stringify(metadata),
    'The staged app does not match its approved metadata, source inputs, and hashes.',
  );
  if (process.platform === 'darwin') validateCanonicalPlist(plistBytes);
}

process.stdout.write(`Verified packaged macOS arm64 app: ${metadata.binarySha256}\n`);
