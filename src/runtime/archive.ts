import { lstatSync, readFileSync } from 'node:fs';
import { inflateRawSync, gunzipSync } from 'node:zlib';

export type RuntimeArchiveFormat = 'zip' | 'tar.gz';

export interface RuntimeArchiveLimits {
  maximumArchiveBytes: number;
  maximumEntries: number;
  maximumFileBytes: number;
  maximumTotalBytes: number;
}

export interface RuntimeArchiveEntry {
  path: string;
  type: 'file' | 'directory';
  uncompressedBytes: number;
  mode: number | null;
}

export interface ValidatedRuntimeArchive {
  format: RuntimeArchiveFormat;
  entries: readonly RuntimeArchiveEntry[];
  fileCount: number;
  totalUncompressedBytes: number;
}

export interface ValidateRuntimeArchiveBytesInput {
  bytes: Uint8Array;
  format: RuntimeArchiveFormat;
  limits?: Partial<RuntimeArchiveLimits>;
}

export interface ValidateRuntimeArchiveFileInput {
  path: string;
  format: RuntimeArchiveFormat;
  limits?: Partial<RuntimeArchiveLimits>;
}

export const DEFAULT_RUNTIME_ARCHIVE_LIMITS: Readonly<RuntimeArchiveLimits> = Object.freeze({
  maximumArchiveBytes: 512 * 1024 * 1024,
  maximumEntries: 20_000,
  maximumFileBytes: 256 * 1024 * 1024,
  maximumTotalBytes: 512 * 1024 * 1024,
});

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const ZIP_MAXIMUM_COMMENT_BYTES = 65_535;
const ZIP_SUPPORTED_FLAGS = 0x0808;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const TAR_BLOCK_BYTES = 512;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function fail(message: string): never {
  throw new Error(`Invalid runtime archive: ${message}`);
}

function safeLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function resolveLimits(overrides: Partial<RuntimeArchiveLimits> | undefined): RuntimeArchiveLimits {
  const limits = {
    ...DEFAULT_RUNTIME_ARCHIVE_LIMITS,
    ...overrides,
  };
  safeLimit(limits.maximumArchiveBytes, 'maximumArchiveBytes');
  safeLimit(limits.maximumEntries, 'maximumEntries');
  safeLimit(limits.maximumFileBytes, 'maximumFileBytes');
  safeLimit(limits.maximumTotalBytes, 'maximumTotalBytes');
  if (limits.maximumFileBytes > limits.maximumTotalBytes) {
    fail('maximumFileBytes cannot exceed maximumTotalBytes');
  }
  return limits;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    fail(`${label} exceeds the safe integer range`);
  }
  return result;
}

function requireRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (offset > bytes.length || length > bytes.length - offset) {
    fail(`${label} is truncated`);
  }
}

function readUint16(bytes: Uint8Array, offset: number, label: string): number {
  requireRange(bytes, offset, 2, label);
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number, label: string): number {
  requireRange(bytes, offset, 4, label);
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function bytesEqual(
  left: Uint8Array,
  leftOffset: number,
  right: Uint8Array,
  rightOffset: number,
  length: number,
): boolean {
  requireRange(left, leftOffset, length, 'byte sequence');
  requireRange(right, rightOffset, length, 'byte sequence');
  for (let index = 0; index < length; index += 1) {
    if (left[leftOffset + index] !== right[rightOffset + index]) {
      return false;
    }
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function normalizeEntryPath(rawPath: string, directory: boolean): string {
  const path = directory && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  if (path.length === 0) {
    fail('entry path is empty');
  }
  if (Buffer.byteLength(path, 'utf8') > 4096) {
    fail('entry path is too long');
  }
  if (path.normalize('NFC') !== path) {
    fail(`entry path ${JSON.stringify(path)} is not Unicode-normalized`);
  }
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) {
    fail(`entry path ${JSON.stringify(path)} is absolute`);
  }
  if (rawPath.includes('\\')) {
    fail(`entry path ${JSON.stringify(rawPath)} contains a backslash`);
  }
  for (const character of rawPath) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      fail(`entry path ${JSON.stringify(rawPath)} contains a control character`);
    }
  }
  if (!directory && rawPath.endsWith('/')) {
    fail(`regular file ${JSON.stringify(rawPath)} has a directory suffix`);
  }
  if (directory && !rawPath.endsWith('/')) {
    fail(`directory ${JSON.stringify(rawPath)} is missing its directory suffix`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`entry path ${JSON.stringify(rawPath)} is non-canonical or contains traversal`);
  }
  return path;
}

class EntryInventory {
  readonly entries: RuntimeArchiveEntry[] = [];
  private readonly exactPaths = new Set<string>();
  private readonly ambiguousPaths = new Map<string, string>();
  private readonly types = new Map<string, RuntimeArchiveEntry['type']>();
  private totalBytes = 0;
  private fileCountValue = 0;

  constructor(private readonly limits: RuntimeArchiveLimits) {}

  add(entry: RuntimeArchiveEntry): void {
    if (this.entries.length >= this.limits.maximumEntries) {
      fail(`entry count exceeds ${this.limits.maximumEntries}`);
    }
    if (this.exactPaths.has(entry.path)) {
      fail(`duplicate entry path ${JSON.stringify(entry.path)}`);
    }
    const ambiguousKey = entry.path.normalize('NFC').toLocaleLowerCase('en-US');
    const ambiguousPath = this.ambiguousPaths.get(ambiguousKey);
    if (ambiguousPath !== undefined) {
      fail(
        `ambiguous entry paths ${JSON.stringify(ambiguousPath)} and ${JSON.stringify(entry.path)}`,
      );
    }
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join('/');
      if (this.types.get(parent) === 'file') {
        fail(
          `entry ${JSON.stringify(entry.path)} is nested under regular file ${JSON.stringify(parent)}`,
        );
      }
    }
    if (entry.type === 'file') {
      const childPrefix = `${entry.path}/`;
      if (this.entries.some((existing) => existing.path.startsWith(childPrefix))) {
        fail(`regular file ${JSON.stringify(entry.path)} is the parent of another entry`);
      }
      if (entry.uncompressedBytes > this.limits.maximumFileBytes) {
        fail(
          `entry ${JSON.stringify(entry.path)} exceeds the ${this.limits.maximumFileBytes} byte file limit`,
        );
      }
      this.totalBytes = checkedAdd(this.totalBytes, entry.uncompressedBytes, 'total size');
      if (this.totalBytes > this.limits.maximumTotalBytes) {
        fail(`uncompressed content exceeds the ${this.limits.maximumTotalBytes} byte total limit`);
      }
      this.fileCountValue += 1;
    } else if (entry.uncompressedBytes !== 0) {
      fail(`directory ${JSON.stringify(entry.path)} contains data`);
    }
    this.exactPaths.add(entry.path);
    this.ambiguousPaths.set(ambiguousKey, entry.path);
    this.types.set(entry.path, entry.type);
    this.entries.push(entry);
  }

  result(format: RuntimeArchiveFormat): ValidatedRuntimeArchive {
    if (this.entries.length === 0) {
      fail('archive contains no entries');
    }
    return {
      format,
      entries: Object.freeze([...this.entries]),
      fileCount: this.fileCountValue,
      totalUncompressedBytes: this.totalBytes,
    };
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findZipEnd(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.length - (22 + ZIP_MAXIMUM_COMMENT_BYTES));
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (readUint32(bytes, offset, 'ZIP end record') !== ZIP_END_OF_CENTRAL_DIRECTORY) {
      continue;
    }
    const commentBytes = readUint16(bytes, offset + 20, 'ZIP end record');
    if (offset + 22 + commentBytes === bytes.length) {
      return offset;
    }
  }
  fail('ZIP end-of-central-directory record is missing or malformed');
}

function validateZipExtra(bytes: Uint8Array, offset: number, length: number, label: string): void {
  const end = checkedAdd(offset, length, label);
  requireRange(bytes, offset, length, label);
  let cursor = offset;
  while (cursor < end) {
    if (end - cursor < 4) {
      fail(`${label} contains a truncated extra field`);
    }
    const identifier = readUint16(bytes, cursor, label);
    const dataBytes = readUint16(bytes, cursor + 2, label);
    cursor += 4;
    if (dataBytes > end - cursor) {
      fail(`${label} contains a truncated extra field`);
    }
    const data = bytes.subarray(cursor, cursor + dataBytes);
    if (identifier === 0x0001) {
      fail('ZIP64 extra fields are unsupported');
    } else if (identifier === 0x5455) {
      if (data.length < 1 || (data[0]! & ~0x07) !== 0) {
        fail(`${label} contains a malformed extended timestamp field`);
      }
      let expectedBytes = 1;
      for (const flag of [1, 2, 4]) {
        if ((data[0]! & flag) !== 0) {
          expectedBytes += 4;
        }
      }
      if (data.length !== expectedBytes) {
        fail(`${label} contains a malformed extended timestamp field`);
      }
    } else if (identifier === 0x7875) {
      if (data.length < 3 || data[0] !== 1) {
        fail(`${label} contains a malformed Unix owner field`);
      }
      const userBytes = data[1]!;
      const groupLengthOffset = 2 + userBytes;
      if (
        userBytes === 0 ||
        userBytes > 8 ||
        groupLengthOffset >= data.length ||
        data[groupLengthOffset] === 0 ||
        data[groupLengthOffset]! > 8 ||
        groupLengthOffset + 1 + data[groupLengthOffset]! !== data.length
      ) {
        fail(`${label} contains a malformed Unix owner field`);
      }
    } else if (identifier === 0x5855) {
      if (data.length !== 8 && data.length !== 12) {
        fail(`${label} contains a malformed legacy Unix metadata field`);
      }
    } else {
      fail(
        `${label} contains unsupported extra field 0x${identifier.toString(16).padStart(4, '0')}`,
      );
    }
    cursor += dataBytes;
  }
}

function zipEntryType(
  versionMadeBy: number,
  externalAttributes: number,
  rawPath: string,
): {
  type: RuntimeArchiveEntry['type'];
  mode: number | null;
} {
  const host = versionMadeBy >>> 8;
  const hasDirectorySuffix = rawPath.endsWith('/');
  if (host === 3) {
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0o170000;
    if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      fail(`ZIP entry ${JSON.stringify(rawPath)} has a link, device, or special Unix type`);
    }
    if ((unixMode & 0o7000) !== 0) {
      fail(`ZIP entry ${JSON.stringify(rawPath)} has special permission bits`);
    }
    const directory = unixType === 0o040000;
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    if (unixType === 0 && hasDirectorySuffix !== dosDirectory) {
      fail(`ZIP entry ${JSON.stringify(rawPath)} has ambiguous type metadata`);
    }
    if (unixType !== 0 && directory !== hasDirectorySuffix) {
      fail(`ZIP entry ${JSON.stringify(rawPath)} has inconsistent type metadata`);
    }
    return {
      type: directory || (unixType === 0 && hasDirectorySuffix) ? 'directory' : 'file',
      mode: unixMode & 0o7777,
    };
  }
  if (host !== 0) {
    fail(`ZIP entry ${JSON.stringify(rawPath)} uses unsupported creator platform ${host}`);
  }
  const dosDirectory = (externalAttributes & 0x10) !== 0;
  if (dosDirectory !== hasDirectorySuffix) {
    fail(`ZIP entry ${JSON.stringify(rawPath)} has inconsistent DOS type metadata`);
  }
  return { type: dosDirectory ? 'directory' : 'file', mode: null };
}

interface ZipCentralEntry {
  versionNeeded: number;
  rawNameOffset: number;
  rawNameLength: number;
  rawPath: string;
  flags: number;
  method: number;
  crc: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localOffset: number;
  type: RuntimeArchiveEntry['type'];
  mode: number | null;
}

function parseZipCentralEntry(
  bytes: Uint8Array,
  offset: number,
): {
  entry: ZipCentralEntry;
  nextOffset: number;
} {
  requireRange(bytes, offset, 46, 'ZIP central directory entry');
  if (readUint32(bytes, offset, 'ZIP central directory entry') !== ZIP_CENTRAL_HEADER) {
    fail('ZIP central directory entry has an invalid signature');
  }
  const versionMadeBy = readUint16(bytes, offset + 4, 'ZIP central directory entry');
  const versionNeeded = readUint16(bytes, offset + 6, 'ZIP central directory entry');
  const flags = readUint16(bytes, offset + 8, 'ZIP central directory entry');
  const method = readUint16(bytes, offset + 10, 'ZIP central directory entry');
  const crc = readUint32(bytes, offset + 16, 'ZIP central directory entry');
  const compressedBytes = readUint32(bytes, offset + 20, 'ZIP central directory entry');
  const uncompressedBytes = readUint32(bytes, offset + 24, 'ZIP central directory entry');
  const nameBytes = readUint16(bytes, offset + 28, 'ZIP central directory entry');
  const extraBytes = readUint16(bytes, offset + 30, 'ZIP central directory entry');
  const commentBytes = readUint16(bytes, offset + 32, 'ZIP central directory entry');
  const diskNumber = readUint16(bytes, offset + 34, 'ZIP central directory entry');
  const externalAttributes = readUint32(bytes, offset + 38, 'ZIP central directory entry');
  const localOffset = readUint32(bytes, offset + 42, 'ZIP central directory entry');
  if (
    compressedBytes === 0xffffffff ||
    uncompressedBytes === 0xffffffff ||
    localOffset === 0xffffffff
  ) {
    fail('ZIP64 entries are unsupported');
  }
  if (versionNeeded > 20) {
    fail(`ZIP entry requires unsupported or ZIP64 version ${versionNeeded}`);
  }
  if (diskNumber !== 0) {
    fail('multi-disk ZIP archives are unsupported');
  }
  if ((flags & ~ZIP_SUPPORTED_FLAGS) !== 0) {
    fail(`ZIP entry uses unsupported general-purpose flags 0x${flags.toString(16)}`);
  }
  if (method !== 0 && method !== 8) {
    fail(`ZIP entry uses unsupported compression method ${method}`);
  }
  const rawNameOffset = offset + 46;
  const variableBytes = checkedAdd(
    checkedAdd(nameBytes, extraBytes, 'ZIP entry size'),
    commentBytes,
    'ZIP entry size',
  );
  requireRange(bytes, rawNameOffset, variableBytes, 'ZIP central directory entry');
  if (nameBytes === 0) {
    fail('ZIP entry has an empty name');
  }
  const rawName = bytes.subarray(rawNameOffset, rawNameOffset + nameBytes);
  if ((flags & 0x0800) === 0 && rawName.some((byte) => byte > 0x7f)) {
    fail('ZIP entry without the UTF-8 flag contains a non-ASCII name');
  }
  const rawPath = decodeUtf8(rawName, 'ZIP entry name');
  validateZipExtra(bytes, rawNameOffset + nameBytes, extraBytes, 'ZIP central directory entry');
  const type = zipEntryType(versionMadeBy, externalAttributes, rawPath);
  return {
    entry: {
      versionNeeded,
      rawNameOffset,
      rawNameLength: nameBytes,
      rawPath,
      flags,
      method,
      crc,
      compressedBytes,
      uncompressedBytes,
      localOffset,
      ...type,
    },
    nextOffset: rawNameOffset + variableBytes,
  };
}

function validateZip(bytes: Uint8Array, limits: RuntimeArchiveLimits): ValidatedRuntimeArchive {
  if (bytes.length < 22) {
    fail('ZIP archive is truncated');
  }
  const endOffset = findZipEnd(bytes);
  const diskNumber = readUint16(bytes, endOffset + 4, 'ZIP end record');
  const centralDisk = readUint16(bytes, endOffset + 6, 'ZIP end record');
  const entriesOnDisk = readUint16(bytes, endOffset + 8, 'ZIP end record');
  const entryCount = readUint16(bytes, endOffset + 10, 'ZIP end record');
  const centralBytes = readUint32(bytes, endOffset + 12, 'ZIP end record');
  const centralOffset = readUint32(bytes, endOffset + 16, 'ZIP end record');
  if (
    entryCount === 0xffff ||
    entriesOnDisk === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    fail('ZIP64 archives are unsupported');
  }
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail('multi-disk ZIP archives are unsupported');
  }
  if (entryCount === 0 || entryCount > limits.maximumEntries) {
    fail(`ZIP entry count is zero or exceeds ${limits.maximumEntries}`);
  }
  if (centralOffset + centralBytes !== endOffset) {
    fail('ZIP central directory bounds are inconsistent');
  }
  requireRange(bytes, centralOffset, centralBytes, 'ZIP central directory');
  if (
    (centralOffset >= 4 &&
      readUint32(bytes, centralOffset - 4, 'ZIP64 locator check') ===
        ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) ||
    readUint32(bytes, centralOffset, 'ZIP central directory') === ZIP64_END_OF_CENTRAL_DIRECTORY
  ) {
    fail('ZIP64 archives are unsupported');
  }

  const centralEntries: ZipCentralEntry[] = [];
  let declaredTotalBytes = 0;
  let centralCursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    const parsed = parseZipCentralEntry(bytes, centralCursor);
    if (parsed.entry.type === 'file') {
      if (parsed.entry.uncompressedBytes > limits.maximumFileBytes) {
        fail(
          `entry ${JSON.stringify(parsed.entry.rawPath)} exceeds the ${limits.maximumFileBytes} byte file limit`,
        );
      }
      declaredTotalBytes = checkedAdd(
        declaredTotalBytes,
        parsed.entry.uncompressedBytes,
        'declared ZIP size',
      );
      if (declaredTotalBytes > limits.maximumTotalBytes) {
        fail(`uncompressed content exceeds the ${limits.maximumTotalBytes} byte total limit`);
      }
    } else if (parsed.entry.uncompressedBytes !== 0) {
      fail(`directory ${JSON.stringify(parsed.entry.rawPath)} contains data`);
    }
    centralEntries.push(parsed.entry);
    centralCursor = parsed.nextOffset;
  }
  if (centralCursor !== endOffset) {
    fail('ZIP central directory has trailing, missing, or uncounted entries');
  }

  const inventory = new EntryInventory(limits);
  let expectedLocalOffset = 0;
  for (const entry of centralEntries.sort((left, right) => left.localOffset - right.localOffset)) {
    if (entry.localOffset !== expectedLocalOffset) {
      fail('ZIP local entries overlap or contain unaccounted bytes');
    }
    requireRange(bytes, entry.localOffset, 30, 'ZIP local entry');
    if (readUint32(bytes, entry.localOffset, 'ZIP local entry') !== ZIP_LOCAL_HEADER) {
      fail('ZIP local entry has an invalid signature');
    }
    const localFlags = readUint16(bytes, entry.localOffset + 6, 'ZIP local entry');
    const localVersionNeeded = readUint16(bytes, entry.localOffset + 4, 'ZIP local entry');
    const localMethod = readUint16(bytes, entry.localOffset + 8, 'ZIP local entry');
    const localCrc = readUint32(bytes, entry.localOffset + 14, 'ZIP local entry');
    const localCompressedBytes = readUint32(bytes, entry.localOffset + 18, 'ZIP local entry');
    const localUncompressedBytes = readUint32(bytes, entry.localOffset + 22, 'ZIP local entry');
    const localNameBytes = readUint16(bytes, entry.localOffset + 26, 'ZIP local entry');
    const localExtraBytes = readUint16(bytes, entry.localOffset + 28, 'ZIP local entry');
    const usesDataDescriptor = (entry.flags & 0x0008) !== 0;
    const localSizesMatch = usesDataDescriptor
      ? localCrc === 0 && localCompressedBytes === 0 && localUncompressedBytes === 0
      : localCrc === entry.crc &&
        localCompressedBytes === entry.compressedBytes &&
        localUncompressedBytes === entry.uncompressedBytes;
    if (
      localVersionNeeded !== entry.versionNeeded ||
      localFlags !== entry.flags ||
      localMethod !== entry.method ||
      !localSizesMatch ||
      localNameBytes !== entry.rawNameLength
    ) {
      fail(`ZIP local and central metadata disagree for ${JSON.stringify(entry.rawPath)}`);
    }
    const localNameOffset = entry.localOffset + 30;
    requireRange(
      bytes,
      localNameOffset,
      localNameBytes + localExtraBytes,
      'ZIP local entry metadata',
    );
    if (!bytesEqual(bytes, localNameOffset, bytes, entry.rawNameOffset, entry.rawNameLength)) {
      fail(`ZIP local and central names disagree for ${JSON.stringify(entry.rawPath)}`);
    }
    validateZipExtra(bytes, localNameOffset + localNameBytes, localExtraBytes, 'ZIP local entry');
    const dataOffset = localNameOffset + localNameBytes + localExtraBytes;
    requireRange(bytes, dataOffset, entry.compressedBytes, 'ZIP entry data');
    const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedBytes);
    let content: Uint8Array;
    if (entry.method === 0) {
      content = compressed;
    } else {
      const maximumOutput = Math.min(limits.maximumFileBytes, entry.uncompressedBytes) + 1;
      try {
        content = inflateRawSync(compressed, { maxOutputLength: maximumOutput });
      } catch {
        fail(`ZIP entry ${JSON.stringify(entry.rawPath)} has invalid or oversized compressed data`);
      }
    }
    if (content.length !== entry.uncompressedBytes) {
      fail(`ZIP entry ${JSON.stringify(entry.rawPath)} has a false uncompressed size`);
    }
    if (crc32(content) !== entry.crc) {
      fail(`ZIP entry ${JSON.stringify(entry.rawPath)} has a CRC mismatch`);
    }
    const path = normalizeEntryPath(entry.rawPath, entry.type === 'directory');
    inventory.add({
      path,
      type: entry.type,
      uncompressedBytes: entry.uncompressedBytes,
      mode: entry.mode,
    });
    const dataEnd = dataOffset + entry.compressedBytes;
    if (usesDataDescriptor) {
      requireRange(bytes, dataEnd, 16, 'ZIP data descriptor');
      if (readUint32(bytes, dataEnd, 'ZIP data descriptor') !== ZIP_DATA_DESCRIPTOR) {
        fail('ZIP data descriptor is unsigned or has an invalid signature');
      }
      if (
        readUint32(bytes, dataEnd + 4, 'ZIP data descriptor') !== entry.crc ||
        readUint32(bytes, dataEnd + 8, 'ZIP data descriptor') !== entry.compressedBytes ||
        readUint32(bytes, dataEnd + 12, 'ZIP data descriptor') !== entry.uncompressedBytes
      ) {
        fail(`ZIP data descriptor disagrees for ${JSON.stringify(entry.rawPath)}`);
      }
      expectedLocalOffset = dataEnd + 16;
    } else {
      expectedLocalOffset = dataEnd;
    }
  }
  if (expectedLocalOffset !== centralOffset) {
    fail('ZIP local data does not end at the central directory');
  }
  return inventory.result('zip');
}

function tarField(bytes: Uint8Array, offset: number, length: number, label: string): Uint8Array {
  requireRange(bytes, offset, length, label);
  return bytes.subarray(offset, offset + length);
}

function tarText(bytes: Uint8Array, offset: number, length: number, label: string): string {
  const field = tarField(bytes, offset, length, label);
  const terminator = field.indexOf(0);
  const valueBytes = terminator === -1 ? field : field.subarray(0, terminator);
  if (terminator !== -1 && field.subarray(terminator).some((byte) => byte !== 0)) {
    fail(`${label} has non-zero bytes after its terminator`);
  }
  return decodeUtf8(valueBytes, label);
}

function tarOctal(bytes: Uint8Array, offset: number, length: number, label: string): number {
  const field = tarField(bytes, offset, length, label);
  if ((field[0]! & 0x80) !== 0) {
    fail(`${label} uses unsupported base-256 encoding`);
  }
  const text = new TextDecoder('ascii')
    .decode(field)
    .replace(/[\0 ]+$/u, '')
    .replace(/^ +/u, '');
  if (text.length === 0) {
    return 0;
  }
  if (!/^[0-7]+$/u.test(text)) {
    fail(`${label} is not strict octal`);
  }
  return Number.parseInt(text, 8);
}

function tarHeaderChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return sum;
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  requireRange(bytes, offset, TAR_BLOCK_BYTES, 'tar block');
  return bytes.subarray(offset, offset + TAR_BLOCK_BYTES).every((byte) => byte === 0);
}

function gunzipBounded(bytes: Uint8Array, limits: RuntimeArchiveLimits): Uint8Array {
  const headerAllowance = checkedAdd(
    limits.maximumEntries * 2 * TAR_BLOCK_BYTES,
    2 * TAR_BLOCK_BYTES,
    'tar header allowance',
  );
  const maximumTarBytes = checkedAdd(limits.maximumTotalBytes, headerAllowance, 'tar size limit');
  try {
    return gunzipSync(bytes, { maxOutputLength: maximumTarBytes });
  } catch {
    fail('gzip stream is truncated, corrupt, concatenated, or exceeds the uncompressed limit');
  }
}

function validateTarGzip(bytes: Uint8Array, limits: RuntimeArchiveLimits): ValidatedRuntimeArchive {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) {
    fail('gzip header is missing, truncated, or unsupported');
  }
  if (bytes[3] !== 0) {
    fail('gzip optional or reserved header flags are unsupported');
  }
  const tar = gunzipBounded(bytes, limits);
  const trailerSize = readUint32(bytes, bytes.length - 4, 'gzip trailer');
  if (trailerSize !== tar.length) {
    fail('gzip stream is concatenated or has an inconsistent size trailer');
  }
  if (tar.length < TAR_BLOCK_BYTES * 2 || tar.length % TAR_BLOCK_BYTES !== 0) {
    fail('tar stream is truncated or not block-aligned');
  }
  const inventory = new EntryInventory(limits);
  let offset = 0;
  let foundEnd = false;
  while (offset < tar.length) {
    if (isZeroBlock(tar, offset)) {
      if (offset + TAR_BLOCK_BYTES >= tar.length || !isZeroBlock(tar, offset + TAR_BLOCK_BYTES)) {
        fail('tar stream does not end with two zero blocks');
      }
      for (let index = offset; index < tar.length; index += 1) {
        if (tar[index] !== 0) {
          fail('tar stream contains data after its end marker');
        }
      }
      foundEnd = true;
      break;
    }
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    requireRange(tar, offset, TAR_BLOCK_BYTES, 'tar header');
    const storedChecksum = tarOctal(header, 148, 8, 'tar checksum');
    if (storedChecksum !== tarHeaderChecksum(header)) {
      fail('tar header checksum is invalid');
    }
    const magic = tarText(header, 257, 6, 'tar magic');
    if (magic !== 'ustar') {
      fail('tar entry is not strict ustar');
    }
    const name = tarText(header, 0, 100, 'tar name');
    const prefix = tarText(header, 345, 155, 'tar prefix');
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const linkName = tarText(header, 157, 100, 'tar link name');
    if (linkName.length !== 0) {
      fail(`tar entry ${JSON.stringify(rawPath)} has link metadata`);
    }
    const mode = tarOctal(header, 100, 8, 'tar mode');
    if ((mode & ~0o777) !== 0) {
      fail(`tar entry ${JSON.stringify(rawPath)} has special permission bits`);
    }
    const size = tarOctal(header, 124, 12, 'tar size');
    const typeFlag = header[156]!;
    let type: RuntimeArchiveEntry['type'];
    if (typeFlag === 0 || typeFlag === 0x30) {
      type = 'file';
    } else if (typeFlag === 0x35) {
      type = 'directory';
    } else {
      fail(
        `tar entry ${JSON.stringify(rawPath)} has unsupported link, device, or special type ${JSON.stringify(String.fromCharCode(typeFlag))}`,
      );
    }
    const path = normalizeEntryPath(rawPath, type === 'directory');
    inventory.add({ path, type, uncompressedBytes: size, mode });
    const dataOffset = offset + TAR_BLOCK_BYTES;
    const paddedBytes = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    requireRange(tar, dataOffset, paddedBytes, `tar data for ${JSON.stringify(rawPath)}`);
    for (let index = dataOffset + size; index < dataOffset + paddedBytes; index += 1) {
      if (tar[index] !== 0) {
        fail(`tar padding for ${JSON.stringify(rawPath)} is non-zero`);
      }
    }
    offset = dataOffset + paddedBytes;
  }
  if (!foundEnd) {
    fail('tar stream has no end marker');
  }
  return inventory.result('tar.gz');
}

export function validateRuntimeArchiveBytes(
  input: ValidateRuntimeArchiveBytesInput,
): ValidatedRuntimeArchive {
  const limits = resolveLimits(input.limits);
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  if (bytes.length === 0 || bytes.length > limits.maximumArchiveBytes) {
    fail(`archive size is zero or exceeds ${limits.maximumArchiveBytes} bytes`);
  }
  if (input.format === 'zip') {
    return validateZip(bytes, limits);
  }
  if (input.format === 'tar.gz') {
    return validateTarGzip(bytes, limits);
  }
  fail(`unsupported format ${JSON.stringify(input.format)}`);
}

export function validateRuntimeArchiveFile(
  input: ValidateRuntimeArchiveFileInput,
): ValidatedRuntimeArchive {
  const limits = resolveLimits(input.limits);
  const metadata = lstatSync(input.path);
  if (!metadata.isFile()) {
    fail('archive path must identify a regular file, not a symlink or special file');
  }
  if (metadata.size === 0 || metadata.size > limits.maximumArchiveBytes) {
    fail(`archive size is zero or exceeds ${limits.maximumArchiveBytes} bytes`);
  }
  const bytes = readFileSync(input.path);
  return validateRuntimeArchiveBytes({ bytes, format: input.format, limits });
}
