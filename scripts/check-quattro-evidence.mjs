import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inflateSync } from 'node:zlib';

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
const shaPattern = /^[a-f0-9]{64}$/u;
const maxClockSkew = 5 * 60 * 1_000;
const maxEvidenceAge = 30 * 24 * 60 * 60 * 1_000;
const evidencePath = resolve(process.argv[2] ?? 'thoughts/evidence/quattro-live.json');
const candidateDirectory = resolve(process.argv[3] ?? 'integrations/omarchy/pimpampum-status');
const evidenceDirectory = dirname(evidencePath);
const productionCandidate = existsSync(join(candidateDirectory, '.pimpampum-plugin-owner.json'));
const suppliedTrustedAnchor = process.argv[4] ? resolve(process.argv[4]) : null;
const suppliedAllowedEvidenceRoot = process.argv[5] ? resolve(process.argv[5]) : null;

function fail(message, cause) {
  throw new Error(`Quattro live evidence at ${evidencePath} is invalid: ${message}`, { cause });
}

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

function validateEvidenceAncestors(anchor, allowedRoot) {
  const rootChild = relative(anchor, allowedRoot);
  const evidenceChild = relative(allowedRoot, evidencePath);
  if (
    rootChild === '..' ||
    rootChild.startsWith(`..${sep}`) ||
    isAbsolute(rootChild) ||
    evidenceChild === '' ||
    evidenceChild === '..' ||
    evidenceChild.startsWith(`..${sep}`) ||
    isAbsolute(evidenceChild)
  ) {
    fail('production evidence path is outside its trusted repository evidence root');
  }
  let current = anchor;
  for (const segment of relative(anchor, dirname(evidencePath)).split(sep).filter(Boolean)) {
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail(`production evidence ancestor is unsafe: ${current}`);
    }
    current = join(current, segment);
  }
  const metadata = lstatSync(current);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail(`production evidence ancestor is unsafe: ${current}`);
  }
}

if (productionCandidate) {
  const trustedAnchor = suppliedTrustedAnchor ?? repositoryAnchorForCandidate();
  if (!trustedAnchor) fail('production evidence requires a trusted repository anchor');
  const allowedRoot = suppliedAllowedEvidenceRoot ?? join(trustedAnchor, 'thoughts/evidence');
  validateEvidenceAncestors(trustedAnchor, allowedRoot);
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactObject(value, keys, label) {
  const result = object(value, label);
  if (!isDeepStrictEqual(Object.keys(result).sort(), [...keys].sort())) {
    fail(`${label} must contain exactly: ${[...keys].sort().join(', ')}`);
  }
  return result;
}

function string(value, label, minimum = 1, maximum = limits.path) {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    fail(`${label} must be a bounded string`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !shaPattern.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function scalar(value, label) {
  if (!(
    (typeof value === 'string' && value.trim().length > 0) ||
    (Number.isSafeInteger(value) && value >= 0)
  )) {
    fail(`${label} must be a non-empty string or non-negative safe integer`);
  }
  return string(String(value), label);
}

function timestamp(value, label) {
  string(value, label, 1, 64);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return parsed;
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

function json(contents, label) {
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON`, error);
  }
}

function artifact(relativePath, maximum, label) {
  string(relativePath, `${label}.path`, 1, 512);
  if (isAbsolute(relativePath) || relativePath.includes('\\')) {
    fail(`${label}.path must be a portable relative path`);
  }
  const segments = relativePath.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${label}.path has a forbidden segment`);
  }
  const absolute = resolve(evidenceDirectory, ...segments);
  const fromRoot = relative(evidenceDirectory, absolute);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(`${label}.path escapes the evidence directory`);
  }
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
  return { absolute, contents: realFile(absolute, maximum, label) };
}

function candidateFiles(root) {
  let metadata;
  try {
    metadata = lstatSync(root);
  } catch (error) {
    fail('candidate root does not exist', error);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    fail('candidate root must be a real directory');
  }
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
      if (files.length > limits.candidateFiles || bytes > limits.candidateBytes) {
        fail('candidate exceeds its file or byte limits');
      }
    }
  };
  visit(root, 0);
  if (files.length === 0) fail('candidate contains no files');
  return files.sort((left, right) => left.localeCompare(right));
}

function candidateHash(root) {
  const hash = createHash('sha256');
  for (const path of candidateFiles(root)) {
    const name = relative(root, path).split(sep).join('/');
    if (name.length > limits.path) fail('candidate contains an overlong path');
    const contents = readFileSync(path);
    hash.update(name);
    hash.update('\0');
    hash.update(String(contents.length));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function outputJson(command, label) {
  if (Buffer.byteLength(command.stdout) > limits.commandOutput)
    fail(`${label}.stdout is too large`);
  return json(Buffer.from(command.stdout), `${label}.stdout`);
}

function argumentsEqual(command, expected, label) {
  if (!isDeepStrictEqual(command.arguments, expected)) fail(`${label} has unexpected arguments`);
}

function outputTrue(command, property, label) {
  if (object(outputJson(command, label), `${label}.stdout`)[property] !== true) {
    fail(`${label}.stdout must prove ${property}=true`);
  }
}

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

function validatePng(contents, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contents.length < 1024 || !contents.subarray(0, 8).equals(signature)) {
    fail(`${label} is not a meaningful PNG screenshot`);
  }
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
    if (
      crc32(contents.subarray(offset + 4, offset + 8 + length)) !==
      contents.readUInt32BE(offset + 8 + length)
    ) {
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
  if (header === undefined || compressed.length === 0 || !ended || offset !== contents.length) {
    fail(`${label} is not a complete PNG`);
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const bitDepth = header[8];
  const colorType = header[9];
  if (
    width < 320 ||
    height < 180 ||
    width > 16_384 ||
    height > 16_384 ||
    header[10] !== 0 ||
    header[11] !== 0 ||
    header[12] !== 0
  ) {
    fail(`${label} must be a non-interlaced PNG of at least 320x180`);
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const depths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  }[colorType];
  if (channels === undefined || !depths?.includes(bitDepth))
    fail(`${label} has unsupported pixels`);
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expected = (rowBytes + 1) * height;
  if (expected > 256 * 1024 * 1024) fail(`${label} is too large when decoded`);
  let pixels;
  try {
    pixels = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected });
  } catch (error) {
    fail(`${label} has invalid compressed pixels`, error);
  }
  if (pixels.length !== expected) fail(`${label} has incomplete pixel data`);
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

function validateBaseline(value, label) {
  const baseline = exactObject(
    value,
    ['shellConfig', 'shellJson', 'plugin', 'service', 'receipt', 'ownedPaths'],
    label,
  );
  object(baseline.shellConfig, `${label}.shellConfig`);
  const shellJson = exactObject(baseline.shellJson, ['exists', 'sha256'], `${label}.shellJson`);
  if (typeof shellJson.exists !== 'boolean') fail(`${label}.shellJson.exists must be boolean`);
  if (shellJson.exists) digest(shellJson.sha256, `${label}.shellJson.sha256`);
  else if (shellJson.sha256 !== null) fail(`${label}.shellJson.sha256 must be null`);
  const plugin = exactObject(baseline.plugin, ['exists'], `${label}.plugin`);
  const service = exactObject(
    baseline.service,
    ['unitExists', 'enabled', 'running'],
    `${label}.service`,
  );
  const receipt = exactObject(baseline.receipt, ['exists'], `${label}.receipt`);
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

function systemd(stdout, label) {
  const properties = {};
  for (const line of stdout.trimEnd().split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) fail(`${label} is malformed`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(properties, key)) fail(`${label} has duplicate properties`);
    properties[key] = line.slice(separator + 1);
  }
  if (
    !isDeepStrictEqual(Object.keys(properties).sort(), [
      'ActiveState',
      'LoadState',
      'UnitFileState',
    ])
  ) {
    fail(`${label} is incomplete`);
  }
  return properties;
}

let rootMetadata;
try {
  rootMetadata = lstatSync(evidenceDirectory);
} catch (error) {
  fail('evidence directory does not exist', error);
}
if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
  fail('evidence directory must be a real directory');
}

const evidence = exactObject(
  json(realFile(evidencePath, limits.evidence, 'evidence file'), 'evidence file'),
  [
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
  ],
  'evidence',
);
if (evidence.schemaVersion !== 2 || evidence.status !== 'passed') {
  fail('schemaVersion must be 2 and status must be passed');
}
const version = string(evidence.omarchyVersion, 'omarchyVersion', 1, 128).trim();
if (version.length === 0) fail('omarchyVersion must not be blank');
const validatedAt = timestamp(evidence.validatedAt, 'validatedAt');
const now = Date.now();
if (validatedAt > now + maxClockSkew || now - validatedAt > maxEvidenceAge) {
  fail('validatedAt is stale or future-dated');
}
digest(evidence.candidateHash, 'candidateHash');
const validatedCandidatePath = string(
  evidence.validatedCandidatePath,
  'validatedCandidatePath',
).trim();
if (!isAbsolute(validatedCandidatePath) || resolve(validatedCandidatePath) !== candidateDirectory) {
  fail('validatedCandidatePath must identify the checked candidate exactly');
}
const actualCandidateHash = candidateHash(candidateDirectory);
if (evidence.candidateHash !== actualCandidateHash) fail('candidateHash does not match');

const environment = exactObject(
  evidence.environment,
  ['platform', 'uid', 'waylandDisplay', 'explicitOptIn'],
  'environment',
);
if (environment.platform !== 'linux') fail('environment.platform must be linux');
if (
  !Number.isSafeInteger(environment.uid) ||
  environment.uid <= 0 ||
  environment.uid > 2 ** 31 - 1
) {
  fail('environment.uid must be a non-root uid');
}
string(environment.waylandDisplay, 'environment.waylandDisplay', 1, 256);
if (environment.explicitOptIn !== true) fail('environment.explicitOptIn must be true');

const claimedArtifacts = new Set();
function claim(path, label) {
  if (claimedArtifacts.has(path)) fail(`${label}.path must be unique`);
  claimedArtifacts.add(path);
}

const transcriptRef = exactObject(evidence.transcript, ['path', 'sha256'], 'transcript');
digest(transcriptRef.sha256, 'transcript.sha256');
claim(transcriptRef.path, 'transcript');
const transcriptFile = artifact(transcriptRef.path, limits.json, 'transcript');
if (sha256(transcriptFile.contents) !== transcriptRef.sha256) fail('transcript hash differs');
const transcript = json(transcriptFile.contents, 'transcript');
if (!Array.isArray(transcript)) fail('transcript must be an array');
const prefixLabels = [
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
const cleanupLabels = [
  'uninstall',
  'baseline-after-shell',
  'baseline-after-plugins',
  'baseline-after-systemd',
];
if (transcript.length < prefixLabels.length + cleanupLabels.length + 4 || transcript.length > 80) {
  fail('transcript command count is outside its bounds');
}
const actualLabels = transcript.map((command) => command?.label);
let labelCursor = 0;
for (const label of prefixLabels) {
  if (actualLabels[labelCursor] !== label) fail('transcript has an unexpected label or order');
  labelCursor += 1;
}
const loadedStart = labelCursor;
while (actualLabels[labelCursor] === 'post-rescan-plugin-loaded') labelCursor += 1;
const loadedCount = labelCursor - loadedStart;
if (loadedCount < 1 || loadedCount > 50) fail('plugin-loaded probes must have 1-50 attempts');
const visualStateLabels = productionCandidate
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
for (const label of visualStateLabels) {
  if (actualLabels[labelCursor] !== label) fail('transcript has an unexpected label or order');
  labelCursor += 1;
}
const hasWorkspaceOpen = productionCandidate || actualLabels[labelCursor] === 'workspace-open';
if (!productionCandidate && hasWorkspaceOpen) labelCursor += 1;
for (const label of cleanupLabels) {
  if (actualLabels[labelCursor] !== label) fail('transcript has an unexpected label or order');
  labelCursor += 1;
}
if (labelCursor !== transcript.length) fail('transcript contains an unexpected command');
let previousFinished = -Infinity;
for (let index = 0; index < transcript.length; index += 1) {
  const label = `transcript[${index}]`;
  const command = exactObject(
    transcript[index],
    ['label', 'executable', 'arguments', 'exitCode', 'stdout', 'stderr', 'startedAt', 'finishedAt'],
    label,
  );
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
  if (
    Buffer.byteLength(command.stdout) > limits.commandOutput ||
    Buffer.byteLength(command.stderr) > limits.commandOutput
  ) {
    fail(`${label} output exceeds its byte bounds`);
  }
  const started = timestamp(command.startedAt, `${label}.startedAt`);
  const finished = timestamp(command.finishedAt, `${label}.finishedAt`);
  if (started < previousFinished || finished < started || finished > validatedAt) {
    fail(`${label} timestamps are impossible or out of order`);
  }
  previousFinished = finished;
}
const commands = Object.fromEntries(transcript.map((command) => [command.label, command]));
const loadedCommands = transcript.slice(loadedStart, loadedStart + loadedCount);

argumentsEqual(commands.version, ['version'], 'version');
if (commands.version.executable !== 'omarchy' || !commands.version.stdout.includes(version)) {
  fail('version output does not prove omarchyVersion');
}
argumentsEqual(commands.validation, ['plugin', 'validate', validatedCandidatePath], 'validation');
if (commands.validation.executable !== 'omarchy') fail('validation must use omarchy');
if (productionCandidate) {
  const snapshotValidation = commands['validation-snapshot'];
  if (
    snapshotValidation.executable !== 'omarchy' ||
    snapshotValidation.arguments.length !== 3 ||
    snapshotValidation.arguments[0] !== 'plugin' ||
    snapshotValidation.arguments[1] !== 'validate' ||
    !isAbsolute(snapshotValidation.arguments[2]) ||
    resolve(snapshotValidation.arguments[2]) === validatedCandidatePath ||
    basename(snapshotValidation.arguments[2]) !== basename(validatedCandidatePath) ||
    !snapshotValidation.arguments[2]
      .split(sep)
      .some((part) => part.startsWith('pimpampum-quattro-stage-'))
  ) {
    fail('validation-snapshot must validate the immutable staged production candidate');
  }
}
for (const label of ['baseline-before-shell', 'baseline-after-shell']) {
  if (commands[label].executable !== 'omarchy-shell') fail(`${label} must use omarchy-shell`);
  argumentsEqual(commands[label], ['shell', 'listShellConfig'], label);
}
for (const label of ['baseline-before-plugins', 'baseline-after-plugins']) {
  if (commands[label].executable !== 'omarchy') fail(`${label} must use omarchy`);
  argumentsEqual(commands[label], ['plugin', 'list', '--json'], label);
}
const systemdProbeArguments = [
  '--user',
  'show',
  'pimpampum.service',
  '--property=LoadState,UnitFileState,ActiveState',
];
for (const label of ['baseline-before-systemd', 'baseline-after-systemd']) {
  if (commands[label].executable !== 'systemctl') fail(`${label} must use systemctl`);
  argumentsEqual(commands[label], systemdProbeArguments, label);
}

const install = commands.install;
if (!isAbsolute(install.executable) || install.arguments.length !== 2) {
  fail('install must use absolute runtime and CLI paths');
}
const runtime = install.executable;
const cliPath = install.arguments[0];
if (!isAbsolute(cliPath)) fail('CLI path must be absolute');
argumentsEqual(install, [cliPath, 'install'], 'install');
function cli(label, arguments_) {
  if (commands[label].executable !== runtime) fail(`${label} must use the install runtime`);
  argumentsEqual(commands[label], [cliPath, ...arguments_], label);
}
cli('status-online', ['status']);
const seedWorkspace = commands['seed-workspace'];
if (seedWorkspace.executable !== runtime || seedWorkspace.arguments.length !== 5) {
  fail('seed-workspace has an unexpected command shape');
}
const workspacePath = seedWorkspace.arguments[4];
if (!isAbsolute(workspacePath)) fail('seed-workspace path must be absolute');
argumentsEqual(
  seedWorkspace,
  [cliPath, 'workspace:add', 'live', 'Live', workspacePath],
  'seed-workspace',
);
cli('seed-project', ['project:create', 'live', 'active', 'Active']);
const activeProject = object(
  outputJson(commands['seed-project'], 'seed-project'),
  'seed-project.stdout',
);
const activeProjectId = scalar(activeProject.id, 'seed-project.stdout.id');
const activeRevision = scalar(activeProject.revision, 'seed-project.stdout.revision');
const specBodyPath = resolve(dirname(cliPath), '..', 'README.md');
cli('seed-active-spec', [
  'spec:create',
  activeProjectId,
  'active-spec',
  'Active Spec',
  specBodyPath,
]);
const activeSpec = object(
  outputJson(commands['seed-active-spec'], 'seed-active-spec'),
  'seed-active-spec.stdout',
);
const activeSpecId = scalar(activeSpec.id, 'seed-active-spec.stdout.id');
const activeSpecRevision = scalar(activeSpec.revision, 'seed-active-spec.stdout.revision');
cli('ready-active-spec', ['spec:ready', activeSpecId, activeSpecRevision]);
cli('open-active-project', ['project:open', activeProjectId, activeRevision]);
cli('seed-task', ['task:create', activeSpecId, 'Live task']);
const taskOutput = commands['seed-task'].stdout.trim();
const taskId =
  taskOutput === ''
    ? 'task-id'
    : scalar(
        object(outputJson(commands['seed-task'], 'seed-task'), 'seed-task.stdout').id,
        'seed-task.stdout.id',
      );
cli('seed-claim', ['work:start', 'task', taskId, 'live-agent']);
cli('seed-completed-project', ['project:create', 'live', 'completed', 'Completed']);
const completedProject = object(
  outputJson(commands['seed-completed-project'], 'seed-completed-project'),
  'seed-completed-project.stdout',
);
const completedProjectId = scalar(completedProject.id, 'seed-completed-project.stdout.id');
const completedRevision = scalar(
  completedProject.revision,
  'seed-completed-project.stdout.revision',
);
cli('seed-completed-spec', [
  'spec:create',
  completedProjectId,
  'completed-spec',
  'Completed Spec',
  specBodyPath,
]);
const completedSpec = object(
  outputJson(commands['seed-completed-spec'], 'seed-completed-spec'),
  'seed-completed-spec.stdout',
);
const completedSpecId = scalar(completedSpec.id, 'seed-completed-spec.stdout.id');
const completedSpecRevision = scalar(completedSpec.revision, 'seed-completed-spec.stdout.revision');
cli('ready-completed-spec', ['spec:ready', completedSpecId, completedSpecRevision]);
const completedReady = object(
  outputJson(commands['ready-completed-spec'], 'ready-completed-spec'),
  'ready-completed-spec.stdout',
);
cli('open-completed-project', ['project:open', completedProjectId, completedRevision]);
const completedOpen = object(
  outputJson(commands['open-completed-project'], 'open-completed-project'),
  'open-completed-project.stdout',
);
cli('start-completed-spec', ['work:start', 'spec', completedSpecId, 'completion-agent']);
const completedClaim = object(
  outputJson(commands['start-completed-spec'], 'start-completed-spec'),
  'start-completed-spec.stdout',
);
const claimedRevision = scalar(
  completedClaim.spec?.revision ?? completedClaim.revision ?? completedReady.revision,
  'start-completed-spec.stdout.revision',
);
cli('complete-spec', [
  'work:complete',
  'spec',
  completedSpecId,
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
  completedProjectId,
  completedOpenRevision,
  'Complete',
]);
cli('overview-active-and-complete', ['overview']);
cli('status-recovered', ['status']);
cli('uninstall', ['uninstall']);
if (commands['hot-reload'].executable !== 'omarchy-shell')
  fail('hot-reload must use omarchy-shell');
argumentsEqual(commands['hot-reload'], ['shell', 'rescanPlugins'], 'hot-reload');
for (const loadedCommand of loadedCommands) {
  if (loadedCommand.executable !== 'omarchy') {
    fail('post-rescan-plugin-loaded must use omarchy');
  }
  argumentsEqual(loadedCommand, ['plugin', 'list', '--json'], 'post-rescan-plugin-loaded');
}
for (const [label, action] of [
  ['offline', 'stop'],
  ['recovery', 'start'],
]) {
  if (commands[label].executable !== 'systemctl') fail(`${label} must use systemctl`);
  argumentsEqual(commands[label], ['--user', action, 'pimpampum.service'], label);
}
const screenshotCommandPaths = {};
if (productionCandidate) {
  for (const name of [
    'activePopout',
    'completedPopout',
    'offlineStale',
    'recovered',
    'workspaceOpen',
  ]) {
    const label = `screenshot-${name}`;
    if (commands[label].executable !== 'omarchy') fail(`${label} must use omarchy`);
    argumentsEqual(commands[label], ['capture', 'screenshot', 'fullscreen', 'save'], label);
    const outputLines = commands[label].stdout.trim().split(/\r?\n/u);
    if (outputLines.length !== 1 || !isAbsolute(outputLines[0])) {
      fail(`${label} must print exactly one absolute saved screenshot path`);
    }
    screenshotCommandPaths[name] = resolve(outputLines[0]);
  }
}
if (hasWorkspaceOpen) {
  if (commands['workspace-open'].executable !== 'xdg-open')
    fail('workspace-open must use xdg-open');
  argumentsEqual(commands['workspace-open'], [workspacePath], 'workspace-open');
}

outputTrue(commands.install, 'installed', 'install');
outputTrue(commands['status-online'], 'running', 'status-online');
outputTrue(commands['status-recovered'], 'running', 'status-recovered');
outputTrue(commands.uninstall, 'uninstalled', 'uninstall');
const overview = object(
  outputJson(commands['overview-active-and-complete'], 'overview'),
  'overview.stdout',
);
if (
  !Array.isArray(overview.projects) ||
  overview.projects.length === 0 ||
  overview.projects.length > 10_000
) {
  fail('overview must contain bounded projects');
}
const statuses = new Set(
  overview.projects.map((project, index) => object(project, `overview.projects[${index}]`).status),
);
if (!statuses.has('active') || !statuses.has('complete')) {
  fail('overview must prove active and complete projects');
}
const loaded = outputJson(loadedCommands.at(-1), 'post-rescan-plugin-loaded');
const loadedEntries = Array.isArray(loaded)
  ? loaded
  : object(loaded, 'post-rescan-plugin-loaded.stdout').plugins;
if (
  !Array.isArray(loadedEntries) ||
  loadedEntries.length > 10_000 ||
  !loadedEntries.some(
    (plugin) =>
      plugin !== null &&
      typeof plugin === 'object' &&
      !Array.isArray(plugin) &&
      plugin.id === 'dev.pimpampum.status' &&
      plugin.enabled === true,
  )
) {
  fail('post-rescan output does not prove the enabled plugin is loaded');
}

const baselineRef = exactObject(
  evidence.baseline,
  ['beforePath', 'beforeSha256', 'afterPath', 'afterSha256', 'restored'],
  'baseline',
);
digest(baselineRef.beforeSha256, 'baseline.beforeSha256');
digest(baselineRef.afterSha256, 'baseline.afterSha256');
if (baselineRef.restored !== true) fail('baseline.restored must be true');
if (baselineRef.beforePath === baselineRef.afterPath) fail('baseline artifacts must be distinct');
claim(baselineRef.beforePath, 'baseline.before');
claim(baselineRef.afterPath, 'baseline.after');
const beforeFile = artifact(baselineRef.beforePath, limits.json, 'baseline.before');
const afterFile = artifact(baselineRef.afterPath, limits.json, 'baseline.after');
if (
  sha256(beforeFile.contents) !== baselineRef.beforeSha256 ||
  sha256(afterFile.contents) !== baselineRef.afterSha256
) {
  fail('baseline hashes differ');
}
if (!beforeFile.contents.equals(afterFile.contents)) fail('baseline files must be byte-identical');
const before = validateBaseline(json(beforeFile.contents, 'baseline.before'), 'baseline.before');
const after = validateBaseline(json(afterFile.contents, 'baseline.after'), 'baseline.after');
if (!isDeepStrictEqual(before, after)) fail('baseline states must be deeply equal');
if (
  before.plugin.exists ||
  before.service.unitExists ||
  before.service.enabled ||
  before.service.running ||
  before.receipt.exists ||
  before.ownedPaths.length !== 0
) {
  fail('baseline proves a pre-existing Pimpampum installation');
}
const shellBefore = outputJson(commands['baseline-before-shell'], 'baseline-before-shell');
const shellAfter = outputJson(commands['baseline-after-shell'], 'baseline-after-shell');
if (
  !isDeepStrictEqual(shellBefore, before.shellConfig) ||
  !isDeepStrictEqual(shellAfter, after.shellConfig) ||
  !isDeepStrictEqual(shellBefore, shellAfter)
) {
  fail('shell probes do not prove exact restoration');
}
const pluginsBefore = outputJson(commands['baseline-before-plugins'], 'baseline-before-plugins');
const pluginsAfter = outputJson(commands['baseline-after-plugins'], 'baseline-after-plugins');
for (const [label, rawProbe] of [
  ['baseline-before-plugins', pluginsBefore],
  ['baseline-after-plugins', pluginsAfter],
]) {
  const probe = Array.isArray(rawProbe) ? rawProbe : object(rawProbe, `${label}.stdout`).plugins;
  if (!Array.isArray(probe) || probe.length > 10_000) fail(`${label} is unbounded`);
  if (probe.some((plugin) => plugin?.id === 'dev.pimpampum.status')) {
    fail(`${label} contains Pimpampum`);
  }
}
if (!isDeepStrictEqual(pluginsBefore, pluginsAfter)) fail('plugin probes differ');
const systemdBefore = systemd(
  commands['baseline-before-systemd'].stdout,
  'baseline-before-systemd',
);
const systemdAfter = systemd(commands['baseline-after-systemd'].stdout, 'baseline-after-systemd');
if (
  !isDeepStrictEqual(systemdBefore, systemdAfter) ||
  systemdBefore.LoadState !== 'not-found' ||
  systemdBefore.UnitFileState !== '' ||
  systemdBefore.ActiveState !== 'inactive'
) {
  fail('systemd probes do not prove exact cleanup');
}

const screenshotNames = [
  'activePopout',
  'completedPopout',
  'offlineStale',
  'recovered',
  'workspaceOpen',
];
const screenshots = exactObject(evidence.screenshots, screenshotNames, 'screenshots');
const screenshotHashes = new Set();
for (const name of screenshotNames) {
  const label = `screenshots.${name}`;
  const reference = exactObject(
    screenshots[name],
    productionCandidate ? ['path', 'sha256', 'capturedPath', 'capturedSha256'] : ['path', 'sha256'],
    label,
  );
  digest(reference.sha256, `${label}.sha256`);
  claim(reference.path, label);
  const file = artifact(reference.path, limits.screenshot, label);
  const actual = sha256(file.contents);
  if (actual !== reference.sha256) fail(`${label} hash differs`);
  if (productionCandidate) {
    digest(reference.capturedSha256, `${label}.capturedSha256`);
    if (
      !isAbsolute(reference.capturedPath) ||
      resolve(reference.capturedPath) !== screenshotCommandPaths[name] ||
      basename(reference.path) !== basename(reference.capturedPath) ||
      reference.capturedSha256 !== reference.sha256
    ) {
      fail(`${label} is not bound to its transcript screenshot output path and hash`);
    }
  }
  if (screenshotHashes.has(actual)) fail('screenshots must be distinct');
  screenshotHashes.add(actual);
  validatePng(file.contents, label);
}

const review = exactObject(
  evidence.visualReview,
  ['approved', 'reviewer', 'reviewedAt', 'checks'],
  'visualReview',
);
if (review.approved !== true) fail('visualReview.approved must be true');
if (string(review.reviewer, 'visualReview.reviewer', 1, 200).trim() === '') {
  fail('visualReview.reviewer must identify a human');
}
const reviewedAt = timestamp(review.reviewedAt, 'visualReview.reviewedAt');
if (
  reviewedAt < previousFinished ||
  reviewedAt > validatedAt ||
  reviewedAt > now + maxClockSkew ||
  now - reviewedAt > maxEvidenceAge
) {
  fail('visual review is stale, future-dated, or after validation');
}
const expectedChecks = {
  themeInheritance: 'activePopout',
  horizontalTopLayout: 'activePopout',
  popoutCoordination: 'activePopout',
  activeCount: 'activePopout',
  completedCollapse: 'completedPopout',
  offlineRecovery: 'offlineStale',
  recovered: 'recovered',
  workspaceOpen: 'workspaceOpen',
};
const checks = exactObject(review.checks, Object.keys(expectedChecks), 'visualReview.checks');
if (!isDeepStrictEqual(checks, expectedChecks)) fail('visual review mappings are not exact');

const cleanup = exactObject(
  evidence.cleanup,
  ['completed', 'baselineRestored', 'evidenceWrittenAfterCleanup'],
  'cleanup',
);
if (
  cleanup.completed !== true ||
  cleanup.baselineRestored !== true ||
  cleanup.evidenceWrittenAfterCleanup !== true
) {
  fail('cleanup proof is incomplete');
}

console.log(
  `Verified Quattro ${version} live evidence for candidate ${actualCandidateHash} from ${evidence.validatedAt}.`,
);
