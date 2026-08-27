#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(process.argv[2] ?? 'platforms/macos/dist/PimpampumMenuBar.app');
const canonicalAppRoot = join(repositoryRoot, 'platforms/macos/dist/PimpampumMenuBar.app');
const approve = process.argv.includes('--approve');
const executable = join(appRoot, 'Contents/MacOS/PimpampumMenuBar');
const infoPlist = join(appRoot, 'Contents/Info.plist');
const metadataPath = join(dirname(appRoot), 'PimpampumMenuBar.artifact.json');
const sourceCompactMark = join(repositoryRoot, 'platforms/macos/Resources/PimpampumCompact.pdf');
const packagedCompactMark = join(appRoot, 'Contents/Resources/PimpampumCompact.pdf');
const packagedIcon = join(appRoot, 'Contents/Resources/Pimpampum.icns');
const packagedAssetCatalog = join(appRoot, 'Contents/Resources/Assets.car');
const sourcePaths = [
  'platforms/macos/Package.swift',
  'platforms/macos/Sources',
  'platforms/macos/Resources',
  'branding/app-icon',
  'scripts/build-macos-app.sh',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function macosSourceHash() {
  const roots = sourcePaths.map((path) => join(repositoryRoot, path));
  const files = [];
  const visit = (path) => {
    const metadata = lstatSync(path);
    invariant(!metadata.isSymbolicLink(), `macOS build input must not be a symlink: ${path}`);
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else if (metadata.isFile()) files.push(path);
    else invariant(false, `macOS build input must be a regular file: ${path}`);
  };
  for (const root of roots) visit(root);
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    hash.update(relative(repositoryRoot, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
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
    parsed.CFBundleShortVersionString === '1.0.0',
    'The packaged app must use the package release version 1.0.0.',
  );
}

function approvedSourceCommit() {
  if (appRoot === canonicalAppRoot) {
    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths],
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
invariant(
  packagedCompactMarkBytes.equals(sourceCompactMarkBytes),
  'The packaged compact mark differs from the reviewed source vector.',
);
const metadata = {
  schemaVersion: 2,
  sourceInputSha256: macosSourceHash(),
  binarySha256: sha256(binary),
  plistSha256: sha256(plistBytes),
  compactMarkSha256: sha256(packagedCompactMarkBytes),
  appIconSha256: sha256(packagedIconBytes),
  assetCatalogSha256: sha256(packagedAssetCatalogBytes),
  binaryFormat: 'Mach-O 64-bit',
  architecture: 'arm64',
  minimumMacOS: inspectArm64MachO(binary),
  lsMinimumSystemVersion: '13.0',
  lsUIElement: true,
  bundleIdentifier: 'dev.pimpampum.menubar',
  executable: 'PimpampumMenuBar',
  appBundle: 'PimpampumMenuBar.app',
  appName: 'pim • pam • pum',
  appVersion: '1.0.0',
};

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
