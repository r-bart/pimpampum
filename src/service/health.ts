export interface VerifyServiceHealthInput {
  baseUrl: string;
  version: string;
  fetchImplementation?: typeof globalThis.fetch;
  attempts?: number;
  requestTimeoutMilliseconds?: number;
  retryIntervalMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const MAXIMUM_HEALTH_BYTES = 4096;

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAXIMUM_HEALTH_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error('Service health response exceeded its size limit');
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAXIMUM_HEALTH_BYTES) {
        await reader.cancel();
        throw new Error('Service health response exceeded its size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface HealthTiming {
  attempts: number;
  requestTimeoutMilliseconds: number;
  retryIntervalMilliseconds: number;
}

/**
 * Keeps the readiness window bounded on both ends. A cold, hardened Node runtime can spend well
 * over ten seconds in launchd and Gatekeeper on its first start, so each request stays tightly
 * bounded while the signed service gets a realistic thirty-second window.
 */
function resolveHealthTiming(input: VerifyServiceHealthInput): HealthTiming {
  const attempts = input.attempts ?? 300;
  const requestTimeoutMilliseconds = input.requestTimeoutMilliseconds ?? 500;
  const retryIntervalMilliseconds = input.retryIntervalMilliseconds ?? 100;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 300) {
    throw new Error('Service health attempts must be between 1 and 300');
  }
  if (
    !Number.isInteger(requestTimeoutMilliseconds) ||
    requestTimeoutMilliseconds < 1 ||
    requestTimeoutMilliseconds > 2000 ||
    !Number.isInteger(retryIntervalMilliseconds) ||
    retryIntervalMilliseconds < 0 ||
    retryIntervalMilliseconds > 1000
  ) {
    throw new Error('Service health timing bounds are invalid');
  }
  return { attempts, requestTimeoutMilliseconds, retryIntervalMilliseconds };
}

/** The probe only ever talks plain HTTP to a loopback host, and never carries credentials. */
function loopbackHealthEndpoint(baseUrl: string): URL {
  const endpoint = new URL('/health', baseUrl);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new Error('Service health endpoint must use loopback HTTP');
  }
  return endpoint;
}

/**
 * Accepts the body only when it is a JSON object reporting `ok` for the exact installed version,
 * so a stale daemon from another release never passes as healthy.
 */
function assertHealthyPayload(bytes: Uint8Array, version: string): void {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).status !== 'ok' ||
    (value as Record<string, unknown>).version !== version
  ) {
    throw new Error('Service health response did not match the installed version');
  }
}

export async function verifyServiceHealth(input: VerifyServiceHealthInput): Promise<void> {
  const { attempts, requestTimeoutMilliseconds, retryIntervalMilliseconds } =
    resolveHealthTiming(input);
  const endpoint = loopbackHealthEndpoint(input.baseUrl);
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  let lastError: unknown = new Error('Service health check did not run');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(endpoint, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
      if (!response.ok) throw new Error(`Service health returned HTTP ${String(response.status)}`);
      assertHealthyPayload(await boundedResponseBytes(response), input.version);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(retryIntervalMilliseconds);
    }
  }
  throw new Error('Installed Pimpampum daemon did not become healthy', { cause: lastError });
}
