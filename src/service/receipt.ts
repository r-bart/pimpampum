import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import type { InstallReceipt, ReceiptArtifact, ServiceArtifact } from './types.js';

export const INSTALL_RECEIPT_NAME = 'install-receipt.json';

export function assertNoSymlinkTraversal(path: string, label: string, trustedRoot = path): void {
  if (!isAbsolute(path) || path.includes('\0') || !isAbsolute(trustedRoot)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(trustedRoot);
  const child = relative(normalizedRoot, normalizedPath);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`${label} must remain inside its trusted root`);
  }
  let current = normalizedRoot;
  const segments = child.split(sep).filter(Boolean);
  for (const segment of ['', ...segments]) {
    if (segment) current = join(current, segment);
    if (!existsSync(current)) return;
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not traverse symbolic links`);
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
  return result.data;
}

export function readInstallReceipt(
  path: string,
  trustedRoot = dirname(path),
): InstallReceipt | null {
  if (!existsSync(path)) return null;
  assertNoSymlinkTraversal(path, 'Installation receipt path', trustedRoot);
  if (!lstatSync(path).isFile()) throw new Error('Installation receipt must be a regular file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error('Invalid Pimpampum installation receipt JSON', { cause: error });
  }
  return parseReceipt(parsed);
}

export function writePrivateFileAtomic(
  path: string,
  content: string | Buffer,
  mode: number,
  trustedRoot = dirname(path),
): void {
  assertNoSymlinkTraversal(dirname(path), 'Private file parent path', trustedRoot);
  mkdirSync(dirname(path), { recursive: true });
  assertNoSymlinkTraversal(dirname(path), 'Private file parent path', trustedRoot);
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Private file target is not a regular file: ${path}`);
    }
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { mode, flag: 'wx' });
    assertNoSymlinkTraversal(dirname(path), 'Private file parent path', trustedRoot);
    renameSync(temporaryPath, path);
    chmodSync(path, mode);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function writeInstallReceipt(
  path: string,
  receipt: InstallReceipt,
  trustedRoot = dirname(path),
): void {
  writePrivateFileAtomic(path, `${JSON.stringify(receipt, null, 2)}\n`, 0o600, trustedRoot);
}
