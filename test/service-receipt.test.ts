import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InstallReceiptError,
  assertNoSymlinkTraversal,
  installReceiptPath,
  installationKey,
  readInstallReceipt,
  receiptArtifacts,
  sha256,
  writeInstallReceipt,
  writePrivateFileAtomic,
} from '../src/service/receipt.js';
import type { InstallReceipt, ServiceArtifact } from '../src/service/types.js';
import { serviceTestRoot as testRoot } from './helpers/serviceManager.js';

describe('installation receipts', () => {
  it('validates trusted path roots and rejects non-file atomic targets', () => {
    const root = testRoot('receipt-path-safety');
    expect(() => assertNoSymlinkTraversal('relative', 'Test path')).toThrow(/absolute path/);
    expect(() => assertNoSymlinkTraversal('/absolute', 'Test path', 'relative')).toThrow(
      /absolute path/,
    );
    expect(() => assertNoSymlinkTraversal('/absolute\0unsafe', 'Test path')).toThrow(
      /absolute path/,
    );
    expect(() =>
      assertNoSymlinkTraversal(root.root, 'Test path', join(root.root, 'nested')),
    ).toThrow(/trusted root/);
    expect(() =>
      assertNoSymlinkTraversal(join(root.root, 'sibling'), 'Test path', root.homeDirectory),
    ).toThrow(/trusted root/);

    const receiptDirectory = installReceiptPath(root.dataDirectory);
    mkdirSync(receiptDirectory);
    expect(() => readInstallReceipt(receiptDirectory, root.dataDirectory)).toThrow(/regular file/);
    expect(() =>
      writePrivateFileAtomic(receiptDirectory, 'bytes', 0o600, root.dataDirectory),
    ).toThrow(/regular file/);
  });

  it('hashes deterministic plans and round-trips a private atomic receipt', () => {
    const root = testRoot('receipt');
    const artifacts: ServiceArtifact[] = [
      { path: join(root.homeDirectory, 'service'), content: 'service-content', mode: 0o640 },
    ];
    const owned = receiptArtifacts(artifacts);
    expect(owned).toEqual([
      {
        path: artifacts[0]!.path,
        sha256: sha256('service-content'),
        mode: 0o640,
      },
    ]);
    const keyInput = {
      adapter: 'test',
      platform: 'linux',
      version: '1.0.0',
      nodePath: '/node',
      cliPath: '/cli',
      dataDirectory: root.dataDirectory,
      artifacts: owned,
    };
    expect(installationKey(keyInput)).toBe(installationKey(keyInput));
    const receipt: InstallReceipt = {
      schemaVersion: 1,
      adapter: 'test',
      platform: 'linux',
      version: '1.0.0',
      installationKey: installationKey(keyInput),
      installedAt: '2026-08-26T00:00:00.000Z',
      nodePath: '/node',
      cliPath: '/cli',
      dataDirectory: root.dataDirectory,
      baseUrl: 'http://127.0.0.1:7337',
      logDirectory: join(root.dataDirectory, 'logs'),
      artifacts: owned,
    };
    const path = installReceiptPath(root.dataDirectory);
    expect(readInstallReceipt(path)).toBeNull();
    writeInstallReceipt(path, receipt);
    expect(readInstallReceipt(path)).toEqual(receipt);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const bufferPath = join(root.homeDirectory, 'buffer-file');
    writePrivateFileAtomic(bufferPath, Buffer.from('buffer-content'), 0o620);
    expect(readFileSync(bufferPath, 'utf8')).toBe('buffer-content');
    expect(statSync(bufferPath).mode & 0o777).toBe(0o620);
  });

  it('rejects invalid JSON, invalid schemas, and special files with a typed repair message', () => {
    const root = testRoot('invalid-receipt');
    const path = installReceiptPath(root.dataDirectory);
    writeFileSync(path, '{invalid-json');
    const invalidJson = (() => {
      try {
        readInstallReceipt(path);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(invalidJson).toBeInstanceOf(InstallReceiptError);
    expect(invalidJson).toMatchObject({
      code: 'invalid_state',
      status: 409,
      retryable: false,
      path,
      details: { receiptPath: path, reason: 'it is not valid JSON' },
    });
    expect((invalidJson as Error).message).toContain(path);
    expect((invalidJson as Error).message).toMatch(
      /Move the file away and run `pimpampum install`/u,
    );
    expect((invalidJson as Error).cause).toBeInstanceOf(SyntaxError);

    writeFileSync(path, JSON.stringify({ schemaVersion: 999 }));
    expect(() => readInstallReceipt(path)).toThrow(
      /installation receipt at .*: its contents do not match the receipt schema/u,
    );

    rmSync(path);
    mkdirSync(path);
    expect(() => readInstallReceipt(path)).toThrow(
      /installation receipt at .*: it is not a regular file/u,
    );
  });
});
