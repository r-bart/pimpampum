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

export async function verifyServiceHealth(input: VerifyServiceHealthInput): Promise<void> {
  // A cold, hardened Node runtime can take several seconds to initialize when launchd starts it
  // for the first time. Keep each request tightly bounded while allowing the signed service a
  // realistic ten-second readiness window.
  const attempts = input.attempts ?? 100;
  const requestTimeoutMilliseconds = input.requestTimeoutMilliseconds ?? 500;
  const retryIntervalMilliseconds = input.retryIntervalMilliseconds ?? 100;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error('Service health attempts must be between 1 and 100');
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
  const endpoint = new URL('/health', input.baseUrl);
  if (
    endpoint.protocol !== 'http:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new Error('Service health endpoint must use loopback HTTP');
  }
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
      const bytes = await boundedResponseBytes(response);
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        (value as Record<string, unknown>).status !== 'ok' ||
        (value as Record<string, unknown>).version !== input.version
      ) {
        throw new Error('Service health response did not match the installed version');
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(retryIntervalMilliseconds);
    }
  }
  throw new Error('Installed Pimpampum daemon did not become healthy', { cause: lastError });
}
