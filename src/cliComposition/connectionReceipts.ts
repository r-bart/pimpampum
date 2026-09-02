/**
 * The private receipt the CLI keeps for each agent connection it made, beside the daemon's data.
 * The receipt is what lets `disconnect` and the packaged removal prove an entry is Pimpampum's
 * before touching it; a host entry alone never is.
 */
import { lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  configurationRevision,
  readHostConfiguration,
  replaceHostConfigurationEntry,
} from '../connectors/process.js';
import type { ConnectionReceipt, ConnectorId } from '../connectors/types.js';
import { isRecord } from '../objects.js';

export interface ConnectionReceiptStore {
  read(): Promise<ConnectionReceipt | null>;
  write(receipt: ConnectionReceipt): Promise<void>;
  remove(): Promise<void>;
}

function parseConnectionReceipt(value: unknown, connectorId: ConnectorId): ConnectionReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.connectorId !== connectorId ||
    (value.scope !== 'user' && value.scope !== 'global') ||
    typeof value.commandFingerprint !== 'string' ||
    value.commandFingerprint.length === 0 ||
    value.commandFingerprint.length > 128 ||
    value.commandFingerprint.includes('\0') ||
    typeof value.configuredAt !== 'string' ||
    value.configuredAt.length === 0 ||
    value.configuredAt.length > 128 ||
    (value.lastVerifiedAt !== null && typeof value.lastVerifiedAt !== 'string')
  ) {
    throw new Error('Invalid private connector receipt');
  }
  const capabilities = value.capabilities;
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) ||
      capabilities.length > 32 ||
      capabilities.some(
        (capability) =>
          typeof capability !== 'string' ||
          capability.length === 0 ||
          capability.length > 128 ||
          capability.includes('\0'),
      ))
  ) {
    throw new Error('Invalid private connector receipt capabilities');
  }
  return {
    schemaVersion: 1,
    connectorId,
    scope: value.scope,
    commandFingerprint: value.commandFingerprint,
    configuredAt: value.configuredAt,
    lastVerifiedAt: value.lastVerifiedAt,
    ...(Array.isArray(capabilities) ? { capabilities: [...capabilities] as string[] } : {}),
  };
}

/** `true` when the receipt directory exists as a real directory, `false` when it is absent. */
function assertSafeReceiptDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(dirname(path));
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Private connector receipt directory must not be a symlink');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function createConnectionReceiptStore(
  dataDirectory: string,
  connectorId: ConnectorId,
): ConnectionReceiptStore {
  const path = join(dataDirectory, 'connections', `${connectorId}.json`);
  return {
    async read() {
      if (!assertSafeReceiptDirectory(path)) return null;
      try {
        return parseConnectionReceipt(readHostConfiguration(path).value, connectorId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(receipt) {
      assertSafeReceiptDirectory(path);
      let expectedRevision: string | null = null;
      try {
        expectedRevision = configurationRevision(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await replaceHostConfigurationEntry({
        path,
        expectedRevision,
        mode: 0o600,
        update: () => parseConnectionReceipt(receipt, connectorId),
      });
    },
    async remove() {
      if (!assertSafeReceiptDirectory(path)) return;
      let metadata: ReturnType<typeof lstatSync>;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Private connector receipt must be a regular file and not a symlink');
      }
      unlinkSync(path);
    },
  };
}
