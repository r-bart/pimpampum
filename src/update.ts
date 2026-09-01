import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { AppError } from './errors.js';
import { findExecutable } from './service/platform.js';
import { assertNoSymlinkTraversal, writePrivateFileAtomic } from './service/receipt.js';
import type { RunCommand } from './service/types.js';

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

export interface UpdateResult extends UpdateStatus {
  updated: boolean;
  installedVersion: string;
  serviceReconciled: boolean;
}

export interface UpdateManager {
  check(): Promise<UpdateStatus>;
  update(): Promise<UpdateResult>;
}

export type PackagedReleaseTarget = 'darwin-arm64' | 'linux-arm64' | 'linux-x64';

export const PACKAGED_RELEASE_TARGETS: readonly PackagedReleaseTarget[] = [
  'darwin-arm64',
  'linux-arm64',
  'linux-x64',
];

/**
 * The Ed25519 public half of the release signing key. The private half lives only in the
 * `RELEASE_MANIFEST_SIGNING_KEY` repository secret; `scripts/sign-release-manifest.mjs` signs
 * every target of `release-manifest.json` with it and verifies the result against this constant.
 * The key is embedded, not read from disk, so no user-writable path can replace the trust root.
 * `scripts/sign-release-manifest.mjs` extracts it from this file between the PEM markers.
 */
export const RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmtqLSdctyUmsFJGCDTSRtO49f79jn5dQAxKK77sWvJA=
-----END PUBLIC KEY-----
`;

export interface UpdateInstallReceiptMetadata {
  schemaVersion: 1;
  adapter: string;
  updateProvider?: 'legacy-npm' | 'packaged-release';
  packagedRuntime?: {
    version: string;
    target: PackagedReleaseTarget;
    runtimeDirectory: string;
  };
}

export interface PackagedReleaseAsset {
  url: string;
  sha256: string;
  signature: string;
  size: number;
}

export interface PackagedReleaseManifest {
  schemaVersion: 1;
  channel: 'stable';
  version: string;
  /** ISO 8601 UTC instant at which the signer issued this manifest; part of every signature. */
  issuedAt: string;
  targets: Record<PackagedReleaseTarget, PackagedReleaseAsset | undefined>;
}

export interface ResolvedPackagedRelease {
  manifest: PackagedReleaseManifest;
  asset: PackagedReleaseAsset;
}

export interface StagedPackagedRelease {
  path: string;
  sha256: string;
  size: number;
  contains: { app: boolean; runtime: boolean; plugin: boolean };
}

export interface PackagedReleaseProviderInput {
  channelManifestUrl: string;
  target: PackagedReleaseTarget;
  /**
   * Development only: accept `http://` channel and asset URLs on a loopback host. The CLI sets it
   * from `PIMPAMPUM_DEV_RELEASE_KEY=1`, the same flag that lets a test key replace the embedded one.
   */
  allowInsecureLoopback?: boolean;
  fetchManifest(input: {
    url: string;
    maximumBytes: number;
    timeoutMilliseconds: number;
  }): Promise<string | Uint8Array>;
  verifySignature(input: {
    payload: string;
    signature: string;
    target: PackagedReleaseTarget;
  }): boolean | Promise<boolean>;
  stageCandidate(input: {
    version: string;
    target: PackagedReleaseTarget;
    asset: Readonly<PackagedReleaseAsset>;
    maximumBytes: number;
    timeoutMilliseconds: number;
  }): Promise<StagedPackagedRelease>;
  /** Owns the lifecycle lock, atomic activation, health verification, and rollback transaction. */
  reconcile(input: {
    version: string;
    target: PackagedReleaseTarget;
    candidatePath: string;
    sha256: string;
    signature: string;
  }): Promise<void>;
}

export interface UpdateManagerInput {
  currentVersion: string;
  npmPath: string | null;
  nodePath: string;
  runCommand: RunCommand;
  pathExists?: (path: string) => boolean;
  installReceipt?: UpdateInstallReceiptMetadata;
  packagedRelease?: PackagedReleaseProviderInput;
  /**
   * Where the packaged provider remembers the newest `issuedAt` it accepted. Without it the
   * replay check lives only in this process, so every packaged installation should pass it.
   */
  dataDirectory?: string;
}

/** Remembers the newest manifest `issuedAt` this installation accepted; older ones are replays. */
export interface ReleaseTrustStore {
  lastAcceptedIssuedAt(): string | null;
  recordAcceptedIssuedAt(issuedAt: string): void;
}

export const RELEASE_TRUST_STATE_NAME = 'update-trust.json';
const MAX_RELEASE_TRUST_STATE_BYTES = 4_096;

const releaseTrustStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    lastAcceptedIssuedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  })
  .strict();

function unreadableTrustState(path: string, cause?: unknown): AppError {
  const error = new AppError(
    'unavailable',
    `Update trust state at ${path} is unreadable; delete the file to reset replay protection and retry`,
    503,
    false,
    { path },
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * A small private file in the 0700 data directory. Reads fail closed: a file that exists but does
 * not parse blocks updates until the operator removes it, because silently treating it as absent
 * would reopen the replay window it exists to close.
 */
export function createReleaseTrustStore(dataDirectory: string): ReleaseTrustStore {
  if (!isAbsolute(dataDirectory) || dataDirectory.includes('\0')) {
    throw new AppError('unavailable', 'Update trust state directory must be absolute', 503);
  }
  const path = join(dataDirectory, RELEASE_TRUST_STATE_NAME);
  return {
    lastAcceptedIssuedAt() {
      if (!existsSync(path)) return null;
      assertNoSymlinkTraversal(path, 'Update trust state path', dataDirectory);
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.size > MAX_RELEASE_TRUST_STATE_BYTES) {
        throw unreadableTrustState(path);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      } catch (error) {
        throw unreadableTrustState(path, error);
      }
      const result = releaseTrustStateSchema.safeParse(parsed);
      if (!result.success || !validIssuedAt(result.data.lastAcceptedIssuedAt)) {
        throw unreadableTrustState(path);
      }
      return result.data.lastAcceptedIssuedAt;
    },
    recordAcceptedIssuedAt(issuedAt) {
      writePrivateFileAtomic(
        path,
        `${JSON.stringify({ schemaVersion: 1, lastAcceptedIssuedAt: issuedAt }, null, 2)}\n`,
        0o600,
        dataDirectory,
      );
    },
  };
}

function createVolatileReleaseTrustStore(): ReleaseTrustStore {
  let lastAccepted: string | null = null;
  return {
    lastAcceptedIssuedAt: () => lastAccepted,
    recordAcceptedIssuedAt(issuedAt) {
      lastAccepted = issuedAt;
    },
  };
}

/**
 * Rejects a manifest older than the newest one this installation accepted, then records the
 * accepted instant. Equal timestamps are the same publication and pass; a signer that reissues
 * the channel always moves `issuedAt` forward.
 */
function assertFreshManifest(manifest: PackagedReleaseManifest, trust: ReleaseTrustStore): void {
  const lastAccepted = trust.lastAcceptedIssuedAt();
  if (lastAccepted !== null && Date.parse(manifest.issuedAt) < Date.parse(lastAccepted)) {
    throw new AppError(
      'unavailable',
      `Packaged release manifest issued at ${manifest.issuedAt} is older than the last accepted manifest issued at ${lastAccepted}; a replayed channel manifest is rejected`,
      503,
      false,
      { issuedAt: manifest.issuedAt, lastAcceptedIssuedAt: lastAccepted },
    );
  }
  if (lastAccepted !== manifest.issuedAt) trust.recordAcceptedIssuedAt(manifest.issuedAt);
}

export const MAX_RELEASE_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGED_RELEASE_BYTES = 512 * 1024 * 1024;
export const RELEASE_FETCH_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopbackHttp(parsed: URL): boolean {
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

export function resolveNpmPath(
  nodePath: string,
  pathValue = process.env.PATH,
  pathExists: (path: string) => boolean = (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string | null {
  const siblingNpmPath = join(dirname(nodePath), 'npm');
  const npmPath = pathExists(siblingNpmPath) ? siblingNpmPath : findExecutable('npm', pathValue);
  return npmPath ? realpathSync(npmPath) : null;
}

// npm output reaches these messages, and the messages reach a desktop panel. `runServiceCommand`
// accepts up to 1 MB of each stream, so quote a bounded prefix instead of the whole response.
const MAX_REPORTED_VERSION_LENGTH = 40;
const MAX_REPORTED_REASON_LENGTH = 160;

function quoted(value: string, limit = MAX_REPORTED_VERSION_LENGTH): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

// npm reports the actual cause on stderr and only its exit code to us. Without this, a registry
// policy, a permission error, and an offline machine are one indistinguishable "failed".
function npmReason(stderr: string): string {
  const reason = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('npm error '))
    .map((line) => line.slice('npm error '.length).trim())
    .filter((line) => !line.startsWith('A complete log'))
    // npm opens with a bare `code ETARGET` line; the sentence after it names the real cause.
    .find((line) => line.split(/\s+/u).length > 3);
  return reason ? `: ${quoted(reason, MAX_REPORTED_REASON_LENGTH)}` : '';
}

function versionParts(version: string): { core: number[]; prerelease: string[] } {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new AppError(
      'unavailable',
      `npm returned an invalid Pimpampum version: ${quoted(version)}`,
      503,
    );
  }
  // Split at the first hyphen only: `1.0.0-rc-2` has the prerelease `rc-2`, and `split('-', 2)`
  // would silently drop everything after the second hyphen.
  const hyphen = version.indexOf('-');
  const core = hyphen === -1 ? version : version.slice(0, hyphen);
  const prerelease = hyphen === -1 ? '' : version.slice(hyphen + 1);
  return {
    core: core.split('.').map(Number),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

function validVersion(version: unknown): version is string {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version);
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const left = versionParts(candidate);
  const right = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! > right.core[index]!;
  }
  if (left.prerelease.length === 0) return right.prerelease.length > 0;
  if (right.prerelease.length === 0) return false;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const candidatePart = left.prerelease[index];
    const currentPart = right.prerelease[index];
    if (candidatePart === undefined) return false;
    if (currentPart === undefined) return true;
    if (candidatePart === currentPart) continue;
    const candidateNumber = /^\d+$/u.test(candidatePart) ? Number(candidatePart) : null;
    const currentNumber = /^\d+$/u.test(currentPart) ? Number(currentPart) : null;
    if (candidateNumber !== null && currentNumber !== null) return candidateNumber > currentNumber;
    if (candidateNumber !== null) return false;
    if (currentNumber !== null) return true;
    return candidatePart > currentPart;
  }
  return false;
}

export function createLegacyNpmUpdateManager(input: UpdateManagerInput): UpdateManager {
  async function npm(arguments_: string[], operation: string): Promise<string> {
    if (!input.npmPath) {
      throw new AppError(
        'unavailable',
        'npm is required to update Pimpampum; install Node.js with npm and retry',
        503,
        false,
      );
    }
    const result = await input.runCommand(input.nodePath, [input.npmPath, ...arguments_]);
    if (result.exitCode !== 0) {
      throw new AppError(
        'unavailable',
        `${operation} failed${npmReason(result.stderr)}`,
        503,
        true,
      );
    }
    return result.stdout.trim();
  }

  async function check(): Promise<UpdateStatus> {
    const latestVersion = await npm(['view', 'pimpampum', 'version', '--json'], 'Update check');
    let parsed: unknown;
    try {
      parsed = JSON.parse(latestVersion);
    } catch {
      parsed = latestVersion.replace(/^"|"$/gu, '');
    }
    if (typeof parsed !== 'string') {
      throw new AppError('unavailable', 'npm returned an invalid update response', 503);
    }
    return {
      currentVersion: input.currentVersion,
      latestVersion: parsed,
      updateAvailable: isNewerVersion(parsed, input.currentVersion),
    };
  }

  return {
    check,
    async update() {
      const status = await check();
      if (status.updateAvailable) {
        await npm(['install', '--global', `pimpampum@${status.latestVersion}`], 'Pimpampum update');
      }
      const globalRoot = await npm(['root', '--global'], 'Global npm path lookup');
      const cliPath = join(globalRoot, 'pimpampum', 'dist', 'cli.js');
      if (!isAbsolute(globalRoot) || !(input.pathExists ?? existsSync)(cliPath)) {
        throw new AppError('unavailable', 'The updated Pimpampum CLI was not found', 503);
      }
      const installed = await input.runCommand(input.nodePath, [cliPath, 'install']);
      if (installed.exitCode !== 0) {
        throw new AppError(
          'unavailable',
          'Pimpampum updated but service reconciliation failed',
          503,
          true,
        );
      }
      return {
        currentVersion: status.latestVersion,
        latestVersion: status.latestVersion,
        updateAvailable: false,
        updated: status.updateAvailable,
        installedVersion: status.latestVersion,
        serviceReconciled: true,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

// The macOS app ships as `Pimpampum-<version>-macos-arm64.zip`; the runtime target it carries is
// `darwin-arm64`. Both tokens name the same target in an asset path.
const TARGET_PATH_TOKENS: Record<PackagedReleaseTarget, readonly string[]> = {
  'darwin-arm64': ['darwin-arm64', 'macos-arm64'],
  'linux-arm64': ['linux-arm64'],
  'linux-x64': ['linux-x64'],
};

function releaseUrl(
  value: unknown,
  version: string,
  target: PackagedReleaseTarget,
  allowInsecureLoopback: boolean,
): string {
  if (typeof value !== 'string' || value.length > 2_048 || value.includes('\0')) {
    throw new AppError('unavailable', 'Packaged release manifest has an invalid asset URL', 503);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('unavailable', 'Packaged release manifest has an invalid asset URL', 503);
  }
  if (
    (parsed.protocol !== 'https:' && !(allowInsecureLoopback && isLoopbackHttp(parsed))) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    !parsed.pathname.includes(`/v${version}/`) ||
    !TARGET_PATH_TOKENS[target].some((token) => parsed.pathname.includes(token)) ||
    /(?:^|\/)latest(?:\/|$)/iu.test(parsed.pathname)
  ) {
    throw new AppError(
      'unavailable',
      'Packaged release manifest asset URL is not an exact signed version',
      503,
    );
  }
  return parsed.toString();
}

// `toISOString()` output only: one canonical spelling keeps the signed payload byte-exact.
const ISSUED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function validIssuedAt(value: unknown): value is string {
  if (typeof value !== 'string' || !ISSUED_AT_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * The exact bytes each target signature covers. `scripts/sign-release-manifest.mjs` produces the
 * same string; changing one side without the other invalidates every published manifest.
 */
export function releaseSignaturePayload(input: {
  version: string;
  issuedAt: string;
  target: PackagedReleaseTarget;
  url: string;
  sha256: string;
  size: number;
}): string {
  return [
    'pimpampum-packaged-release-v1',
    'stable',
    input.version,
    input.issuedAt,
    input.target,
    input.url,
    input.sha256,
    String(input.size),
  ].join('\n');
}

function parsePackagedReleaseManifest(
  raw: string | Uint8Array,
  target: PackagedReleaseTarget,
  allowInsecureLoopback: boolean,
): { manifest: PackagedReleaseManifest; asset: PackagedReleaseAsset; signaturePayload: string } {
  if (typeof raw !== 'string' && !(raw instanceof Uint8Array)) {
    throw new AppError('unavailable', 'Packaged release manifest response is invalid', 503);
  }
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (bytes === 0 || bytes > MAX_RELEASE_MANIFEST_BYTES) {
    throw new AppError('unavailable', 'Packaged release manifest exceeded its size limit', 503);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'),
    ) as unknown;
  } catch {
    throw new AppError('unavailable', 'Packaged release manifest is not valid JSON', 503);
  }
  const supportedTargets = new Set<PackagedReleaseTarget>(PACKAGED_RELEASE_TARGETS);
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ['schemaVersion', 'channel', 'version', 'issuedAt', 'targets']) ||
    parsed.schemaVersion !== 1 ||
    parsed.channel !== 'stable' ||
    !validVersion(parsed.version) ||
    !validIssuedAt(parsed.issuedAt) ||
    !isRecord(parsed.targets) ||
    Object.keys(parsed.targets).length === 0 ||
    Object.keys(parsed.targets).length > supportedTargets.size ||
    Object.keys(parsed.targets).some(
      (candidateTarget) => !supportedTargets.has(candidateTarget as PackagedReleaseTarget),
    ) ||
    !Object.hasOwn(parsed.targets, target)
  ) {
    throw new AppError('unavailable', 'Packaged release manifest schema is incompatible', 503);
  }
  const candidate = parsed.targets[target];
  if (
    !isRecord(candidate) ||
    !exactKeys(candidate, ['url', 'sha256', 'signature', 'size']) ||
    typeof candidate.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
    typeof candidate.signature !== 'string' ||
    !/^[A-Za-z0-9+/_=-]{32,1024}$/u.test(candidate.signature) ||
    !Number.isSafeInteger(candidate.size) ||
    (candidate.size as number) <= 0 ||
    (candidate.size as number) > MAX_PACKAGED_RELEASE_BYTES
  ) {
    throw new AppError(
      'unavailable',
      'Packaged release manifest target hash, signature, or size is invalid',
      503,
    );
  }
  const asset: PackagedReleaseAsset = {
    url: releaseUrl(candidate.url, parsed.version, target, allowInsecureLoopback),
    sha256: candidate.sha256,
    signature: candidate.signature,
    size: candidate.size as number,
  };
  return {
    manifest: {
      schemaVersion: 1,
      channel: 'stable',
      version: parsed.version,
      issuedAt: parsed.issuedAt,
      targets: { [target]: asset } as PackagedReleaseManifest['targets'],
    },
    asset,
    signaturePayload: releaseSignaturePayload({
      version: parsed.version,
      issuedAt: parsed.issuedAt,
      target,
      url: asset.url,
      sha256: asset.sha256,
      size: asset.size,
    }),
  };
}

function validateChannelManifestUrl(value: string, allowInsecureLoopback: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError('unavailable', 'Packaged release channel URL is invalid', 503);
  }
  if (
    (parsed.protocol !== 'https:' && !(allowInsecureLoopback && isLoopbackHttp(parsed))) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    /(?:^|\/)latest(?:\/|$)/iu.test(parsed.pathname)
  ) {
    throw new AppError('unavailable', 'Packaged release channel URL must be bounded HTTPS', 503);
  }
  return parsed.toString();
}

function validatePackagedReleaseProvider(provider: PackagedReleaseProviderInput): string {
  if (!PACKAGED_RELEASE_TARGETS.includes(provider.target)) {
    throw new AppError('unavailable', 'Packaged release target is unsupported', 503);
  }
  return validateChannelManifestUrl(
    provider.channelManifestUrl,
    provider.allowInsecureLoopback === true,
  );
}

/**
 * Fetches the channel manifest, validates its schema and verifies the target signature. It is the
 * one path through which `update:check`, `update`, and a macOS `install` from npm learn what the
 * release channel offers; every caller receives an already-verified asset descriptor.
 */
export async function resolvePackagedRelease(
  provider: PackagedReleaseProviderInput,
  trust?: ReleaseTrustStore,
): Promise<ResolvedPackagedRelease> {
  const channelManifestUrl = validatePackagedReleaseProvider(provider);
  let raw: string | Uint8Array;
  try {
    raw = await provider.fetchManifest({
      url: channelManifestUrl,
      maximumBytes: MAX_RELEASE_MANIFEST_BYTES,
      timeoutMilliseconds: RELEASE_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    throw new AppError('unavailable', 'Packaged release manifest fetch failed', 503, true, {
      cause: error,
    });
  }
  const parsed = parsePackagedReleaseManifest(
    raw,
    provider.target,
    provider.allowInsecureLoopback === true,
  );
  let signatureValid = false;
  try {
    signatureValid = await provider.verifySignature({
      payload: parsed.signaturePayload,
      signature: parsed.asset.signature,
      target: provider.target,
    });
  } catch (error) {
    throw new AppError(
      'unavailable',
      'Packaged release manifest signature verification failed',
      503,
      false,
      { cause: error },
    );
  }
  if (!signatureValid) {
    throw new AppError('unavailable', 'Packaged release manifest signature is invalid', 503);
  }
  if (trust !== undefined) assertFreshManifest(parsed.manifest, trust);
  return { manifest: parsed.manifest, asset: parsed.asset };
}

export function createPackagedReleaseUpdateManager(input: {
  currentVersion: string;
  provider: PackagedReleaseProviderInput;
  /** Defaults to a per-manager memory; pass the data directory store to persist across runs. */
  trust?: ReleaseTrustStore;
}): UpdateManager {
  validatePackagedReleaseProvider(input.provider);
  const trust = input.trust ?? createVolatileReleaseTrustStore();
  const release = () => resolvePackagedRelease(input.provider, trust);

  return {
    async check() {
      const { manifest } = await release();
      return {
        currentVersion: input.currentVersion,
        latestVersion: manifest.version,
        updateAvailable: isNewerVersion(manifest.version, input.currentVersion),
      };
    },
    async update() {
      const { manifest, asset } = await release();
      const updateAvailable = isNewerVersion(manifest.version, input.currentVersion);
      if (!updateAvailable) {
        return {
          currentVersion: input.currentVersion,
          latestVersion: manifest.version,
          updateAvailable: false,
          updated: false,
          installedVersion: input.currentVersion,
          serviceReconciled: false,
        };
      }
      const staged = await input.provider.stageCandidate({
        version: manifest.version,
        target: input.provider.target,
        asset,
        maximumBytes: asset.size,
        timeoutMilliseconds: RELEASE_FETCH_TIMEOUT_MS,
      });
      if (
        !isRecord(staged) ||
        typeof staged.path !== 'string' ||
        !isAbsolute(staged.path) ||
        resolve(staged.path) !== staged.path ||
        staged.path.includes('\0') ||
        typeof staged.sha256 !== 'string' ||
        staged.sha256 !== asset.sha256 ||
        typeof staged.size !== 'number' ||
        staged.size !== asset.size ||
        !isRecord(staged.contains) ||
        staged.contains.app !== true ||
        staged.contains.runtime !== true ||
        staged.contains.plugin !== true
      ) {
        throw new AppError(
          'unavailable',
          'Staged packaged release failed app/runtime/plugin hash and inventory verification',
          503,
        );
      }
      await input.provider.reconcile({
        version: manifest.version,
        target: input.provider.target,
        candidatePath: staged.path,
        sha256: asset.sha256,
        signature: asset.signature,
      });
      return {
        currentVersion: manifest.version,
        latestVersion: manifest.version,
        updateAvailable: false,
        updated: true,
        installedVersion: manifest.version,
        serviceReconciled: true,
      };
    },
  };
}

/**
 * True when the installation receipt selects the signed release channel instead of npm: an
 * explicit `packaged-release` provenance, a packaged runtime, or the macOS app adapters.
 */
export function receiptUsesPackagedRelease(
  receipt: UpdateInstallReceiptMetadata | undefined,
): boolean {
  if (!receipt) return false;
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.adapter !== 'string' ||
    receipt.adapter.length === 0 ||
    (receipt.updateProvider !== undefined &&
      receipt.updateProvider !== 'legacy-npm' &&
      receipt.updateProvider !== 'packaged-release') ||
    (receipt.packagedRuntime !== undefined &&
      (!validVersion(receipt.packagedRuntime.version) ||
        !PACKAGED_RELEASE_TARGETS.includes(receipt.packagedRuntime.target) ||
        !isAbsolute(receipt.packagedRuntime.runtimeDirectory)))
  ) {
    throw new AppError('unavailable', 'Update install receipt schema is incompatible', 503);
  }
  if (receipt.updateProvider === 'legacy-npm') return false;
  if (receipt.updateProvider === 'packaged-release') return true;
  return (
    receipt.packagedRuntime !== undefined ||
    receipt.adapter === 'macos-app' ||
    receipt.adapter === 'launchd-macos-app'
  );
}

export function createUpdateManager(input: UpdateManagerInput): UpdateManager {
  if (receiptUsesPackagedRelease(input.installReceipt)) {
    if (!input.packagedRelease) {
      return {
        check: async () => {
          throw new AppError(
            'unavailable',
            'Packaged release provider is unavailable for this native installation',
            503,
          );
        },
        update: async () => {
          throw new AppError(
            'unavailable',
            'Packaged release provider is unavailable for this native installation',
            503,
          );
        },
      };
    }
    return createPackagedReleaseUpdateManager({
      currentVersion: input.currentVersion,
      provider: input.packagedRelease,
      ...(input.dataDirectory === undefined
        ? {}
        : { trust: createReleaseTrustStore(input.dataDirectory) }),
    });
  }
  return createLegacyNpmUpdateManager(input);
}
