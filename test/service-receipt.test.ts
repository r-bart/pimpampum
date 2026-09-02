import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InstallReceiptError,
  installReceiptPath,
  installationKey,
  readInstallReceipt,
  receiptArtifacts,
  sha256,
  writeInstallReceipt,
} from '../src/service/receipt.js';
import type { InstallReceipt, ServiceArtifact } from '../src/service/types.js';
import { serviceTestRoot as testRoot } from './helpers/serviceManager.js';

describe('installation receipts', () => {
  it('rejects a receipt path that is a directory, on read and on write', () => {
    const root = testRoot('receipt-path-safety');
    const receiptDirectory = installReceiptPath(root.dataDirectory);
    mkdirSync(receiptDirectory);
    expect(() => readInstallReceipt(receiptDirectory, root.dataDirectory)).toThrow(/regular file/);
    expect(() => writeInstallReceipt(receiptDirectory, {} as never, root.dataDirectory)).toThrow(
      /Installation receipt must be a regular file/,
    );
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
