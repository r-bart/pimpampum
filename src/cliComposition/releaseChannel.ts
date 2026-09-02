/**
 * The trust and transport of the signed release channel: which public key verifies a manifest,
 * how a manifest or asset is fetched within bounds, and which redirects a fetch may follow. Nothing
 * here knows what a release contains; `releaseCandidate.ts` validates the bytes once they land.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AppError } from '../errors.js';
import { RELEASE_PUBLIC_KEY_PEM, type PackagedReleaseProviderInput } from '../update.js';

// A rolling release that only ever carries the signed manifest and the public key. The release job
// replaces both assets after every published version (`.github/workflows/release.yml`).
const RELEASE_DOWNLOADS_URL = 'https://github.com/r-bart/pimpampum/releases/download';
export const DEFAULT_RELEASE_CHANNEL_URL = `${RELEASE_DOWNLOADS_URL}/update-channel-stable/release-manifest.json`;
const MAX_RELEASE_KEY_BYTES = 16 * 1024;
const MAX_RELEASE_REDIRECTS = 3;
/**
 * The flag that opens every development seam of the release channel at once: a public key from
 * disk and plain-HTTP loopback URLs. Nothing else reads it.
 */
export const DEVELOPMENT_RELEASE_KEY_FLAG = 'PIMPAMPUM_DEV_RELEASE_KEY';

/** The signed manifest each versioned release also carries, so an install can fetch its own version. */
export function versionedReleaseManifestUrl(version: string): string {
  return `${RELEASE_DOWNLOADS_URL}/v${version}/release-manifest.json`;
}

/**
 * Reads a development public key. It exists for the E2E and for release-channel work on a
 * checkout; production installs never reach it because the embedded key needs no file.
 */
function readDevelopmentReleaseKey(path: string, currentUid: number | undefined): string {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('Development release public key path must be absolute');
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Development release public key must be a regular file');
  }
  if (currentUid !== undefined && metadata.uid !== currentUid && metadata.uid !== 0) {
    throw new Error('Development release public key is not owned by the current user or root');
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error('Development release public key must not be group- or world-writable');
  }
  if (metadata.size <= 0 || metadata.size > MAX_RELEASE_KEY_BYTES) {
    throw new Error('Development release public key has an invalid size');
  }
  return readFileSync(path, 'utf8');
}

/**
 * The trust root of the release channel. The embedded key wins unless a caller injects a path
 * (tests) or the environment opts into development mode with `PIMPAMPUM_DEV_RELEASE_KEY=1` and
 * names a file in `PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH`. Without the flag the path variable is
 * ignored, so an environment alone cannot swap the key an installed copy trusts.
 */
export function resolveReleasePublicKeyPem(input: {
  publicKeyPath?: string | undefined;
  environment: NodeJS.ProcessEnv;
  /** The effective user id a development key file must belong to; `undefined` skips the check. */
  currentUid?: number | undefined;
}): string {
  if (input.publicKeyPath !== undefined) {
    return readDevelopmentReleaseKey(input.publicKeyPath, input.currentUid);
  }
  const developmentPath = input.environment.PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH;
  if (input.environment[DEVELOPMENT_RELEASE_KEY_FLAG] === '1' && developmentPath) {
    return readDevelopmentReleaseKey(developmentPath, input.currentUid);
  }
  return RELEASE_PUBLIC_KEY_PEM;
}

// Standard base64 with padding: 64 signature bytes are exactly 88 characters ending in `=`.
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function createReleaseSignatureVerifier(input: {
  /** PEM text, or a resolver evaluated on every verification so a bad dev key fails typed. */
  publicKeyPem: string | (() => string);
}): PackagedReleaseProviderInput['verifySignature'] {
  return ({ payload, signature }) => {
    const pem = typeof input.publicKeyPem === 'string' ? input.publicKeyPem : input.publicKeyPem();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Release public key must be Ed25519');
    }
    // `Buffer.from(value, 'base64')` never throws; it silently skips characters it cannot decode.
    if (!STRICT_BASE64.test(signature)) throw new Error('Release signature is not valid base64');
    const decoded = Buffer.from(signature, 'base64');
    if (decoded.length !== 64) throw new Error('Release signature has an invalid size');
    return verifySignature(null, Buffer.from(payload, 'utf8'), key, decoded);
  };
}

const RELEASE_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function transportFailure(message: string, cause?: unknown): AppError {
  return new AppError('unavailable', message, 503, true, cause === undefined ? {} : { cause });
}

/**
 * Where a release fetch may go. GitHub answers `releases/download/*` with a 302 to
 * `*.githubusercontent.com`, so that family is the only cross-host hop the channel accepts; every
 * other redirect must stay on the host the signed URL named. HTTPS is mandatory unless the
 * development flag opened plain-HTTP loopback for a local test server.
 */
function assertAllowedReleaseHop(input: {
  candidate: URL;
  origin: URL;
  allowInsecureLoopback: boolean;
}): void {
  const { candidate, origin } = input;
  const insecureLoopback =
    input.allowInsecureLoopback &&
    candidate.protocol === 'http:' &&
    RELEASE_LOOPBACK_HOSTS.has(candidate.hostname);
  if (candidate.protocol !== 'https:' && !insecureLoopback) {
    throw transportFailure('Release fetch redirect left HTTPS');
  }
  if (candidate.username !== '' || candidate.password !== '') {
    throw transportFailure('Release fetch redirect carries credentials');
  }
  const sameHost = candidate.host === origin.host;
  const githubAssetHost =
    origin.hostname === 'github.com' &&
    (candidate.hostname === 'githubusercontent.com' ||
      candidate.hostname.endsWith('.githubusercontent.com'));
  if (!sameHost && !githubAssetHost) {
    throw transportFailure(`Release fetch redirect to ${candidate.hostname} is not allowed`);
  }
}

interface BoundedFetchInput {
  url: string;
  maximumBytes: number;
  timeoutMilliseconds: number;
  fetchImplementation: typeof globalThis.fetch;
  allowInsecureLoopback?: boolean | undefined;
}

/**
 * Follows redirects by hand so every hop passes the host and scheme policy above; `fetch`'s own
 * follower would accept any host, and `redirect: 'error'` rejects GitHub's own asset CDN.
 */
async function fetchFollowingAllowedHops(
  input: BoundedFetchInput,
  origin: URL,
  signal: AbortSignal,
): Promise<Response> {
  const allowInsecureLoopback = input.allowInsecureLoopback === true;
  let current = origin;
  let hops = 0;
  while (true) {
    const response = await input.fetchImplementation(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: { Accept: 'application/octet-stream, application/json' },
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    hops += 1;
    if (hops > MAX_RELEASE_REDIRECTS) {
      throw transportFailure(`Release fetch exceeded ${String(MAX_RELEASE_REDIRECTS)} redirects`);
    }
    const location = response.headers.get('location');
    if (location === null) throw transportFailure('Release fetch redirect has no location');
    let next: URL;
    try {
      next = new URL(location, current);
    } catch (error) {
      throw transportFailure('Release fetch redirect location is invalid', error);
    }
    assertAllowedReleaseHop({ candidate: next, origin, allowInsecureLoopback });
    current = next;
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.ok || response.body === null) {
    throw transportFailure(`Release fetch returned HTTP ${String(response.status)}`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw transportFailure('Release response exceeds its declared size limit');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw transportFailure('Release response exceeds its streaming size limit');
    }
    chunks.push(result.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function boundedFetchBytes(input: BoundedFetchInput): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMilliseconds);
  const origin = new URL(input.url);
  assertAllowedReleaseHop({
    candidate: origin,
    origin,
    allowInsecureLoopback: input.allowInsecureLoopback === true,
  });
  try {
    const response = await fetchFollowingAllowedHops(input, origin, controller.signal);
    return await readBoundedBody(response, input.maximumBytes);
  } finally {
    clearTimeout(timeout);
  }
}

export function createBoundedReleaseManifestFetcher(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  options: { allowInsecureLoopback?: boolean } = {},
): PackagedReleaseProviderInput['fetchManifest'] {
  return (input) =>
    boundedFetchBytes({
      ...input,
      fetchImplementation,
      allowInsecureLoopback: options.allowInsecureLoopback,
    });
}

export interface ReleaseChannelTransportInput {
  fetchImplementation?: typeof globalThis.fetch | undefined;
  /** The variables that open the development seams; the composition passes the host's. */
  environment: NodeJS.ProcessEnv;
  publicKeyPath?: string | undefined;
  channelManifestUrl?: string | undefined;
  currentUid?: number | undefined;
}

export interface ReleaseChannelTransport {
  fetchImplementation: typeof globalThis.fetch;
  allowInsecureLoopback: boolean;
  channelManifestUrl: string | undefined;
  fetchManifest: PackagedReleaseProviderInput['fetchManifest'];
  verifySignature: PackagedReleaseProviderInput['verifySignature'];
}

export function releaseChannelTransport(
  input: ReleaseChannelTransportInput,
): ReleaseChannelTransport {
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const allowInsecureLoopback = input.environment[DEVELOPMENT_RELEASE_KEY_FLAG] === '1';
  return {
    fetchImplementation,
    allowInsecureLoopback,
    channelManifestUrl:
      input.channelManifestUrl ?? input.environment.PIMPAMPUM_RELEASE_MANIFEST_URL,
    fetchManifest: createBoundedReleaseManifestFetcher(fetchImplementation, {
      allowInsecureLoopback,
    }),
    verifySignature: createReleaseSignatureVerifier({
      publicKeyPem: () =>
        resolveReleasePublicKeyPem({
          publicKeyPath: input.publicKeyPath,
          environment: input.environment,
          currentUid: input.currentUid,
        }),
    }),
  };
}
