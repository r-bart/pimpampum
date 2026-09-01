import { Client, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { isAbsolute } from 'node:path';
import type { Stream } from 'node:stream';
import { sanitizedHostEnvironment } from './process.js';

const MAX_DIAGNOSTIC_BYTES = 8_192;
const MAX_DIAGNOSTIC_ITEMS = 8;
const MAX_PROTOCOL_MESSAGE_BYTES = 1_000_000;
const MAX_TOOL_COUNT = 512;
const MAX_TOOL_NAME_LENGTH = 128;

interface ProbeInitialization {
  serverInfo?: { name?: unknown; version?: unknown };
  protocolVersion?: unknown;
  stderr?: unknown;
  diagnostics?: unknown;
}

interface ProbeToolList {
  tools?: unknown;
  stderr?: unknown;
  diagnostics?: unknown;
}

interface McpRouteProbe {
  initialize(): Promise<ProbeInitialization>;
  listTools(): Promise<ProbeToolList>;
  close(): Promise<void>;
  /** Last resort once `close()` misses its deadline: the bridge must not outlive the verifier. */
  kill?(): void;
  requiresProtocolVersion?: boolean;
  acceptsNegotiatedProtocolVersion?(protocolVersion: string): boolean;
  diagnostics?(): unknown[];
  diagnosticsOverflowed?(): boolean;
}

export interface McpRouteVerificationResult {
  available: boolean;
  serverName: string;
  tools: string[];
  diagnostics: string[];
}

function assertRoute(command: string, arguments_: string[]): void {
  if (!isAbsolute(command) || command.includes('\0')) {
    throw new Error('The MCP launcher must be an absolute stable path');
  }
  for (const argument of arguments_) {
    if (argument.includes('\0')) throw new Error('MCP launcher arguments must not contain NUL');
    if (/^(?:authorization\s*:|bearer\s+)/iu.test(argument)) {
      throw new Error('Secrets must not be passed in MCP launcher arguments');
    }
  }
}

function secretLeak(value: string): boolean {
  return (
    /\bauthorization\s*[:=]/iu.test(value) ||
    /\bbearer\s+\S+/iu.test(value) ||
    /\bpimpampum[-_](?:private[-_])?token(?:[-_][\w-]+)?/iu.test(value) ||
    /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/iu.test(value)
  );
}

function boundedSerialized(value: unknown): string {
  try {
    // All call sites pass protocol records or diagnostic arrays, which always serialize to text.
    const serialized = JSON.stringify(value) as string;
    if (Buffer.byteLength(serialized) > MAX_PROTOCOL_MESSAGE_BYTES) {
      throw new Error('MCP verifier output exceeded the bounded message limit');
    }
    return serialized;
  } catch (error) {
    if (error instanceof Error && /bounded message limit/iu.test(error.message)) throw error;
    throw new Error('MCP verifier output could not be inspected safely', { cause: error });
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(?:authorization\s*:?\s*)?bearer\s+\S+/giu, '[credential redacted]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/giu, '[credential redacted]')
    .replace(/\/Users\/[^/\s]+/gu, '~')
    .replace(/\/home\/[^/\s]+/gu, '~')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, 320);
}

function diagnosticValues(...sources: unknown[]): string[] {
  const diagnostics = new Set<string>();
  for (const source of sources) {
    if (typeof source === 'string') diagnostics.add(source);
    else if (Array.isArray(source)) {
      for (const item of source) if (typeof item === 'string') diagnostics.add(item);
    }
  }
  return [...diagnostics].slice(0, MAX_DIAGNOSTIC_ITEMS);
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
  phase: string,
  signal?: AbortSignal,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new Error('MCP verifier timeout must be positive');
  }
  let timeout!: NodeJS.Timeout;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`MCP ${phase} timed out after ${timeoutMilliseconds}ms`)),
      timeoutMilliseconds,
    );
    timeout.unref();
    if (signal !== undefined) {
      abort = () => reject(new Error(`MCP ${phase} was cancelled`));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timeout);
    if (signal !== undefined && abort !== undefined) signal.removeEventListener('abort', abort);
  }
}

function collectStderr(stream: Stream | null): {
  diagnostics(): string[];
  overflowed(): boolean;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  stream?.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_DIAGNOSTIC_BYTES) {
      overflow = true;
      return;
    }
    chunks.push(buffer);
  });
  return {
    diagnostics: () => {
      const value = Buffer.concat(chunks).toString('utf8').trim();
      return value ? [value] : [];
    },
    overflowed: () => overflow,
  };
}

/** SIGKILL for a bridge that ignored the graceful close; an already-gone process is not an error. */
export function killBridgeProcess(
  pid: number | null | undefined,
  signal: (pid: number, signal: NodeJS.Signals) => void = (target, name) =>
    process.kill(target, name),
): void {
  if (typeof pid !== 'number') return;
  try {
    signal(pid, 'SIGKILL');
  } catch {
    // The process exited between the close deadline and the signal.
  }
}

function spawnSdkProbe(command: string, arguments_: string[]): McpRouteProbe {
  const transport = new StdioClientTransport({
    command,
    args: [...arguments_],
    env: Object.fromEntries(
      Object.entries(sanitizedHostEnvironment()).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    stderr: 'pipe',
    maxBufferSize: MAX_PROTOCOL_MESSAGE_BYTES,
  });
  const stderr = collectStderr(transport.stderr);
  // `close()` forgets the child before it escalates, so remember the pid while it is connected.
  let bridgePid: number | null = null;
  const client = new Client(
    { name: 'pimpampum-connector-verifier', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  return {
    requiresProtocolVersion: true,
    acceptsNegotiatedProtocolVersion: (protocolVersion) =>
      client.getNegotiatedProtocolVersion() === protocolVersion &&
      client.getProtocolEra() !== undefined,
    diagnostics: stderr.diagnostics,
    diagnosticsOverflowed: stderr.overflowed,
    async initialize() {
      await client.connect(transport);
      bridgePid = transport.pid;
      if (stderr.overflowed()) throw new Error('MCP diagnostics exceeded the bounded output limit');
      const serverInfo = client.getServerVersion();
      const protocolVersion = client.getNegotiatedProtocolVersion();
      return {
        ...(serverInfo === undefined ? {} : { serverInfo }),
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        diagnostics: stderr.diagnostics(),
      };
    },
    async listTools() {
      const result = await client.listTools();
      if (stderr.overflowed()) throw new Error('MCP diagnostics exceeded the bounded output limit');
      return { tools: result.tools, diagnostics: stderr.diagnostics() };
    },
    close: () => client.close(),
    kill: () => killBridgeProcess(bridgePid),
  };
}

function toolNames(result: ProbeToolList): string[] {
  if (!Array.isArray(result.tools) || result.tools.length > MAX_TOOL_COUNT) {
    throw new Error('MCP tool catalog is missing or exceeds its bounded limit');
  }
  return result.tools.map((tool) => {
    if (
      typeof tool !== 'object' ||
      tool === null ||
      !('name' in tool) ||
      typeof tool.name !== 'string' ||
      tool.name.length === 0 ||
      tool.name.length > MAX_TOOL_NAME_LENGTH
    ) {
      throw new Error('MCP tool catalog contains an invalid tool name');
    }
    return tool.name;
  });
}

export async function verifyMcpRoute(input: {
  command: string;
  arguments: string[];
  timeoutMilliseconds: number;
  /** Bound for the graceful close; a bridge still alive afterwards is killed. Defaults to the phase timeout. */
  shutdownTimeoutMilliseconds?: number;
  requiredTools: string[];
  expectedServerName: string;
  supportedProtocolVersions?: string[];
  signal?: AbortSignal;
  spawn?: (command: string, arguments_: string[]) => McpRouteProbe;
}): Promise<McpRouteVerificationResult> {
  assertRoute(input.command, input.arguments);
  if (input.requiredTools.length > MAX_TOOL_COUNT) {
    throw new Error('Required MCP tool catalog exceeds the bounded limit');
  }
  const probe = (input.spawn ?? spawnSdkProbe)(input.command, [...input.arguments]);
  let primaryError: unknown;
  let operationFailed = false;
  let result: McpRouteVerificationResult | undefined;
  try {
    const initialized = await withDeadline(
      probe.initialize(),
      input.timeoutMilliseconds,
      'initialization',
      input.signal,
    );
    const initializationOutput = boundedSerialized(initialized);
    if (secretLeak(initializationOutput)) {
      throw new Error('Secret leakage detected in MCP initialization output');
    }
    const serverName = initialized.serverInfo?.name;
    if (serverName !== input.expectedServerName) {
      throw new Error('MCP server identity did not match the installed Pimpampum route');
    }

    const protocolVersion = initialized.protocolVersion;
    const protocolAccepted =
      typeof protocolVersion === 'string' &&
      (input.supportedProtocolVersions !== undefined
        ? input.supportedProtocolVersions.includes(protocolVersion)
        : SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion) ||
          probe.acceptsNegotiatedProtocolVersion?.(protocolVersion) === true);
    if (
      (probe.requiresProtocolVersion === true && typeof protocolVersion !== 'string') ||
      (typeof protocolVersion === 'string' && !protocolAccepted)
    ) {
      throw new Error('MCP server negotiated an incompatible protocol version');
    }

    const listed = await withDeadline(
      probe.listTools(),
      input.timeoutMilliseconds,
      'tool catalog',
      input.signal,
    );
    const catalogOutput = boundedSerialized(listed);
    if (secretLeak(catalogOutput)) throw new Error('Secret leakage detected in MCP tool output');
    const tools = toolNames(listed);
    const requiredTools = [...new Set(input.requiredTools)];
    if (
      requiredTools.some(
        (required) =>
          required.length === 0 ||
          required.length > MAX_TOOL_NAME_LENGTH ||
          !tools.includes(required),
      )
    ) {
      throw new Error('MCP tool catalog is missing required Pimpampum tools');
    }

    const rawDiagnostics = diagnosticValues(
      initialized.stderr,
      initialized.diagnostics,
      listed.stderr,
      listed.diagnostics,
    );
    if (rawDiagnostics.some(secretLeak)) {
      throw new Error('Secret leakage detected in MCP verifier diagnostics');
    }
    result = {
      available: true,
      serverName,
      tools,
      diagnostics: rawDiagnostics.map(redactDiagnostic).filter(Boolean),
    };
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }
  let closeError: unknown;
  try {
    await withDeadline(
      probe.close(),
      input.shutdownTimeoutMilliseconds ?? input.timeoutMilliseconds,
      'shutdown',
    );
  } catch (error) {
    closeError = error;
    probe.kill?.();
  }
  const finalDiagnostics = diagnosticValues(probe.diagnostics?.());
  if (probe.diagnosticsOverflowed?.() === true || secretLeak(boundedSerialized(finalDiagnostics))) {
    operationFailed = true;
    primaryError = new Error('Secret leakage or oversized output detected while closing MCP route');
  } else if (result !== undefined && finalDiagnostics.length > 0) {
    result.diagnostics = diagnosticValues(result.diagnostics, finalDiagnostics)
      .map(redactDiagnostic)
      .filter(Boolean);
  }
  if (operationFailed) throw primaryError;
  if (closeError !== undefined) {
    throw new Error('MCP verifier could not reap the stdio route', { cause: closeError });
  }
  // Every non-failing path through the guarded operation assigns the result before shutdown.
  return result as McpRouteVerificationResult;
}
