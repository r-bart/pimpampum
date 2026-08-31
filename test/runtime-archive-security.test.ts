import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { validateRuntimeArchiveBytes, validateRuntimeArchiveFile } from '../src/runtime/archive.js';

interface ZipFixtureEntry {
  path: string;
  content?: Uint8Array | string;
  mode?: number;
  method?: 0 | 8;
  flags?: number;
  declaredUncompressedBytes?: number;
  signedDescriptor?: boolean;
  versionNeeded?: number;
  extra?: Uint8Array;
  localExtra?: Uint8Array;
  centralExtra?: Uint8Array;
  host?: number;
  externalAttributes?: number;
  rawName?: Uint8Array;
}

interface TarFixtureEntry {
  path: string;
  content?: Uint8Array | string;
  mode?: number;
  type?: string;
  linkName?: string;
  declaredBytes?: number;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pimpampum-archive-test-'));
  temporaryDirectories.push(directory);
  return directory;
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

function buffer(value: Uint8Array | string | undefined): Buffer {
  return typeof value === 'string' ? Buffer.from(value) : Buffer.from(value ?? []);
}

function zipFixture(entries: readonly ZipFixtureEntry[], zip64End = false): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const fixture of entries) {
    const name = buffer(fixture.rawName ?? fixture.path);
    const localExtra = buffer(fixture.localExtra ?? fixture.extra);
    const centralExtra = buffer(fixture.centralExtra ?? fixture.extra);
    const content = buffer(fixture.content);
    const method = fixture.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const flags = fixture.flags ?? 0x0800;
    const declaredBytes = fixture.declaredUncompressedBytes ?? content.length;
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(fixture.versionNeeded ?? 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    const usesDescriptor = (flags & 0x0008) !== 0;
    local.writeUInt32LE(usesDescriptor ? 0 : checksum, 14);
    local.writeUInt32LE(usesDescriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(usesDescriptor ? 0 : declaredBytes, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    localParts.push(local, name, localExtra, compressed);
    let descriptorBytes = 0;
    if (usesDescriptor) {
      const signedDescriptor = fixture.signedDescriptor ?? true;
      const descriptor = Buffer.alloc(signedDescriptor ? 16 : 12);
      let descriptorOffset = 0;
      if (signedDescriptor) {
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptorOffset = 4;
      }
      descriptor.writeUInt32LE(checksum, descriptorOffset);
      descriptor.writeUInt32LE(compressed.length, descriptorOffset + 4);
      descriptor.writeUInt32LE(declaredBytes, descriptorOffset + 8);
      localParts.push(descriptor);
      descriptorBytes = descriptor.length;
    }

    const unixMode = fixture.mode ?? (fixture.path.endsWith('/') ? 0o040755 : 0o100644);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((fixture.host ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(fixture.versionNeeded ?? 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredBytes, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE(fixture.externalAttributes ?? (unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name, centralExtra);
    localOffset +=
      local.length + name.length + localExtra.length + compressed.length + descriptorBytes;
  }
  const localBytes = Buffer.concat(localParts);
  const centralBytes = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64End ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64End ? 0xffff : entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, end]);
}

function writeTarText(header: Buffer, value: string, offset: number, length: number): void {
  const encoded = Buffer.from(value);
  if (encoded.length > length) {
    throw new Error('fixture field is too long');
  }
  encoded.copy(header, offset);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  writeTarText(header, encoded, offset, length - 1);
  header[offset + length - 1] = 0;
}

function tarFixture(entries: readonly TarFixtureEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const fixture of entries) {
    const header = Buffer.alloc(512);
    const content = buffer(fixture.content);
    writeTarText(header, fixture.path, 0, 100);
    writeTarOctal(header, fixture.mode ?? 0o644, 100, 8);
    writeTarOctal(header, 0, 108, 8);
    writeTarOctal(header, 0, 116, 8);
    writeTarOctal(header, fixture.declaredBytes ?? content.length, 124, 12);
    writeTarOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = (fixture.type ?? '0').charCodeAt(0);
    writeTarText(header, fixture.linkName ?? '', 157, 100);
    writeTarText(header, 'ustar', 257, 6);
    writeTarText(header, '00', 263, 2);
    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    writeTarText(header, checksum.toString(8).padStart(6, '0'), 148, 6);
    header[154] = 0;
    header[155] = 0x20;
    parts.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) {
      parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

function recomputeTarChecksum(tar: Buffer, headerOffset = 0): void {
  tar.fill(0x20, headerOffset + 148, headerOffset + 156);
  let checksum = 0;
  for (let index = headerOffset; index < headerOffset + 512; index += 1) {
    checksum += tar[index]!;
  }
  writeTarText(tar, checksum.toString(8).padStart(6, '0'), headerOffset + 148, 6);
  tar[headerOffset + 154] = 0;
  tar[headerOffset + 155] = 0x20;
}

function mutateTar(
  archive: Uint8Array,
  mutate: (tar: Buffer) => void,
  recomputeChecksum = true,
): Buffer {
  const tar = Buffer.from(gunzipSync(archive));
  mutate(tar);
  if (recomputeChecksum) {
    recomputeTarChecksum(tar);
  }
  return gzipSync(tar);
}

function zipCentralOffset(bytes: Buffer): number {
  return bytes.readUInt32LE(bytes.length - 6);
}

function mutateZip(
  entries: readonly ZipFixtureEntry[],
  mutate: (bytes: Buffer, centralOffset: number, endOffset: number) => void,
): Buffer {
  const bytes = zipFixture(entries);
  const centralOffset = zipCentralOffset(bytes);
  mutate(bytes, centralOffset, bytes.length - 22);
  return bytes;
}

function zipExtra(identifier: number, data: readonly number[]): Buffer {
  const extra = Buffer.alloc(4 + data.length);
  extra.writeUInt16LE(identifier, 0);
  extra.writeUInt16LE(data.length, 2);
  Buffer.from(data).copy(extra, 4);
  return extra;
}

function rejects(bytes: Uint8Array, format: 'zip' | 'tar.gz', pattern: RegExp): void {
  expect(() => validateRuntimeArchiveBytes({ bytes, format })).toThrow(pattern);
}

describe('runtime archive prevalidation', () => {
  it('fully validates stored and deflated ZIP contents before extraction', () => {
    const result = validateRuntimeArchiveBytes({
      format: 'zip',
      bytes: zipFixture([
        { path: 'Pimpampum.app/', method: 0 },
        { path: 'Pimpampum.app/Contents/MacOS/pimpampum', content: 'binary', mode: 0o100755 },
        { path: 'Pimpampum.app/Contents/Info.plist', content: 'plist', method: 0 },
      ]),
    });

    expect(result).toMatchObject({
      format: 'zip',
      fileCount: 2,
      totalUncompressedBytes: 11,
    });
    expect(result.entries.map((entry) => entry.path)).toEqual([
      'Pimpampum.app',
      'Pimpampum.app/Contents/MacOS/pimpampum',
      'Pimpampum.app/Contents/Info.plist',
    ]);
  });

  it('rejects ZIP traversal, duplicates, ambiguous names, and file-parent collisions', () => {
    rejects(zipFixture([{ path: '../escape', content: 'bad' }]), 'zip', /traversal/u);
    rejects(
      zipFixture([
        { path: 'same', content: 'one' },
        { path: 'same', content: 'two' },
      ]),
      'zip',
      /duplicate/u,
    );
    rejects(
      zipFixture([
        { path: 'App/File', content: 'one' },
        { path: 'app/file', content: 'two' },
      ]),
      'zip',
      /ambiguous/u,
    );
    rejects(
      zipFixture([
        { path: 'parent/child', content: 'one' },
        { path: 'parent', content: 'two' },
      ]),
      'zip',
      /parent/u,
    );
  });

  it('rejects ZIP links/devices even when a child entry follows them', () => {
    rejects(
      zipFixture([
        { path: 'link', content: 'target', mode: 0o120777 },
        { path: 'link/child', content: 'payload' },
      ]),
      'zip',
      /link, device, or special/u,
    );
    rejects(zipFixture([{ path: 'device', mode: 0o060600 }]), 'zip', /link, device, or special/u);
  });

  it('handles signed ZIP data descriptors and rejects unsigned descriptors', () => {
    expect(
      validateRuntimeArchiveBytes({
        format: 'zip',
        bytes: zipFixture([{ path: 'file', content: 'x', flags: 0x0808 }]),
      }).fileCount,
    ).toBe(1);
    rejects(
      zipFixture([{ path: 'file', content: 'x', flags: 0x0808, signedDescriptor: false }]),
      'zip',
      /unsigned|invalid signature/u,
    );
  });

  it('rejects ZIP64, false sizes, declared bombs, and truncation', () => {
    rejects(zipFixture([{ path: 'file', content: 'x' }], true), 'zip', /ZIP64/u);
    rejects(
      zipFixture([{ path: 'file', content: 'x', versionNeeded: 45 }]),
      'zip',
      /ZIP64 version/u,
    );
    rejects(
      zipFixture([{ path: 'file', content: 'x', declaredUncompressedBytes: 2 }]),
      'zip',
      /false uncompressed size/u,
    );
    rejects(
      zipFixture([{ path: 'bomb', declaredUncompressedBytes: 300_000_000 }]),
      'zip',
      /file limit/u,
    );
    const complete = zipFixture([{ path: 'file', content: 'payload' }]);
    rejects(complete.subarray(0, complete.length - 4), 'zip', /missing or malformed|truncated/u);
  });

  it('fully validates strict ustar gzip contents before extraction', () => {
    const result = validateRuntimeArchiveBytes({
      format: 'tar.gz',
      bytes: tarFixture([
        { path: 'runtime/', type: '5', mode: 0o755 },
        { path: 'runtime/bin/node', content: 'node', mode: 0o755 },
        { path: 'runtime/dist/cli.js', content: 'cli' },
      ]),
    });

    expect(result).toMatchObject({
      format: 'tar.gz',
      fileCount: 2,
      totalUncompressedBytes: 7,
    });
  });

  it('rejects tar traversal, duplicate/ambiguous paths, and link-with-child archives', () => {
    rejects(tarFixture([{ path: '../escape', content: 'bad' }]), 'tar.gz', /traversal/u);
    rejects(
      tarFixture([
        { path: 'same', content: 'one' },
        { path: 'same', content: 'two' },
      ]),
      'tar.gz',
      /duplicate/u,
    );
    rejects(
      tarFixture([
        { path: 'Runtime/File', content: 'one' },
        { path: 'runtime/file', content: 'two' },
      ]),
      'tar.gz',
      /ambiguous/u,
    );
    rejects(
      tarFixture([
        { path: 'link', type: '2', linkName: '../outside' },
        { path: 'link/child', content: 'payload' },
      ]),
      'tar.gz',
      /link metadata|unsupported link/u,
    );
  });

  it('rejects tar hardlinks, devices, declared bombs, checksum drift, and truncation', () => {
    rejects(
      tarFixture([{ path: 'hard', type: '1', linkName: 'target' }]),
      'tar.gz',
      /link metadata|unsupported link/u,
    );
    rejects(tarFixture([{ path: 'device', type: '3' }]), 'tar.gz', /unsupported link, device/u);
    rejects(tarFixture([{ path: 'bomb', declaredBytes: 300_000_000 }]), 'tar.gz', /file limit/u);
    const valid = tarFixture([{ path: 'file', content: 'payload' }]);
    const inflated = Buffer.from(gunzipSync(valid));
    inflated[0] = inflated[0]! ^ 1;
    rejects(gzipSync(inflated), 'tar.gz', /checksum/u);
    rejects(valid.subarray(0, valid.length - 3), 'tar.gz', /gzip stream/u);
  });

  it('validates a file path and enforces caller-supplied entry and total limits', () => {
    const root = temporaryDirectory();
    const path = join(root, 'runtime.tar.gz');
    writeFileSync(
      path,
      tarFixture([
        { path: 'one', content: '12' },
        { path: 'two', content: '34' },
      ]),
    );

    expect(validateRuntimeArchiveFile({ path, format: 'tar.gz' }).fileCount).toBe(2);
    const linkedPath = join(root, 'linked.tar.gz');
    symlinkSync(path, linkedPath);
    expect(() => validateRuntimeArchiveFile({ path: linkedPath, format: 'tar.gz' })).toThrow(
      /regular file/u,
    );
    expect(() =>
      validateRuntimeArchiveFile({
        path,
        format: 'tar.gz',
        limits: { maximumEntries: 1 },
      }),
    ).toThrow(/entry count/u);
    expect(() =>
      validateRuntimeArchiveFile({
        path,
        format: 'tar.gz',
        limits: { maximumFileBytes: 4, maximumTotalBytes: 3 },
      }),
    ).toThrow(/maximumFileBytes cannot exceed/u);
  });

  it('rejects every non-portable path representation', () => {
    const tarPaths = [
      '',
      '/absolute',
      'C:drive',
      'back\\slash',
      'control\nname',
      'delete\u007fname',
      'double//slash',
      'dot/./segment',
      'decomposed-e\u0301',
    ];
    for (const path of tarPaths) {
      rejects(tarFixture([{ path, content: 'x' }]), 'tar.gz', /entry path/u);
    }
    rejects(zipFixture([{ path: 'x'.repeat(4097), content: 'x' }]), 'zip', /too long/u);
    rejects(tarFixture([{ path: 'file/', content: 'x' }]), 'tar.gz', /directory suffix/u);
    rejects(tarFixture([{ path: 'directory', type: '5' }]), 'tar.gz', /missing its directory/u);
    rejects(tarFixture([{ path: '/', type: '5' }]), 'tar.gz', /entry path is empty/u);
  });

  it('rejects malformed and unsafe ZIP extra fields while accepting bounded metadata', () => {
    const acceptedExtras = [
      zipExtra(0x5455, [0]),
      zipExtra(0x5455, [7, ...Array.from({ length: 12 }, () => 0)]),
      zipExtra(0x7875, [1, 1, 1, 1, 1]),
      zipExtra(
        0x5855,
        Array.from({ length: 8 }, () => 0),
      ),
      zipExtra(
        0x5855,
        Array.from({ length: 12 }, () => 0),
      ),
    ];
    for (const extra of acceptedExtras) {
      expect(
        validateRuntimeArchiveBytes({
          format: 'zip',
          bytes: zipFixture([{ path: 'file', content: 'x', extra }]),
        }).fileCount,
      ).toBe(1);
    }

    const rejectedExtras = [
      Buffer.from([1, 2]),
      Buffer.from([0x55, 0x54, 5, 0, 1]),
      zipExtra(0x0001, []),
      zipExtra(0x5455, []),
      zipExtra(0x5455, [8]),
      zipExtra(0x5455, [1]),
      zipExtra(0x7875, [1, 1]),
      zipExtra(0x7875, [2, 1, 1, 1, 1]),
      zipExtra(0x7875, [1, 0, 1]),
      zipExtra(0x7875, [1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]),
      zipExtra(0x7875, [1, 2, 1]),
      zipExtra(0x7875, [1, 1, 1, 0]),
      zipExtra(0x7875, [1, 1, 1, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      zipExtra(0x7875, [1, 1, 1, 1, 1, 0]),
      zipExtra(0x5855, [0]),
      zipExtra(0x9999, []),
    ];
    for (const extra of rejectedExtras) {
      rejects(zipFixture([{ path: 'file', content: 'x', extra }]), 'zip', /extra|malformed|ZIP64/u);
    }
    rejects(
      zipFixture([
        {
          path: 'file',
          content: 'x',
          centralExtra: zipExtra(0x5455, [0]),
          localExtra: zipExtra(0x9999, []),
        },
      ]),
      'zip',
      /local entry contains unsupported extra/u,
    );
  });

  it('validates ZIP creator type metadata without type ambiguity', () => {
    const validDos = zipFixture([
      { path: 'directory/', method: 0, host: 0, externalAttributes: 0x10 },
      { path: 'file', content: 'x', host: 0, externalAttributes: 0 },
    ]);
    expect(validateRuntimeArchiveBytes({ bytes: validDos, format: 'zip' }).fileCount).toBe(1);
    const validUntypedUnix = zipFixture([
      { path: 'directory/', method: 0, externalAttributes: 0x10 },
      { path: 'file', content: 'x', externalAttributes: 0 },
    ]);
    expect(validateRuntimeArchiveBytes({ bytes: validUntypedUnix, format: 'zip' }).fileCount).toBe(
      1,
    );

    rejects(
      zipFixture([{ path: 'privileged', content: 'x', mode: 0o104755 }]),
      'zip',
      /special permission/u,
    );
    rejects(
      zipFixture([{ path: 'ambiguous', content: 'x', externalAttributes: 0x10 }]),
      'zip',
      /ambiguous type/u,
    );
    rejects(zipFixture([{ path: 'file/', mode: 0o100644 }]), 'zip', /inconsistent type/u);
    rejects(zipFixture([{ path: 'file', host: 7 }]), 'zip', /creator platform/u);
    rejects(
      zipFixture([{ path: 'file', host: 0, externalAttributes: 0x10 }]),
      'zip',
      /inconsistent DOS/u,
    );
  });

  it('rejects malformed ZIP central directory structures and headers', () => {
    rejects(new Uint8Array([1]), 'zip', /truncated/u);
    rejects(Buffer.alloc(22), 'zip', /end-of-central-directory/u);
    rejects(zipFixture([], false), 'zip', /entry count/u);

    const mutations: Array<[(bytes: Buffer, central: number, end: number) => void, RegExp]> = [
      [(bytes, _central, end) => bytes.writeUInt16LE(1, end + 4), /multi-disk/u],
      [(bytes, _central, end) => bytes.writeUInt16LE(1, end + 6), /multi-disk/u],
      [(bytes, _central, end) => bytes.writeUInt16LE(0, end + 8), /multi-disk/u],
      [(bytes, _central, end) => bytes.writeUInt16LE(2, end + 10), /multi-disk/u],
      [(bytes, _central, end) => bytes.writeUInt32LE(1, end + 12), /bounds/u],
      [(bytes, central) => bytes.writeUInt32LE(0, central), /central directory entry/u],
      [(bytes, central) => bytes.writeUInt32LE(0xffffffff, central + 20), /ZIP64 entries/u],
      [(bytes, central) => bytes.writeUInt32LE(0xffffffff, central + 24), /ZIP64 entries/u],
      [(bytes, central) => bytes.writeUInt32LE(0xffffffff, central + 42), /ZIP64 entries/u],
      [(bytes, central) => bytes.writeUInt16LE(1, central + 34), /multi-disk/u],
      [(bytes, central) => bytes.writeUInt16LE(1, central + 8), /flags/u],
      [(bytes, central) => bytes.writeUInt16LE(7, central + 10), /compression method/u],
      [(bytes, central) => bytes.writeUInt16LE(0, central + 28), /empty name/u],
      [(bytes, central) => bytes.writeUInt16LE(0xffff, central + 28), /truncated/u],
    ];
    for (const [mutate, pattern] of mutations) {
      rejects(mutateZip([{ path: 'file', content: 'x' }], mutate), 'zip', pattern);
    }

    rejects(
      zipFixture([{ path: 'file', rawName: Buffer.from([0xff]), flags: 0 }]),
      'zip',
      /non-ASCII/u,
    );
    rejects(
      zipFixture([{ path: 'file', rawName: Buffer.from([0xff]), flags: 0x0800 }]),
      'zip',
      /valid UTF-8/u,
    );
  });

  it('rejects ZIP64 end metadata, comments with false bounds, and uncounted central entries', () => {
    for (const offset of [8, 10]) {
      const archive = zipFixture([{ path: 'file', content: 'x' }]);
      archive.writeUInt16LE(0xffff, archive.length - 22 + offset);
      rejects(archive, 'zip', /ZIP64/u);
    }
    for (const offset of [12, 16]) {
      const archive = zipFixture([{ path: 'file', content: 'x' }]);
      archive.writeUInt32LE(0xffffffff, archive.length - 22 + offset);
      rejects(archive, 'zip', /ZIP64/u);
    }
    const falseComment = zipFixture([{ path: 'file', content: 'x' }]);
    falseComment.writeUInt16LE(1, falseComment.length - 2);
    rejects(falseComment, 'zip', /end-of-central-directory/u);

    const uncounted = zipFixture([
      { path: 'one', content: '1' },
      { path: 'two', content: '2' },
    ]);
    const uncountedEnd = uncounted.length - 22;
    uncounted.writeUInt16LE(1, uncountedEnd + 8);
    uncounted.writeUInt16LE(1, uncountedEnd + 10);
    rejects(uncounted, 'zip', /uncounted entries/u);
  });

  it('rejects inconsistent ZIP local headers, data, CRC, and descriptors', () => {
    const localMutations: Array<[number, number, RegExp]> = [
      [0, 0, /local entry has an invalid signature/u],
      [4, 10, /metadata disagree/u],
      [6, 1, /metadata disagree/u],
      [8, 0, /metadata disagree/u],
      [14, 0, /metadata disagree/u],
      [18, 0, /metadata disagree/u],
      [22, 0, /metadata disagree/u],
      [26, 2, /metadata disagree/u],
    ];
    for (const [offset, value, pattern] of localMutations) {
      const archive = zipFixture([{ path: 'file', content: 'payload' }]);
      if (offset === 0) archive.writeUInt32LE(value, offset);
      else archive.writeUInt16LE(value, offset);
      rejects(archive, 'zip', pattern);
    }

    const wrongName = zipFixture([{ path: 'file', content: 'payload' }]);
    wrongName[30] = 'g'.charCodeAt(0);
    rejects(wrongName, 'zip', /names disagree/u);

    const invalidDeflate = zipFixture([{ path: 'file', content: 'payload' }]);
    invalidDeflate[35] = 0xff;
    rejects(invalidDeflate, 'zip', /invalid or oversized|CRC mismatch/u);

    const wrongCrc = zipFixture([{ path: 'file', content: 'payload' }]);
    const central = zipCentralOffset(wrongCrc);
    wrongCrc.writeUInt32LE(0, 14);
    wrongCrc.writeUInt32LE(0, central + 16);
    rejects(wrongCrc, 'zip', /CRC mismatch/u);

    for (const descriptorOffset of [4, 8, 12]) {
      const archive = zipFixture([{ path: 'file', content: 'x', flags: 0x0808 }]);
      const centralOffset = zipCentralOffset(archive);
      const descriptor = centralOffset - 16;
      archive.writeUInt32LE(0, descriptor + descriptorOffset);
      rejects(archive, 'zip', /descriptor disagrees/u);
    }
  });

  it('rejects ZIP entry topology and declared total limits in either order', () => {
    rejects(
      zipFixture([
        { path: 'parent', content: 'one' },
        { path: 'parent/child', content: 'two' },
      ]),
      'zip',
      /nested under regular file/u,
    );
    rejects(
      zipFixture([{ path: 'directory/', content: 'x', mode: 0o040755 }]),
      'zip',
      /directory .* contains data/u,
    );
    expect(() =>
      validateRuntimeArchiveBytes({
        format: 'zip',
        bytes: zipFixture([
          { path: 'one', content: '12' },
          { path: 'two', content: '34' },
        ]),
        limits: { maximumFileBytes: 3, maximumTotalBytes: 3 },
      }),
    ).toThrow(/total limit/u);
  });

  it('rejects malformed gzip and strict ustar header encodings', () => {
    const badGzipHeaders = [
      Buffer.alloc(0),
      Buffer.alloc(18),
      Buffer.from([0x1f, 0, 8, ...Array.from({ length: 15 }, () => 0)]),
      Buffer.from([0x1f, 0x8b, 7, ...Array.from({ length: 15 }, () => 0)]),
    ];
    for (const bytes of badGzipHeaders) {
      rejects(bytes, 'tar.gz', /archive size|gzip header|gzip stream/u);
    }
    const flagged = Buffer.from(tarFixture([{ path: 'file', content: 'x' }]));
    flagged[3] = 8;
    rejects(flagged, 'tar.gz', /header flags/u);

    const invalidHeaders: Array<[(tar: Buffer) => void, RegExp, boolean?]> = [
      [(tar) => tar.fill(0, 257, 263), /strict ustar/u],
      [(tar) => (tar[100] = 0x80), /base-256/u],
      [(tar) => tar.fill('8', 100, 108), /strict octal/u],
      [(tar) => (tar[10] = 1), /non-zero bytes after/u],
      [(tar) => (tar[0] = 0xff), /valid UTF-8/u],
      [(tar) => writeTarText(tar, 'target', 157, 100), /link metadata/u],
      [(tar) => writeTarOctal(tar, 0o4755, 100, 8), /special permission/u],
      [(tar) => (tar[156] = '7'.charCodeAt(0)), /unsupported link, device/u],
      [(tar) => (tar[0] = tar[0]! ^ 1), /checksum/u, false],
    ];
    const valid = tarFixture([{ path: 'file', content: 'x' }]);
    for (const [mutate, pattern, checksum = true] of invalidHeaders) {
      rejects(mutateTar(valid, mutate, checksum), 'tar.gz', pattern);
    }
  });

  it('accepts ustar prefix and NUL file type, then rejects bounds and end markers', () => {
    const prefixed = mutateTar(tarFixture([{ path: 'name', content: 'x' }]), (tar) => {
      writeTarText(tar, 'prefix', 345, 155);
      tar[156] = 0;
    });
    expect(validateRuntimeArchiveBytes({ bytes: prefixed, format: 'tar.gz' }).fileCount).toBe(1);

    const oneZeroBlock = mutateTar(tarFixture([{ path: 'file', content: 'x' }]), (tar) => {
      tar[1536] = 1;
    });
    rejects(oneZeroBlock, 'tar.gz', /two zero blocks/u);

    const trailingTar = Buffer.concat([
      gunzipSync(tarFixture([{ path: 'file', content: 'x' }])),
      Buffer.alloc(512),
    ]);
    trailingTar[trailingTar.length - 1] = 1;
    const trailingData = gzipSync(trailingTar);
    rejects(trailingData, 'tar.gz', /data after/u);

    const noEnd = gzipSync(
      gunzipSync(tarFixture([{ path: 'file', content: 'x' }])).subarray(0, 1024),
    );
    rejects(noEnd, 'tar.gz', /no end marker/u);

    const badPadding = mutateTar(tarFixture([{ path: 'file', content: 'x' }]), (tar) => {
      tar[513] = 1;
    });
    rejects(badPadding, 'tar.gz', /padding/u);

    rejects(gzipSync(Buffer.alloc(100)), 'tar.gz', /not block-aligned/u);
    rejects(gzipSync(Buffer.alloc(1024)), 'tar.gz', /no entries/u);
  });

  it('enforces archive, inventory, and decompression bounds fail-closed', () => {
    const archive = tarFixture([
      { path: 'one', content: '12' },
      { path: 'two', content: '34' },
    ]);
    expect(() =>
      validateRuntimeArchiveBytes({
        bytes: archive,
        format: 'tar.gz',
        limits: { maximumArchiveBytes: 1 },
      }),
    ).toThrow(/archive size/u);
    expect(() =>
      validateRuntimeArchiveBytes({
        bytes: archive,
        format: 'tar.gz',
        limits: { maximumEntries: 0 },
      }),
    ).toThrow(/positive safe integer/u);
    expect(() =>
      validateRuntimeArchiveBytes({
        bytes: archive,
        format: 'tar.gz',
        limits: { maximumEntries: Number.MAX_SAFE_INTEGER },
      }),
    ).toThrow(/safe integer range/u);
    expect(() =>
      validateRuntimeArchiveBytes({
        bytes: archive,
        format: 'tar.gz',
        limits: { maximumEntries: 1, maximumFileBytes: 4, maximumTotalBytes: 4 },
      }),
    ).toThrow(/gzip stream|entry count/u);
    expect(() =>
      validateRuntimeArchiveBytes({
        bytes: archive,
        format: 'tar.gz',
        limits: { maximumFileBytes: 3, maximumTotalBytes: 3 },
      }),
    ).toThrow(/total limit/u);
    expect(() => validateRuntimeArchiveBytes({ bytes: archive, format: 'rar' as 'zip' })).toThrow(
      /unsupported format/u,
    );
  });

  it('rejects empty and oversized regular archive files before reading', () => {
    const root = temporaryDirectory();
    const empty = join(root, 'empty.zip');
    writeFileSync(empty, '');
    expect(() => validateRuntimeArchiveFile({ path: empty, format: 'zip' })).toThrow(
      /archive size/u,
    );
    const archive = join(root, 'archive.zip');
    writeFileSync(archive, zipFixture([{ path: 'file', content: 'x' }]));
    expect(() =>
      validateRuntimeArchiveFile({
        path: archive,
        format: 'zip',
        limits: { maximumArchiveBytes: 1 },
      }),
    ).toThrow(/archive size/u);
  });

  it('covers the remaining archive boundary sentinels', () => {
    rejects(
      tarFixture([{ path: 'directory/', type: '5', declaredBytes: 1, content: 'x' }]),
      'tar.gz',
      /directory .* contains data/u,
    );

    const zip64Signature = zipFixture([{ path: 'file', content: 'x' }]);
    zip64Signature.writeUInt32LE(0x06064b50, zipCentralOffset(zip64Signature));
    rejects(zip64Signature, 'zip', /ZIP64/u);

    rejects(
      mutateZip([{ path: 'file', content: 'x' }], (bytes, central) => {
        bytes.writeUInt32LE(1, central + 42);
      }),
      'zip',
      /overlap|unaccounted/u,
    );

    const compact = zipFixture([{ path: 'file', content: 'x' }]);
    const compactCentral = zipCentralOffset(compact);
    const withGap = Buffer.concat([
      compact.subarray(0, compactCentral),
      Buffer.from([0]),
      compact.subarray(compactCentral),
    ]);
    const movedEnd = compact.length - 22 + 1;
    withGap.writeUInt32LE(compactCentral + 1, movedEnd + 16);
    rejects(withGap, 'zip', /local data does not end/u);

    const emptyMode = mutateTar(tarFixture([{ path: 'file', content: 'x' }]), (tar) => {
      tar.fill(0, 100, 108);
    });
    expect(validateRuntimeArchiveBytes({ bytes: emptyMode, format: 'tar.gz' }).fileCount).toBe(1);

    expect(
      validateRuntimeArchiveBytes({
        bytes: tarFixture([{ path: 'x'.repeat(100), content: 'x' }]),
        format: 'tar.gz',
      }).fileCount,
    ).toBe(1);

    const validGzip = tarFixture([{ path: 'file', content: 'x' }]);
    rejects(Buffer.concat([validGzip, gzipSync(Buffer.alloc(0))]), 'tar.gz', /concatenated/u);
  });
});
