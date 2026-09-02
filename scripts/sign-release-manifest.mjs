#!/usr/bin/env node

// Signs the update-channel manifest with the Ed25519 release key and verifies the result against
// the public key embedded in `src/update.ts`. The signed payload is the contract that
// `releaseSignaturePayload` in `src/update.ts` verifies; both sides must change together.
//
//   sign-release-manifest.mjs --input <unsigned.json> --output <directory>
//                             [--key <private.pem>] [--public-key <public.pem>] [--issued-at <iso>]
//   sign-release-manifest.mjs --check <release-manifest.json> [--public-key <public.pem>]
//
// The private key comes from `--key` or from the `RELEASE_MANIFEST_SIGNING_KEY` environment
// variable (PEM text). `--public-key` replaces the embedded key for development and tests only.

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['darwin-arm64', 'linux-arm64', 'linux-x64'];
const MAXIMUM_MANIFEST_BYTES = 64 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const ISSUED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PUBLIC_KEY_PEM_PATTERN =
  /-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n/u;

function fail(message) {
  throw new Error(`Release manifest signing failed: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The exact bytes each target signature covers; mirrors `releaseSignaturePayload`. */
export function releaseSignaturePayload(input) {
  return [
    'pimpampum-packaged-release-v1',
    'stable',
    input.version,
    input.issuedAt,
    input.target,
    input.url,
    input.sha256,
    String(input.size),
  ].join('\n');
}

/** Reads `RELEASE_PUBLIC_KEY_PEM` out of `src/update.ts` without compiling it. */
export function embeddedReleasePublicKeyPem(repositoryRoot = defaultRepositoryRoot) {
  const source = readFileSync(join(repositoryRoot, 'src/update.ts'), 'utf8');
  const matches = source.match(new RegExp(PUBLIC_KEY_PEM_PATTERN.source, 'gu')) ?? [];
  if (matches.length !== 1) fail('src/update.ts must embed exactly one public key PEM');
  return matches[0];
}

function ed25519PublicKey(pem, label) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new Error(`Release manifest signing failed: ${label} is not a valid public key`, {
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== 'ed25519') fail(`${label} must be Ed25519`);
  return key;
}

function ed25519PrivateKey(pem) {
  let key;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new Error('Release manifest signing failed: signing key is not a valid private key', {
      cause: error,
    });
  }
  if (key.asymmetricKeyType !== 'ed25519') fail('signing key must be Ed25519');
  return key;
}

function validateTargetEntry(target, entry, signed) {
  const expectedKeys = signed ? ['url', 'sha256', 'signature', 'size'] : ['url', 'sha256', 'size'];
  if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== expectedKeys.sort().join(',')) {
    fail(`target ${target} has unexpected or missing fields`);
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    fail(`target ${target} URL is invalid`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(`target ${target} URL scheme`);
  if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    fail(`target ${target} sha256 must be 64 lowercase hex characters`);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
    fail(`target ${target} size must be a positive integer`);
  }
  if (signed && (typeof entry.signature !== 'string' || entry.signature.length === 0)) {
    fail(`target ${target} signature is missing`);
  }
}

function validateManifestShape(manifest, signed) {
  if (!isRecord(manifest)) fail('manifest must be an object');
  const expectedKeys = signed
    ? ['schemaVersion', 'channel', 'version', 'issuedAt', 'targets']
    : ['schemaVersion', 'channel', 'version', 'targets'];
  if (Object.keys(manifest).sort().join(',') !== expectedKeys.sort().join(',')) {
    fail(`manifest has unexpected or missing fields (expected ${expectedKeys.join(', ')})`);
  }
  if (manifest.schemaVersion !== 1) fail('manifest schemaVersion must be 1');
  if (manifest.channel !== 'stable') fail('manifest channel must be stable');
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    fail('manifest version must be exact semver');
  }
  if (
    signed &&
    (typeof manifest.issuedAt !== 'string' || !ISSUED_AT_PATTERN.test(manifest.issuedAt))
  ) {
    fail('manifest issuedAt must be an ISO 8601 UTC instant with milliseconds');
  }
  if (!isRecord(manifest.targets) || Object.keys(manifest.targets).length === 0) {
    fail('manifest must name at least one target');
  }
  for (const [target, entry] of Object.entries(manifest.targets)) {
    if (!TARGETS.includes(target)) fail(`unsupported target ${target}`);
    validateTargetEntry(target, entry, signed);
  }
}

/** Signs every target and returns the manifest the channel publishes. */
export function signReleaseManifest(input) {
  validateManifestShape(input.manifest, false);
  const privateKey = ed25519PrivateKey(input.privateKeyPem);
  const publicKey = ed25519PublicKey(input.publicKeyPem, 'trusted public key');
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  if (derived !== publicKey.export({ type: 'spki', format: 'pem' })) {
    fail('signing key does not match the trusted public key');
  }
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  if (!ISSUED_AT_PATTERN.test(issuedAt) || new Date(issuedAt).toISOString() !== issuedAt) {
    fail('issuedAt must be an ISO 8601 UTC instant with milliseconds');
  }
  const targets = {};
  for (const target of TARGETS) {
    const entry = input.manifest.targets[target];
    if (entry === undefined) continue;
    const payload = releaseSignaturePayload({
      version: input.manifest.version,
      issuedAt,
      target,
      url: entry.url,
      sha256: entry.sha256,
      size: entry.size,
    });
    targets[target] = {
      url: entry.url,
      sha256: entry.sha256,
      signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64'),
      size: entry.size,
    };
  }
  const signed = {
    schemaVersion: 1,
    channel: 'stable',
    version: input.manifest.version,
    issuedAt,
    targets,
  };
  verifyReleaseManifest({ manifest: signed, publicKeyPem: input.publicKeyPem });
  return signed;
}

/** Throws unless every target signature verifies against the public key. */
export function verifyReleaseManifest(input) {
  validateManifestShape(input.manifest, true);
  const publicKey = ed25519PublicKey(input.publicKeyPem, 'trusted public key');
  for (const [target, entry] of Object.entries(input.manifest.targets)) {
    const payload = releaseSignaturePayload({
      version: input.manifest.version,
      issuedAt: input.manifest.issuedAt,
      target,
      url: entry.url,
      sha256: entry.sha256,
      size: entry.size,
    });
    const signature = Buffer.from(entry.signature, 'base64');
    if (
      signature.length !== 64 ||
      !verify(null, Buffer.from(payload, 'utf8'), publicKey, signature)
    ) {
      fail(`target ${target} signature does not verify`);
    }
  }
  return Object.keys(input.manifest.targets).length;
}

function readBoundedJson(path, label) {
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAXIMUM_MANIFEST_BYTES) fail(`${label} is too large`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Release manifest signing failed: ${label} is not valid JSON`, {
      cause: error,
    });
  }
}

function parseArguments(argv) {
  const options = { issuedAt: undefined };
  const flags = new Set(['--input', '--output', '--key', '--public-key', '--issued-at', '--check']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!flags.has(argument)) fail(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${argument} needs a value`);
    options[argument.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] =
      value;
    index += 1;
  }
  return options;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const publicKeyPem = options.publicKey
    ? readFileSync(resolve(options.publicKey), 'utf8')
    : embeddedReleasePublicKeyPem();
  if (options.check) {
    const manifest = readBoundedJson(resolve(options.check), 'signed manifest');
    const count = verifyReleaseManifest({ manifest, publicKeyPem });
    process.stdout.write(
      `Release manifest ${manifest.version} (issued ${manifest.issuedAt}) verifies ${String(count)} target signature(s).\n`,
    );
  } else {
    if (!options.input || !options.output) {
      fail('usage: --input <unsigned.json> --output <directory> [--key <private.pem>]');
    }
    const privateKeyPem = options.key
      ? readFileSync(resolve(options.key), 'utf8')
      : process.env.RELEASE_MANIFEST_SIGNING_KEY;
    if (!privateKeyPem || privateKeyPem.trim().length === 0) {
      fail('no signing key: pass --key <private.pem> or set RELEASE_MANIFEST_SIGNING_KEY');
    }
    const manifest = readBoundedJson(resolve(options.input), 'unsigned manifest');
    const signed = signReleaseManifest({
      manifest,
      privateKeyPem,
      publicKeyPem,
      issuedAt: options.issuedAt,
    });
    const outputDirectory = resolve(options.output);
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      join(outputDirectory, 'release-manifest.json'),
      `${JSON.stringify(signed, null, 2)}\n`,
      { mode: 0o644 },
    );
    writeFileSync(join(outputDirectory, 'pimpampum-release-public-key.pem'), publicKeyPem, {
      mode: 0o644,
    });
    process.stdout.write(
      `Signed release manifest ${signed.version} (issued ${signed.issuedAt}) with ${String(Object.keys(signed.targets).length)} target(s) into ${outputDirectory}\n`,
    );
  }
}
