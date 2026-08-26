#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const appRoot = resolve(process.argv[2] ?? 'platforms/macos/dist/PimpampumMenuBar.app');
const approve = process.argv.includes('--approve');
const executable = join(appRoot, 'Contents/MacOS/PimpampumMenuBar');
const infoPlist = join(appRoot, 'Contents/Info.plist');
const metadataPath = join(appRoot, 'Contents/Resources/artifact-metadata.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function packedVersion(value) {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`;
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
}

for (const path of [executable, infoPlist]) {
  invariant(existsSync(path) && lstatSync(path).isFile(), `Missing packaged artifact: ${path}`);
}
invariant(
  (lstatSync(executable).mode & 0o111) !== 0,
  'The packaged macOS app executable is not executable.',
);

const binary = readFileSync(executable);
const plistBytes = readFileSync(infoPlist);
const metadata = {
  schemaVersion: 1,
  binarySha256: sha256(binary),
  plistSha256: sha256(plistBytes),
  binaryFormat: 'Mach-O 64-bit',
  architecture: 'arm64',
  minimumMacOS: inspectArm64MachO(binary),
  lsMinimumSystemVersion: '13.0',
  lsUIElement: true,
  bundleIdentifier: 'dev.pimpampum.menubar',
  executable: 'PimpampumMenuBar',
};

if (approve) {
  invariant(process.platform === 'darwin', 'Artifact approval is allowed only on macOS.');
  validateCanonicalPlist(plistBytes);
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
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
  invariant(
    JSON.stringify(approved) === JSON.stringify(metadata),
    'The staged app does not match its approved metadata and hashes.',
  );
  if (process.platform === 'darwin') validateCanonicalPlist(plistBytes);
}

process.stdout.write(`Verified packaged macOS arm64 app: ${metadata.binarySha256}\n`);
