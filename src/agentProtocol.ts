import type { CallToolResult } from '@modelcontextprotocol/server';
import { AppError, asAppError, type ErrorCode } from './errors.js';

export interface AgentError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
  suggestion: string;
}

export interface AgentSuccessEnvelope<T = unknown> {
  data: T;
}

export interface AgentErrorEnvelope {
  error: AgentError;
}

export type AgentEnvelope<T = unknown> = AgentSuccessEnvelope<T> | AgentErrorEnvelope;

const errorGuidance: Partial<Record<ErrorCode, string>> = {
  bad_request: 'Correct the arguments using this tool input schema, then retry.',
  conflict: 'Inspect the current Claim and resource manifest before retrying.',
  invalid_state:
    'Inspect the Project, Spec, Task hierarchy and ancestor lifecycle states before retrying.',
  not_found: 'Verify the resource ID or resolve the current workspace again.',
  revision_conflict: 'Read the latest manifest, then retry with its current revision.',
  unauthorized: 'Verify the daemon bearer token used by the MCP transport or stdio bridge.',
};

const fallbackGuidance =
  'Inspect the daemon logs and retry only if the underlying failure is transient.';

export function createAgentSuccessEnvelope<T>(data: T): AgentSuccessEnvelope<T> {
  return { data };
}

export function createAgentErrorEnvelope(error: unknown): AgentErrorEnvelope {
  const appError = asAppError(error);
  return {
    error: {
      code: appError.code,
      message: appError.message,
      retryable: appError.retryable,
      details: appError.details,
      suggestion: errorGuidance[appError.code] ?? fallbackGuidance,
    },
  };
}

type AgentCallToolResult = Pick<CallToolResult, 'content' | 'isError'>;

function invalidEnvelope(): never {
  throw new AppError('internal_error', 'MCP tool returned an invalid Pimpampum envelope', 500);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isErrorCode(value: unknown): value is ErrorCode {
  return (
    value === 'bad_request' ||
    value === 'not_found' ||
    value === 'conflict' ||
    value === 'revision_conflict' ||
    value === 'invalid_state' ||
    value === 'unauthorized' ||
    value === 'payload_too_large' ||
    value === 'internal_error'
  );
}

function isAgentError(value: unknown): value is AgentError {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['code', 'message', 'retryable', 'details', 'suggestion'])) {
    return false;
  }
  return (
    isErrorCode(value.code) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean' &&
    isRecord(value.details) &&
    typeof value.suggestion === 'string'
  );
}

export function extractAgentEnvelope(result: AgentCallToolResult): AgentEnvelope {
  if (result.content.length !== 1) invalidEnvelope();
  const block = result.content[0];
  if (block?.type !== 'text') invalidEnvelope();

  let decoded: unknown;
  try {
    decoded = JSON.parse(block.text) as unknown;
  } catch {
    invalidEnvelope();
  }

  if (!isRecord(decoded)) invalidEnvelope();
  if (result.isError === true) {
    if (!hasExactKeys(decoded, ['error']) || !isAgentError(decoded.error)) invalidEnvelope();
    return decoded as unknown as AgentErrorEnvelope;
  }
  if (!hasExactKeys(decoded, ['data'])) invalidEnvelope();
  return decoded as unknown as AgentSuccessEnvelope;
}
