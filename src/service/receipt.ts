import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { writePrivateFileAtomic } from '../fsAtomic.js';
import { assertNoSymlinkTraversal } from '../fsGuards.js';
import type {
  InstallReceipt,
  InstallReceiptFileSnapshot,
  ReceiptArtifact,
  ServiceArtifact,
} from './types.js';

export const INSTALL_RECEIPT_NAME = 'install-receipt.json';

/**
 * The receipt exists but cannot be trusted: torn bytes, a foreign schema, or a special file. The
 * message names the file and the repair so `install`, `status` and `uninstall` stop with a typed
 * `invalid_state` instead of a bare internal error. Snapshot and restore keep their own messages.
 */
export class InstallReceiptError extends AppError {
  constructor(
    public readonly path: string,
    reason: string,
    cause?: unknown,
  ) {
    super(
      'invalid_state',
      `Pimpampum cannot read the installation receipt at ${path}: ${reason}. Move the file away and run \`pimpampum install\` again, or restore it from a backup of the data directory.`,
      409,
      false,
      { receiptPath: path, reason },
    );
    this.name = 'InstallReceiptError';
    if (cause !== undefined) this.cause = cause;
  }
}

export function installReceiptPath(dataDirectory: string): string {
  return join(dataDirectory, INSTALL_RECEIPT_NAME);
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function receiptArtifacts(artifacts: ServiceArtifact[]): ReceiptArtifact[] {
  return artifacts.map((artifact) => ({
    path: artifact.path,
    sha256: sha256(artifact.content),
    mode: artifact.mode,
  }));
}

export function installationKey(input: {
  adapter: string;
  platform: string;
  version: string;
  nodePath: string;
  cliPath: string;
  dataDirectory: string;
  artifacts: ReceiptArtifact[];
}): string {
  return sha256(JSON.stringify(input));
}

const installReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapter: z.string().min(1),
    platform: z.enum(['darwin', 'linux']),
    version: z.string().min(1),
    installationKey: z.string().regex(/^[a-f0-9]{64}$/),
    installedAt: z.iso.datetime(),
    nodePath: z.string().min(1),
    cliPath: z.string().min(1),
    dataDirectory: z.string().min(1),
    baseUrl: z.url(),
    logDirectory: z.string().min(1),
    updateProvider: z.enum(['legacy-npm', 'packaged-release']).optional(),
    packagedRuntime: z
      .object({
        version: z.string().min(1),
        target: z.enum(['darwin-arm64', 'linux-arm64', 'linux-x64']),
        runtimeDirectory: z.string().min(1),
      })
      .strict()
      .optional(),
    artifacts: z.array(
      z
        .object({
          path: z.string().min(1),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          mode: z.number().int().min(0).max(0o777),
        })
        .strict(),
    ),
  })
  .strict();

function parseReceipt(value: unknown): InstallReceipt {
  const result = installReceiptSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid Pimpampum installation receipt');
  const { updateProvider, packagedRuntime, ...receipt } = result.data;
  return {
    ...receipt,
    ...(updateProvider === undefined ? {} : { updateProvider }),
    ...(packagedRuntime === undefined ? {} : { packagedRuntime }),
  };
}

export function readInstallReceipt(
  path: string,
  trustedRoot = dirname(path),
): InstallReceipt | null {
  if (!existsSync(path)) return null;
  assertNoSymlinkTraversal(path, 'Installation receipt path', trustedRoot);
  if (!lstatSync(path).isFile()) {
    throw new InstallReceiptError(path, 'it is not a regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new InstallReceiptError(path, 'it is not valid JSON', error);
  }
  try {
    return parseReceipt(parsed);
  } catch (error) {
    throw new InstallReceiptError(path, 'its contents do not match the receipt schema', error);
  }
}

/**
 * Durable private write through the shared primitive: the receipt that vouches for a service is
 * fsynced before and after the rename so it does not evaporate with the page cache. The data
 * directory is created private when it is missing, as the receipt is often its first file.
 */
function writeReceiptBytes(path: string, contents: string | Buffer, trustedRoot: string): void {
  writePrivateFileAtomic(path, contents, {
    mode: 0o600,
    directoryMode: 0o700,
    trustedRoot,
    label: 'Installation receipt',
  });
}

export function writeInstallReceipt(
  path: string,
  receipt: InstallReceipt,
  trustedRoot = dirname(path),
): void {
  writeReceiptBytes(path, `${JSON.stringify(receipt, null, 2)}\n`, trustedRoot);
}

export function snapshotInstallReceipt(
  path: string,
  trustedRoot = dirname(path),
): InstallReceiptFileSnapshot | null {
  const receipt = readInstallReceipt(path, trustedRoot);
  if (receipt === null) return null;
  const contents = readFileSync(path);
  if (contents.byteLength > 700_000) {
    throw new Error('Installation receipt exceeds the migration snapshot size limit');
  }
  let capturedReceipt: InstallReceipt;
  try {
    capturedReceipt = parseReceipt(JSON.parse(contents.toString('utf8')) as unknown);
  } catch (error) {
    throw new Error('Installation receipt changed while it was being captured', { cause: error });
  }
  if (JSON.stringify(capturedReceipt) !== JSON.stringify(receipt)) {
    throw new Error('Installation receipt changed while it was being captured');
  }
  return { receipt: capturedReceipt, contents };
}

export function restoreInstallReceiptSnapshot(
  path: string,
  snapshot: InstallReceiptFileSnapshot,
  trustedRoot = dirname(path),
): void {
  let restored: InstallReceipt;
  try {
    restored = parseReceipt(JSON.parse(snapshot.contents.toString('utf8')) as unknown);
  } catch (error) {
    throw new Error('Invalid installation receipt byte snapshot', { cause: error });
  }
  if (JSON.stringify(restored) !== JSON.stringify(snapshot.receipt)) {
    throw new Error('Installation receipt byte snapshot does not match its metadata');
  }
  writeReceiptBytes(path, snapshot.contents, trustedRoot);
}
