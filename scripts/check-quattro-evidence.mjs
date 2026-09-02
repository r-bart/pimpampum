#!/usr/bin/env node

// Validates the Quattro live evidence (`thoughts/evidence/quattro-live.json`) against the candidate
// it names and the artifacts it references. Every validator is a named function whose `fail` calls
// carry one condition each, so a refusal says which bound was crossed. The constants below are
// deliberately not imported from scripts/omarchy-live/: the checker pins what the runner must emit.
//
//   check-quattro-evidence.mjs [evidencePath] [candidateDirectory] [trustedAnchor] [allowedRoot]

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inflateSync } from 'node:zlib';
import { digest, exactObject, isRecord, parseJson, record, timestamp } from './lib/checks.mjs';
import { unwrapCliEnvelope } from './lib/cliEnvelope.mjs';
import { hashFileList, portableRelative, sha256 } from './lib/hashTree.mjs';
import { ancestorDirectories, isInside, isRealDirectory } from './lib/paths.mjs';

const limits = Object.freeze({
  evidence: 1024 * 1024,
  json: 2 * 1024 * 1024,
  screenshot: 20 * 1024 * 1024,
  commandOutput: 256 * 1024,
  candidateFiles: 512,
  candidateEntries: 1024,
  candidateBytes: 32 * 1024 * 1024,
  candidateDepth: 16,
  path: 2048,
});
const maxClockSkew = 5 * 60 * 1_000;
const maxEvidenceAge = 30 * 24 * 60 * 60 * 1_000;
const PLUGIN_ID = 'dev.pimpampum.status';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SCREENSHOT_NAMES = [
  'activePopout',
  'completedPopout',
  'offlineStale',
  'recovered',
  'workspaceOpen',
];
const SYSTEMD_PROBE_ARGUMENTS = [
  '--user',
  'show',
  'pimpampum.service',
  '--property=LoadState,UnitFileState,ActiveState',
];
const EVIDENCE_KEYS = [
  'schemaVersion',
  'status',
  'validatedAt',
  'omarchyVersion',
  'candidateHash',
  'validatedCandidatePath',
  'environment',
  'transcript',
  'baseline',
  'screenshots',
  'visualReview',
  'cleanup',
];
const TRANSCRIPT_ENTRY_KEYS = [
  'label',
  'executable',
  'arguments',
  'exitCode',
  'stdout',
  'stderr',
  'startedAt',
  'finishedAt',
];
const CLEANUP_LABELS = [
  'uninstall',
  'baseline-after-shell',
  'baseline-after-plugins',
  'baseline-after-systemd',
];
const EXPECTED_CHECKS = {
  themeInheritance: 'activePopout',
  horizontalTopLayout: 'activePopout',
  popoutCoordination: 'activePopout',
  activeCount: 'activePopout',
  completedCollapse: 'completedPopout',
  offlineRecovery: 'offlineStale',
  recovered: 'recovered',
  workspaceOpen: 'workspaceOpen',
};

const evidencePath = resolve(process.argv[2] ?? 'thoughts/evidence/quattro-live.json');
const candidateDirectory = resolve(process.argv[3] ?? 'integrations/omarchy/pimpampum-status');
const evidenceDirectory = dirname(evidencePath);
const productionCandidate = existsSync(join(candidateDirectory, '.pimpampum-plugin-owner.json'));
const suppliedTrustedAnchor = process.argv[4] ? resolve(process.argv[4]) : null;
const suppliedAllowedEvidenceRoot = process.argv[5] ? resolve(process.argv[5]) : null;
const claimedArtifacts = new Set();

function fail(message, cause) {
  throw new Error(`Quattro live evidence at ${evidencePath} is invalid: ${message}`, { cause });
}

// ---------------------------------------------------------------------------------------------
// Evidence location (production candidates only)
// ---------------------------------------------------------------------------------------------

function repositoryAnchorForCandidate() {
  let current = candidateDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function validateEvidenceLocation(anchor, allowedRoot) {
  if (!isInside(anchor, allowedRoot, { allowSame: true })) {
    fail('production evidence root is outside its trusted repository anchor');
  }
  if (!isInside(allowedRoot, evidencePath)) {
    fail('production evidence path is outside its trusted repository evidence root');
  }
  for (const current of ancestorDirectories(anchor, evidencePath)) {
    if (!isRealDirectory(current)) fail(`production evidence ancestor is unsafe: ${current}`);
  }
}

function validateProductionLocation() {
  const trustedAnchor = suppliedTrustedAnchor ?? repositoryAnchorForCandidate();
  if (!trustedAnchor) fail('production evidence requires a trusted repository anchor');
  const allowedRoot = suppliedAllowedEvidenceRoot ?? join(trustedAnchor, 'thoughts/evidence');
  validateEvidenceLocation(trustedAnchor, allowedRoot);
}

// ---------------------------------------------------------------------------------------------
// Bounded primitives
// ---------------------------------------------------------------------------------------------

function string(value, label, minimum = 1, maximum = limits.path) {
  if (typeof value !== 'string') fail(`${label} must be a bounded string`);
  if (value.length < minimum || value.length > maximum) fail(`${label} must be a bounded string`);
  if (value.includes('\0')) fail(`${label} must be a bounded string`);
  return value;
}

/** A non-empty string or a non-negative safe integer, returned as its string form. */
function scalar(value, label) {
  const textual = typeof value === 'string' && value.trim().length > 0;
  const numeric = Number.isSafeInteger(value) && value >= 0;
  if (!textual && !numeric) {
    fail(`${label} must be a non-empty string or non-negative safe integer`);
  }
  return string(String(value), label);
}

function realFile(path, maximum, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    fail(`${label} does not exist`, error);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) fail(`${label} must be a real file`);
  if (metadata.size <= 0 || metadata.size > maximum) fail(`${label} exceeds its size bounds`);
  return readFileSync(path);
}

function jsonOf(contents, label) {
  return parseJson(contents.toString('utf8'), label, fail);
}

function artifactPathSegments(relativePath, label) {
  string(relativePath, `${label}.path`, 1, 512);
  if (isAbsolute(relativePath)) fail(`${label}.path must be a portable relative path`);
  if (relativePath.includes('\\')) fail(`${label}.path must use forward slashes`);
  const segments = relativePath.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${label}.path has a forbidden segment`);
  }
  return segments;
}

function assertArtifactAncestors(segments, label) {
  let current = evidenceDirectory;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch (error) {
      fail(`${label}.path does not exist`, error);
    }
    if (metadata.isSymbolicLink()) fail(`${label}.path traverses a symlink`);
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      fail(`${label}.path traverses a non-directory`);
    }
  }
}

/** Resolves an evidence-relative artifact path safely and reads it within `maximum` bytes. */
function artifact(relativePath, maximum, label) {
  const segments = artifactPathSegments(relativePath, label);
  const absolute = resolve(evidenceDirectory, ...segments);
  if (!isInside(evidenceDirectory, absolute)) fail(`${label}.path escapes the evidence directory`);
  assertArtifactAncestors(segments, label);
  return { absolute, contents: realFile(absolute, maximum, label) };
}

function claim(path, label) {
  if (claimedArtifacts.has(path)) fail(`${label}.path must be unique`);
  claimedArtifacts.add(path);
}

// ---------------------------------------------------------------------------------------------
// Candidate digest (bounded walk; the runner's canonical digest without `.git` entries)
// ---------------------------------------------------------------------------------------------

function assertCandidateRoot(root) {
  let metadata;
  try {
    metadata = lstatSync(root);
  } catch (error) {
    fail('candidate root does not exist', error);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('candidate root must be a real directory');
  }
}

function candidateFiles(root) {
  assertCandidateRoot(root);
  const files = [];
  let bytes = 0;
  let entriesSeen = 0;
  const visit = (directory, depth) => {
    if (depth > limits.candidateDepth) fail('candidate nesting is too deep');
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length > limits.candidateFiles) fail('candidate has too many entries');
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > limits.candidateEntries) fail('candidate has too many total entries');
      const path = resolve(directory, entry.name);
      const child = lstatSync(path);
      if (child.isSymbolicLink()) fail(`candidate contains a symlink: ${path}`);
      if (child.isDirectory()) visit(path, depth + 1);
      else if (child.isFile()) {
        files.push(path);
        bytes += child.size;
      } else fail(`candidate contains a non-regular file: ${path}`);
      if (files.length > limits.candidateFiles) fail('candidate exceeds its file limit');
      if (bytes > limits.candidateBytes) fail('candidate exceeds its byte limit');
    }
  };
  visit(root, 0);
  if (files.length === 0) fail('candidate contains no files');
  return files.sort((left, right) => left.localeCompare(right));
}

function candidateHash(root) {
  const files = candidateFiles(root);
  for (const path of files) {
    if (portableRelative(root, path).length > limits.path) {
      fail('candidate contains an overlong path');
    }
  }
  return hashFileList(
    root,
    files.map((path) => ({ path })),
  );
}

// ---------------------------------------------------------------------------------------------
// Command output helpers
// ---------------------------------------------------------------------------------------------

function outputJson(command, label) {
  if (Buffer.byteLength(command.stdout) > limits.commandOutput) {
    fail(`${label}.stdout is too large`);
  }
  return jsonOf(Buffer.from(command.stdout), `${label}.stdout`);
}

/**
 * Pimpampum CLI success is always exactly one {"data": ...} object. Evidence records the raw
 * stdout, so the validator unwraps here rather than rewriting the transcript. Non-CLI probes
 * (omarchy shell and plugin output) keep using `outputJson` directly.
 */
function cliOutputJson(command, label) {
  return unwrapCliEnvelope(outputJson(command, label), `${label}.stdout`, fail);
}

function cliRecord(command, label) {
  return record(cliOutputJson(command, label), `${label}.stdout`, fail);
}

function argumentsEqual(command, expected, label) {
  if (!isDeepStrictEqual(command.arguments, expected)) fail(`${label} has unexpected arguments`);
}

function executableIs(command, executable, label) {
  if (command.executable !== executable) fail(`${label} must use ${executable}`);
}

function outputTrue(command, property, label) {
  if (cliRecord(command, label)[property] !== true) {
    fail(`${label}.stdout must prove ${property}=true`);
  }
}

// ---------------------------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------------------------

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Walks the chunk list; returns the IHDR payload, the IDAT payloads and where IEND stopped. */
function readPngChunks(contents, label) {
  let offset = 8;
  let header;
  let ended = false;
  let chunks = 0;
  const compressed = [];
  while (offset < contents.length) {
    chunks += 1;
    if (chunks > 4096) fail(`${label} has too many PNG chunks`);
    if (offset + 12 > contents.length) fail(`${label} has a truncated PNG chunk`);
    const length = contents.readUInt32BE(offset);
    if (length > limits.screenshot || offset + length + 12 > contents.length) {
      fail(`${label} has an invalid PNG chunk length`);
    }
    const type = contents.subarray(offset + 4, offset + 8).toString('ascii');
    const data = contents.subarray(offset + 8, offset + 8 + length);
    const checksum = crc32(contents.subarray(offset + 4, offset + 8 + length));
    if (checksum !== contents.readUInt32BE(offset + 8 + length)) {
      fail(`${label} has an invalid PNG checksum`);
    }
    if (type === 'IHDR') {
      if (header !== undefined || offset !== 8 || length !== 13) fail(`${label} has invalid IHDR`);
      header = Buffer.from(data);
    } else if (type === 'IDAT') compressed.push(Buffer.from(data));
    else if (type === 'IEND') {
      if (length !== 0) fail(`${label} has invalid IEND`);
      ended = true;
      offset += 12;
      break;
    }
    offset += length + 12;
  }
  if (header === undefined) fail(`${label} is not a complete PNG: no IHDR`);
  if (compressed.length === 0) fail(`${label} is not a complete PNG: no IDAT`);
  if (!ended) fail(`${label} is not a complete PNG: no IEND`);
  if (offset !== contents.length) fail(`${label} is not a complete PNG: trailing bytes`);
  return { header, compressed };
}

/** Validates the IHDR fields; returns the decoded row size and expected raw pixel length. */
function pngGeometry(header, label) {
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  if (width < 320 || height < 180) fail(`${label} must be a PNG of at least 320x180`);
  if (width > 16_384 || height > 16_384) fail(`${label} must be a PNG of at most 16384x16384`);
  if (header[10] !== 0 || header[11] !== 0 || header[12] !== 0) {
    fail(`${label} must be a non-interlaced PNG with standard compression and filtering`);
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const depths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  }[colorType];
  if (channels === undefined || !depths?.includes(bitDepth)) {
    fail(`${label} has unsupported pixels`);
  }
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expected = (rowBytes + 1) * height;
  if (expected > 256 * 1024 * 1024) fail(`${label} is too large when decoded`);
  return { height, rowBytes, expected };
}

function inflatePixels(compressed, expected, label) {
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  } catch (error) {
    fail(`${label} has invalid compressed pixels`, error);
  }
  if (pixels.length !== expected) fail(`${label} has incomplete pixel data`);
  return pixels;
}

/** Every row filter must be valid and the image must hold at least 16 distinct byte values. */
function assertPngContent(pixels, { height, rowBytes }, label) {
  const distinct = new Set();
  for (let row = 0; row < height; row += 1) {
    const start = row * (rowBytes + 1);
    if (pixels[start] > 4) fail(`${label} has an invalid row filter`);
    for (let index = start + 1; index <= start + rowBytes; index += 1) {
      distinct.add(pixels[index]);
      if (distinct.size >= 16) break;
    }
  }
  if (distinct.size < 16) fail(`${label} has no meaningful visual content`);
}

function validatePng(contents, label) {
  if (contents.length < 1024) fail(`${label} is not a meaningful PNG screenshot`);
  if (!contents.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${label} is not a meaningful PNG screenshot`);
  }
  const { header, compressed } = readPngChunks(contents, label);
  const geometry = pngGeometry(header, label);
  assertPngContent(inflatePixels(compressed, geometry.expected, label), geometry, label);
}

// ---------------------------------------------------------------------------------------------
// Baseline snapshots and systemd probes
// ---------------------------------------------------------------------------------------------

function validateBaseline(value, label) {
  const baseline = exactObject(
    value,
    ['shellConfig', 'shellJson', 'plugin', 'service', 'receipt', 'ownedPaths'],
    label,
    fail,
  );
  record(baseline.shellConfig, `${label}.shellConfig`, fail);
  const shellJson = exactObject(
    baseline.shellJson,
    ['exists', 'sha256'],
    `${label}.shellJson`,
    fail,
  );
  if (typeof shellJson.exists !== 'boolean') fail(`${label}.shellJson.exists must be boolean`);
  if (shellJson.exists) digest(shellJson.sha256, `${label}.shellJson.sha256`, fail);
  else if (shellJson.sha256 !== null) fail(`${label}.shellJson.sha256 must be null`);
  const plugin = exactObject(baseline.plugin, ['exists'], `${label}.plugin`, fail);
  const service = exactObject(
    baseline.service,
    ['unitExists', 'enabled', 'running'],
    `${label}.service`,
    fail,
  );
  const receipt = exactObject(baseline.receipt, ['exists'], `${label}.receipt`, fail);
  for (const [name, state] of [
    ['plugin.exists', plugin.exists],
    ['service.unitExists', service.unitExists],
    ['service.enabled', service.enabled],
    ['service.running', service.running],
    ['receipt.exists', receipt.exists],
  ]) {
    if (typeof state !== 'boolean') fail(`${label}.${name} must be boolean`);
  }
  if (!Array.isArray(baseline.ownedPaths) || baseline.ownedPaths.length > 128) {
    fail(`${label}.ownedPaths must be a bounded array`);
  }
  baseline.ownedPaths.forEach((path, index) => string(path, `${label}.ownedPaths[${index}]`));
  return baseline;
}

function assertEmptyBaseline(before) {
  if (before.plugin.exists) fail('baseline proves a pre-existing Pimpampum plugin');
  if (before.service.unitExists) fail('baseline proves a pre-existing Pimpampum unit');
  if (before.service.enabled) fail('baseline proves a pre-existing enabled Pimpampum unit');
  if (before.service.running) fail('baseline proves a pre-existing running Pimpampum unit');
  if (before.receipt.exists) fail('baseline proves a pre-existing Pimpampum receipt');
  if (before.ownedPaths.length !== 0) fail('baseline proves pre-existing Pimpampum owned paths');
}

function systemd(stdout, label) {
  const properties = {};
  for (const line of stdout.trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) fail(`${label} is malformed`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(properties, key)) fail(`${label} has duplicate properties`);
    properties[key] = line.slice(separator + 1);
  }
  const expectedKeys = ['ActiveState', 'LoadState', 'UnitFileState'];
  if (!isDeepStrictEqual(Object.keys(properties).sort(), expectedKeys)) {
    fail(`${label} is incomplete`);
  }
  return properties;
}

// ---------------------------------------------------------------------------------------------
// Evidence header
// ---------------------------------------------------------------------------------------------

function assertEvidenceDirectory() {
  let rootMetadata;
  try {
    rootMetadata = lstatSync(evidenceDirectory);
  } catch (error) {
    fail('evidence directory does not exist', error);
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    fail('evidence directory must be a real directory');
  }
}

function readEvidence() {
  assertEvidenceDirectory();
  const evidence = exactObject(
    jsonOf(realFile(evidencePath, limits.evidence, 'evidence file'), 'evidence file'),
    EVIDENCE_KEYS,
    'evidence',
    fail,
  );
  if (evidence.schemaVersion !== 2) fail('schemaVersion must be 2');
  if (evidence.status !== 'passed') fail('status must be passed');
  return evidence;
}

/** Version, validation time, candidate binding; returns what the later validators depend on. */
function validateHeader(evidence) {
  const version = string(evidence.omarchyVersion, 'omarchyVersion', 1, 128).trim();
  if (version.length === 0) fail('omarchyVersion must not be blank');
  const validatedAt = timestamp(evidence.validatedAt, 'validatedAt', fail);
  const now = Date.now();
  if (validatedAt > now + maxClockSkew) fail('validatedAt is future-dated');
  if (now - validatedAt > maxEvidenceAge) fail('validatedAt is stale');
  digest(evidence.candidateHash, 'candidateHash', fail);
  const validatedCandidatePath = string(
    evidence.validatedCandidatePath,
    'validatedCandidatePath',
  ).trim();
  if (!isAbsolute(validatedCandidatePath)) fail('validatedCandidatePath must be absolute');
  if (resolve(validatedCandidatePath) !== candidateDirectory) {
    fail('validatedCandidatePath must identify the checked candidate exactly');
  }
  const actualCandidateHash = candidateHash(candidateDirectory);
  if (evidence.candidateHash !== actualCandidateHash) fail('candidateHash does not match');
  return { version, validatedAt, now, validatedCandidatePath, actualCandidateHash };
}

function validateEnvironment(evidence) {
  const environment = exactObject(
    evidence.environment,
    ['platform', 'uid', 'waylandDisplay', 'explicitOptIn'],
    'environment',
    fail,
  );
  if (environment.platform !== 'linux') fail('environment.platform must be linux');
  if (!Number.isSafeInteger(environment.uid)) fail('environment.uid must be an integer');
  if (environment.uid <= 0 || environment.uid > 2 ** 31 - 1) {
    fail('environment.uid must be a non-root uid');
  }
  string(environment.waylandDisplay, 'environment.waylandDisplay', 1, 256);
  if (environment.explicitOptIn !== true) fail('environment.explicitOptIn must be true');
}

// ---------------------------------------------------------------------------------------------
// Transcript: order, shape and timestamps
// ---------------------------------------------------------------------------------------------

function prefixLabels() {
  return [
    'version',
    'validation',
    ...(productionCandidate ? ['validation-snapshot'] : []),
    'baseline-before-shell',
    'baseline-before-plugins',
    'baseline-before-systemd',
    'install',
    'status-online',
    'seed-workspace',
    'seed-project',
    'seed-active-spec',
    'ready-active-spec',
    'open-active-project',
    'seed-task',
    'seed-claim',
    'seed-completed-project',
    'seed-completed-spec',
    'ready-completed-spec',
    'open-completed-project',
    'start-completed-spec',
    'complete-spec',
    'complete-project',
    'overview-active-and-complete',
    'hot-reload',
  ];
}

function visualStateLabels() {
  return productionCandidate
    ? [
        'screenshot-activePopout',
        'screenshot-completedPopout',
        'offline',
        'screenshot-offlineStale',
        'recovery',
        'status-recovered',
        'screenshot-recovered',
        'screenshot-workspaceOpen',
        'workspace-open',
      ]
    : ['offline', 'recovery', 'status-recovered'];
}

function readTranscript(evidence) {
  const transcriptRef = exactObject(evidence.transcript, ['path', 'sha256'], 'transcript', fail);
  digest(transcriptRef.sha256, 'transcript.sha256', fail);
  claim(transcriptRef.path, 'transcript');
  const transcriptFile = artifact(transcriptRef.path, limits.json, 'transcript');
  if (sha256(transcriptFile.contents) !== transcriptRef.sha256) fail('transcript hash differs');
  const transcript = jsonOf(transcriptFile.contents, 'transcript');
  if (!Array.isArray(transcript)) fail('transcript must be an array');
  return transcript;
}

/** Walks the label sequence; returns where the plugin-loaded probes sit and the optional tail. */
function validateTranscriptOrder(transcript) {
  const prefix = prefixLabels();
  if (transcript.length < prefix.length + CLEANUP_LABELS.length + 4) {
    fail('transcript command count is outside its bounds');
  }
  if (transcript.length > 80) fail('transcript command count is outside its bounds');
  const actualLabels = transcript.map((command) => command?.label);
  let labelCursor = 0;
  const expect = (label) => {
    if (actualLabels[labelCursor] !== label) fail('transcript has an unexpected label or order');
    labelCursor += 1;
  };
  for (const label of prefix) expect(label);
  const loadedStart = labelCursor;
  while (actualLabels[labelCursor] === 'post-rescan-plugin-loaded') labelCursor += 1;
  const loadedCount = labelCursor - loadedStart;
  if (loadedCount < 1 || loadedCount > 50) fail('plugin-loaded probes must have 1-50 attempts');
  for (const label of visualStateLabels()) expect(label);
  const hasWorkspaceOpen = productionCandidate || actualLabels[labelCursor] === 'workspace-open';
  if (!productionCandidate && hasWorkspaceOpen) labelCursor += 1;
  for (const label of CLEANUP_LABELS) expect(label);
  if (labelCursor !== transcript.length) fail('transcript contains an unexpected command');
  return { loadedStart, loadedCount, hasWorkspaceOpen };
}

function validateTranscriptEntry(entry, index, previousFinished, validatedAt) {
  const label = `transcript[${index}]`;
  const command = exactObject(entry, TRANSCRIPT_ENTRY_KEYS, label, fail);
  string(command.label, `${label}.label`, 1, 64);
  string(command.executable, `${label}.executable`);
  if (!Array.isArray(command.arguments) || command.arguments.length > 16) {
    fail(`${label}.arguments must be bounded`);
  }
  command.arguments.forEach((argument, item) =>
    string(argument, `${label}.arguments[${item}]`, 0, 4096),
  );
  const expectedAbsentSystemd =
    (command.label === 'baseline-before-systemd' || command.label === 'baseline-after-systemd') &&
    [0, 1, 3, 4].includes(command.exitCode);
  if (command.exitCode !== 0 && !expectedAbsentSystemd) {
    fail(`${label}.exitCode must prove success or an absent baseline unit`);
  }
  string(command.stdout, `${label}.stdout`, 0, limits.commandOutput);
  string(command.stderr, `${label}.stderr`, 0, limits.commandOutput);
  if (Buffer.byteLength(command.stdout) > limits.commandOutput) {
    fail(`${label} stdout exceeds its byte bounds`);
  }
  if (Buffer.byteLength(command.stderr) > limits.commandOutput) {
    fail(`${label} stderr exceeds its byte bounds`);
  }
  const started = timestamp(command.startedAt, `${label}.startedAt`, fail);
  const finished = timestamp(command.finishedAt, `${label}.finishedAt`, fail);
  if (started < previousFinished) fail(`${label} started before the previous command finished`);
  if (finished < started) fail(`${label} finished before it started`);
  if (finished > validatedAt) fail(`${label} finished after the evidence was validated`);
  return finished;
}

/** Validates every entry in order; returns when the last command finished. */
function validateTranscriptEntries(transcript, validatedAt) {
  let previousFinished = -Infinity;
  transcript.forEach((entry, index) => {
    previousFinished = validateTranscriptEntry(entry, index, previousFinished, validatedAt);
  });
  return previousFinished;
}

// ---------------------------------------------------------------------------------------------
// Commands: executables and argument arrays
// ---------------------------------------------------------------------------------------------

function validateSnapshotValidation(command, validatedCandidatePath) {
  const label = 'validation-snapshot';
  executableIs(command, 'omarchy', label);
  if (command.arguments.length !== 3) fail(`${label} must pass exactly one path`);
  if (command.arguments[0] !== 'plugin' || command.arguments[1] !== 'validate') {
    fail(`${label} must run plugin validate`);
  }
  const staged = command.arguments[2];
  if (!isAbsolute(staged)) fail(`${label} path must be absolute`);
  if (resolve(staged) === validatedCandidatePath) {
    fail(`${label} must validate the immutable staged copy, not the source candidate`);
  }
  if (basename(staged) !== basename(validatedCandidatePath)) {
    fail(`${label} staged copy must keep the candidate directory name`);
  }
  if (!staged.split(sep).some((part) => part.startsWith('pimpampum-quattro-stage-'))) {
    fail(`${label} staged copy must live under a pimpampum-quattro-stage- directory`);
  }
}

function validateHostCommands(commands, version, validatedCandidatePath) {
  argumentsEqual(commands.version, ['version'], 'version');
  executableIs(commands.version, 'omarchy', 'version');
  if (!commands.version.stdout.includes(version)) {
    fail('version output does not prove omarchyVersion');
  }
  argumentsEqual(commands.validation, ['plugin', 'validate', validatedCandidatePath], 'validation');
  executableIs(commands.validation, 'omarchy', 'validation');
  if (productionCandidate) {
    validateSnapshotValidation(commands['validation-snapshot'], validatedCandidatePath);
  }
  for (const label of ['baseline-before-shell', 'baseline-after-shell']) {
    executableIs(commands[label], 'omarchy-shell', label);
    argumentsEqual(commands[label], ['shell', 'listShellConfig'], label);
  }
  for (const label of ['baseline-before-plugins', 'baseline-after-plugins']) {
    executableIs(commands[label], 'omarchy', label);
    argumentsEqual(commands[label], ['plugin', 'list', '--json'], label);
  }
  for (const label of ['baseline-before-systemd', 'baseline-after-systemd']) {
    executableIs(commands[label], 'systemctl', label);
    argumentsEqual(commands[label], SYSTEMD_PROBE_ARGUMENTS, label);
  }
  executableIs(commands['hot-reload'], 'omarchy-shell', 'hot-reload');
  argumentsEqual(commands['hot-reload'], ['shell', 'rescanPlugins'], 'hot-reload');
  for (const [label, action] of [
    ['offline', 'stop'],
    ['recovery', 'start'],
  ]) {
    executableIs(commands[label], 'systemctl', label);
    argumentsEqual(commands[label], ['--user', action, 'pimpampum.service'], label);
  }
}

/** The install command fixes the runtime and CLI path every later CLI command must reuse. */
function resolveCliBinding(commands) {
  const install = commands.install;
  if (!isAbsolute(install.executable)) fail('install must use an absolute runtime path');
  if (install.arguments.length !== 2) fail('install must pass the CLI path and the verb');
  const runtime = install.executable;
  const cliPath = install.arguments[0];
  if (!isAbsolute(cliPath)) fail('CLI path must be absolute');
  argumentsEqual(install, [cliPath, 'install'], 'install');
  const cli = (label, arguments_) => {
    if (commands[label].executable !== runtime) fail(`${label} must use the install runtime`);
    argumentsEqual(commands[label], [cliPath, ...arguments_], label);
  };
  return { runtime, cliPath, cli };
}

function resolveWorkspacePath(commands, runtime, cliPath) {
  const seedWorkspace = commands['seed-workspace'];
  if (seedWorkspace.executable !== runtime) fail('seed-workspace must use the install runtime');
  if (seedWorkspace.arguments.length !== 5) fail('seed-workspace has an unexpected command shape');
  const workspacePath = seedWorkspace.arguments[4];
  if (!isAbsolute(workspacePath)) fail('seed-workspace path must be absolute');
  argumentsEqual(
    seedWorkspace,
    [cliPath, 'workspace:add', 'live', 'Pimpampum', workspacePath],
    'seed-workspace',
  );
  return workspacePath;
}

function idAndRevision(commands, label) {
  const payload = cliRecord(commands[label], label);
  return {
    id: scalar(payload.id, `${label}.stdout.id`),
    revision: scalar(payload.revision, `${label}.stdout.revision`),
  };
}

/** Replays the seed table: every argument array is rebuilt from the payloads of earlier steps. */
function validateSeedReplay(commands, cli, cliPath) {
  const specBodyPath = resolve(dirname(cliPath), '..', 'README.md');
  cli('seed-project', ['project:create', 'live', 'omarchy-plugin', 'Omarchy plugin']);
  const activeProject = idAndRevision(commands, 'seed-project');
  cli('seed-active-spec', [
    'spec:create',
    activeProject.id,
    'widget-v1',
    'Widget V1',
    specBodyPath,
  ]);
  const activeSpec = idAndRevision(commands, 'seed-active-spec');
  cli('ready-active-spec', ['spec:ready', activeSpec.id, activeSpec.revision]);
  cli('open-active-project', ['project:open', activeProject.id, activeProject.revision]);
  cli('seed-task', ['task:create', activeSpec.id, 'Polish widget design']);
  const taskId =
    commands['seed-task'].stdout.trim() === ''
      ? 'task-id'
      : scalar(cliRecord(commands['seed-task'], 'seed-task').id, 'seed-task.stdout.id');
  cli('seed-claim', ['work:start', 'task', taskId, 'live-agent']);
  cli('seed-completed-project', ['project:create', 'live', 'completed', 'Completed']);
  const completedProject = idAndRevision(commands, 'seed-completed-project');
  cli('seed-completed-spec', [
    'spec:create',
    completedProject.id,
    'completed-spec',
    'Completed Spec',
    specBodyPath,
  ]);
  const completedSpec = idAndRevision(commands, 'seed-completed-spec');
  cli('ready-completed-spec', ['spec:ready', completedSpec.id, completedSpec.revision]);
  const completedReady = cliRecord(commands['ready-completed-spec'], 'ready-completed-spec');
  cli('open-completed-project', ['project:open', completedProject.id, completedProject.revision]);
  const completedOpen = cliRecord(commands['open-completed-project'], 'open-completed-project');
  cli('start-completed-spec', ['work:start', 'spec', completedSpec.id, 'completion-agent']);
  const completedClaim = cliRecord(commands['start-completed-spec'], 'start-completed-spec');
  const claimedRevision = scalar(
    completedClaim.spec?.revision ?? completedClaim.revision ?? completedReady.revision,
    'start-completed-spec.stdout.revision',
  );
  cli('complete-spec', [
    'work:complete',
    'spec',
    completedSpec.id,
    'completion-agent',
    claimedRevision,
    'Complete',
  ]);
  const completedOpenRevision = scalar(
    completedOpen.revision,
    'open-completed-project.stdout.revision',
  );
  cli('complete-project', [
    'project:complete',
    completedProject.id,
    completedOpenRevision,
    'Complete',
  ]);
}

function validateCliCommands(commands) {
  const { runtime, cliPath, cli } = resolveCliBinding(commands);
  cli('status-online', ['status']);
  const workspacePath = resolveWorkspacePath(commands, runtime, cliPath);
  validateSeedReplay(commands, cli, cliPath);
  cli('overview-active-and-complete', ['overview']);
  cli('status-recovered', ['status']);
  cli('uninstall', ['uninstall']);
  return workspacePath;
}

function validateLoadedProbes(loadedCommands) {
  for (const loadedCommand of loadedCommands) {
    executableIs(loadedCommand, 'omarchy', 'post-rescan-plugin-loaded');
    argumentsEqual(loadedCommand, ['plugin', 'list', '--json'], 'post-rescan-plugin-loaded');
  }
}

/** Production captures print one absolute path each; returns them by screenshot name. */
function validateScreenshotCommands(commands) {
  const screenshotCommandPaths = {};
  if (!productionCandidate) return screenshotCommandPaths;
  for (const name of SCREENSHOT_NAMES) {
    const label = `screenshot-${name}`;
    executableIs(commands[label], 'omarchy', label);
    argumentsEqual(commands[label], ['capture', 'screenshot', 'fullscreen', 'save'], label);
    const outputLines = commands[label].stdout.trim().split(/\r?\n/u);
    if (outputLines.length !== 1) fail(`${label} must print exactly one saved screenshot path`);
    if (!isAbsolute(outputLines[0])) fail(`${label} must print an absolute saved screenshot path`);
    screenshotCommandPaths[name] = resolve(outputLines[0]);
  }
  return screenshotCommandPaths;
}

function validateWorkspaceOpen(commands, hasWorkspaceOpen, workspacePath) {
  if (!hasWorkspaceOpen) return;
  executableIs(commands['workspace-open'], 'xdg-open', 'workspace-open');
  argumentsEqual(commands['workspace-open'], [workspacePath], 'workspace-open');
}

// ---------------------------------------------------------------------------------------------
// Command outputs
// ---------------------------------------------------------------------------------------------

function validateOverviewOutput(command) {
  const overview = cliRecord(command, 'overview');
  if (!Array.isArray(overview.projects)) fail('overview must contain bounded projects');
  if (overview.projects.length === 0 || overview.projects.length > 10_000) {
    fail('overview must contain bounded projects');
  }
  const statuses = new Set(
    overview.projects.map(
      (project, index) => record(project, `overview.projects[${index}]`, fail).status,
    ),
  );
  if (!statuses.has('active')) fail('overview must prove an active project');
  if (!statuses.has('complete')) fail('overview must prove a complete project');
}

function pluginEntries(rawProbe, label) {
  return Array.isArray(rawProbe) ? rawProbe : record(rawProbe, `${label}.stdout`, fail).plugins;
}

function validateLoadedOutput(loadedCommands) {
  const label = 'post-rescan-plugin-loaded';
  const loadedEntries = pluginEntries(outputJson(loadedCommands.at(-1), label), label);
  if (!Array.isArray(loadedEntries) || loadedEntries.length > 10_000) {
    fail('post-rescan output does not prove the enabled plugin is loaded');
  }
  const loaded = loadedEntries.some(
    (plugin) => isRecord(plugin) && plugin.id === PLUGIN_ID && plugin.enabled === true,
  );
  if (!loaded) fail('post-rescan output does not prove the enabled plugin is loaded');
}

function validateOutputs(commands, loadedCommands) {
  outputTrue(commands.install, 'installed', 'install');
  outputTrue(commands['status-online'], 'running', 'status-online');
  outputTrue(commands['status-recovered'], 'running', 'status-recovered');
  outputTrue(commands.uninstall, 'uninstalled', 'uninstall');
  validateOverviewOutput(commands['overview-active-and-complete']);
  validateLoadedOutput(loadedCommands);
}

// ---------------------------------------------------------------------------------------------
// Baseline artifacts and their probes
// ---------------------------------------------------------------------------------------------

function readBaselineArtifacts(evidence) {
  const baselineRef = exactObject(
    evidence.baseline,
    ['beforePath', 'beforeSha256', 'afterPath', 'afterSha256', 'restored'],
    'baseline',
    fail,
  );
  digest(baselineRef.beforeSha256, 'baseline.beforeSha256', fail);
  digest(baselineRef.afterSha256, 'baseline.afterSha256', fail);
  if (baselineRef.restored !== true) fail('baseline.restored must be true');
  if (baselineRef.beforePath === baselineRef.afterPath) fail('baseline artifacts must be distinct');
  claim(baselineRef.beforePath, 'baseline.before');
  claim(baselineRef.afterPath, 'baseline.after');
  const beforeFile = artifact(baselineRef.beforePath, limits.json, 'baseline.before');
  const afterFile = artifact(baselineRef.afterPath, limits.json, 'baseline.after');
  if (sha256(beforeFile.contents) !== baselineRef.beforeSha256)
    fail('baseline.before hash differs');
  if (sha256(afterFile.contents) !== baselineRef.afterSha256) fail('baseline.after hash differs');
  if (!beforeFile.contents.equals(afterFile.contents)) {
    fail('baseline files must be byte-identical');
  }
  const before = validateBaseline(
    jsonOf(beforeFile.contents, 'baseline.before'),
    'baseline.before',
  );
  const after = validateBaseline(jsonOf(afterFile.contents, 'baseline.after'), 'baseline.after');
  if (!isDeepStrictEqual(before, after)) fail('baseline states must be deeply equal');
  assertEmptyBaseline(before);
  return { before, after };
}

function validateShellProbes(commands, before, after) {
  const shellBefore = outputJson(commands['baseline-before-shell'], 'baseline-before-shell');
  const shellAfter = outputJson(commands['baseline-after-shell'], 'baseline-after-shell');
  if (!isDeepStrictEqual(shellBefore, before.shellConfig)) {
    fail('baseline-before-shell does not match the recorded shellConfig');
  }
  if (!isDeepStrictEqual(shellAfter, after.shellConfig)) {
    fail('baseline-after-shell does not match the recorded shellConfig');
  }
  if (!isDeepStrictEqual(shellBefore, shellAfter)) {
    fail('shell probes do not prove exact restoration');
  }
}

function validatePluginProbes(commands) {
  const pluginsBefore = outputJson(commands['baseline-before-plugins'], 'baseline-before-plugins');
  const pluginsAfter = outputJson(commands['baseline-after-plugins'], 'baseline-after-plugins');
  for (const [label, rawProbe] of [
    ['baseline-before-plugins', pluginsBefore],
    ['baseline-after-plugins', pluginsAfter],
  ]) {
    const probe = pluginEntries(rawProbe, label);
    if (!Array.isArray(probe) || probe.length > 10_000) fail(`${label} is unbounded`);
    if (probe.some((plugin) => plugin?.id === PLUGIN_ID)) fail(`${label} contains Pimpampum`);
  }
  if (!isDeepStrictEqual(pluginsBefore, pluginsAfter)) fail('plugin probes differ');
}

function validateSystemdProbes(commands) {
  const systemdBefore = systemd(
    commands['baseline-before-systemd'].stdout,
    'baseline-before-systemd',
  );
  const systemdAfter = systemd(commands['baseline-after-systemd'].stdout, 'baseline-after-systemd');
  if (!isDeepStrictEqual(systemdBefore, systemdAfter)) {
    fail('systemd probes do not prove exact cleanup');
  }
  if (systemdBefore.LoadState !== 'not-found') fail('systemd baseline unit must be not-found');
  if (systemdBefore.UnitFileState !== '') fail('systemd baseline unit file state must be empty');
  if (systemdBefore.ActiveState !== 'inactive') fail('systemd baseline unit must be inactive');
}

// ---------------------------------------------------------------------------------------------
// Screenshots, visual review, cleanup
// ---------------------------------------------------------------------------------------------

function validateCapturedBinding(reference, name, label, screenshotCommandPaths) {
  digest(reference.capturedSha256, `${label}.capturedSha256`, fail);
  if (!isAbsolute(reference.capturedPath)) fail(`${label}.capturedPath must be absolute`);
  if (resolve(reference.capturedPath) !== screenshotCommandPaths[name]) {
    fail(`${label} is not bound to its transcript screenshot output path`);
  }
  if (basename(reference.path) !== basename(reference.capturedPath)) {
    fail(`${label} staged file must keep its captured file name`);
  }
  if (reference.capturedSha256 !== reference.sha256) {
    fail(`${label} is not bound to its transcript screenshot hash`);
  }
}

function validateScreenshots(evidence, screenshotCommandPaths) {
  const screenshots = exactObject(evidence.screenshots, SCREENSHOT_NAMES, 'screenshots', fail);
  const screenshotHashes = new Set();
  for (const name of SCREENSHOT_NAMES) {
    const label = `screenshots.${name}`;
    const reference = exactObject(
      screenshots[name],
      productionCandidate
        ? ['path', 'sha256', 'capturedPath', 'capturedSha256']
        : ['path', 'sha256'],
      label,
      fail,
    );
    digest(reference.sha256, `${label}.sha256`, fail);
    claim(reference.path, label);
    const file = artifact(reference.path, limits.screenshot, label);
    const actual = sha256(file.contents);
    if (actual !== reference.sha256) fail(`${label} hash differs`);
    if (productionCandidate) {
      validateCapturedBinding(reference, name, label, screenshotCommandPaths);
    }
    if (screenshotHashes.has(actual)) fail('screenshots must be distinct');
    screenshotHashes.add(actual);
    validatePng(file.contents, label);
  }
}

function validateVisualReview(evidence, { validatedAt, now }, lastCommandFinished) {
  const review = exactObject(
    evidence.visualReview,
    ['approved', 'reviewer', 'reviewedAt', 'checks'],
    'visualReview',
    fail,
  );
  if (review.approved !== true) fail('visualReview.approved must be true');
  if (string(review.reviewer, 'visualReview.reviewer', 1, 200).trim() === '') {
    fail('visualReview.reviewer must identify a human');
  }
  const reviewedAt = timestamp(review.reviewedAt, 'visualReview.reviewedAt', fail);
  if (reviewedAt < lastCommandFinished) fail('visual review happened before the last command');
  if (reviewedAt > validatedAt) fail('visual review happened after validation');
  if (reviewedAt > now + maxClockSkew) fail('visual review is future-dated');
  if (now - reviewedAt > maxEvidenceAge) fail('visual review is stale');
  const checks = exactObject(
    review.checks,
    Object.keys(EXPECTED_CHECKS),
    'visualReview.checks',
    fail,
  );
  if (!isDeepStrictEqual(checks, EXPECTED_CHECKS)) fail('visual review mappings are not exact');
}

function validateCleanup(evidence) {
  const cleanup = exactObject(
    evidence.cleanup,
    ['completed', 'baselineRestored', 'evidenceWrittenAfterCleanup'],
    'cleanup',
    fail,
  );
  if (cleanup.completed !== true) fail('cleanup proof is incomplete: completed must be true');
  if (cleanup.baselineRestored !== true) {
    fail('cleanup proof is incomplete: baselineRestored must be true');
  }
  if (cleanup.evidenceWrittenAfterCleanup !== true) {
    fail('cleanup proof is incomplete: evidenceWrittenAfterCleanup must be true');
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function main() {
  if (productionCandidate) validateProductionLocation();
  const evidence = readEvidence();
  const header = validateHeader(evidence);
  validateEnvironment(evidence);

  const transcript = readTranscript(evidence);
  const { loadedStart, loadedCount, hasWorkspaceOpen } = validateTranscriptOrder(transcript);
  const lastCommandFinished = validateTranscriptEntries(transcript, header.validatedAt);
  const commands = Object.fromEntries(transcript.map((command) => [command.label, command]));
  const loadedCommands = transcript.slice(loadedStart, loadedStart + loadedCount);

  validateHostCommands(commands, header.version, header.validatedCandidatePath);
  const workspacePath = validateCliCommands(commands);
  validateLoadedProbes(loadedCommands);
  const screenshotCommandPaths = validateScreenshotCommands(commands);
  validateWorkspaceOpen(commands, hasWorkspaceOpen, workspacePath);
  validateOutputs(commands, loadedCommands);

  const { before, after } = readBaselineArtifacts(evidence);
  validateShellProbes(commands, before, after);
  validatePluginProbes(commands);
  validateSystemdProbes(commands);

  validateScreenshots(evidence, screenshotCommandPaths);
  validateVisualReview(evidence, header, lastCommandFinished);
  validateCleanup(evidence);

  console.log(
    `Verified Quattro ${header.version} live evidence for candidate ${header.actualCandidateHash} from ${evidence.validatedAt}.`,
  );
}

main();
