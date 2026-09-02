import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeToolInput,
  describe as describeCommand,
  inputTooLarge,
  readBoundedStdin,
  readBoundedUtf8File,
} from '../src/cliInput.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryFile(name: string, content: Buffer | string): string {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-cli-input-'));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, content);
  return path;
}

describe('bounded CLI readers', () => {
  it('reads a UTF-8 file up to the bound and refuses one byte more', () => {
    const exact = temporaryFile('exact.json', 'é'.repeat(4));
    expect(readBoundedUtf8File(exact, 8)).toBe('é'.repeat(4));
    expect(() => readBoundedUtf8File(exact, 7)).toThrowError(
      expect.objectContaining({
        code: 'payload_too_large',
        status: 413,
        message: 'Tool input exceeds 7 UTF-8 bytes',
      }),
    );
    expect(() => readBoundedUtf8File(exact, 7, 'File')).toThrowError(/^File exceeds 7/u);
  });

  it('reads a file larger than one chunk without loading past the bound', () => {
    const content = 'a'.repeat(70_000);
    const path = temporaryFile('large.txt', content);
    expect(readBoundedUtf8File(path, 70_000)).toBe(content);
    expect(() => readBoundedUtf8File(path, 69_999)).toThrowError(/exceeds 69999/u);
  });

  it('rejects a file that is not valid UTF-8 with the caller-facing label', () => {
    const path = temporaryFile('binary.bin', Buffer.from([0xff, 0xfe, 0x00]));
    expect(() => readBoundedUtf8File(path, 16)).toThrowError(
      expect.objectContaining({ code: 'bad_request', message: 'Tool input must be valid UTF-8' }),
    );
    expect(() => readBoundedUtf8File(path, 16, 'File')).toThrowError(/^File must be valid UTF-8/u);
  });

  it('drains stdin chunk by chunk with the same bound and decoding', async () => {
    await expect(readBoundedStdin(Readable.from([Buffer.from('{"a":'), '1}']), 7)).resolves.toBe(
      '{"a":1}',
    );
    await expect(readBoundedStdin(Readable.from([Buffer.from('{"a":'), '1}']), 6)).rejects.toThrow(
      /exceeds 6 UTF-8 bytes/u,
    );
    await expect(
      readBoundedStdin(Readable.from([Buffer.from([0xc3]), Buffer.from([0x28])]), 8),
    ).rejects.toThrow(/must be valid UTF-8/u);
  });

  it('decodes strictly and names the bound in the size error', () => {
    expect(decodeToolInput(Buffer.from('ok'))).toBe('ok');
    expect(() => decodeToolInput(Buffer.from([0xc3]), 'Body')).toThrow(
      /^Body must be valid UTF-8/u,
    );
    expect(inputTooLarge(3)).toMatchObject({
      code: 'payload_too_large',
      message: 'Tool input exceeds 3 UTF-8 bytes',
    });
    expect(inputTooLarge(3, 'Body').message).toBe('Body exceeds 3 UTF-8 bytes');
  });
});

describe('catalog lookup', () => {
  it('describes a declared command and fails typed for an undeclared one', () => {
    expect(describeCommand('help').name).toBe('help');
    expect(() => describeCommand('nonexistent')).toThrowError(
      expect.objectContaining({ code: 'internal_error', status: 500 }),
    );
  });
});
