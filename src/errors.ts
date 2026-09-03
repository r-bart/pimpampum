/**
 * The one catalogue of stable error codes. HTTP, MCP, the CLI envelope, both
 * clients and the OpenAPI document derive their lists from this constant.
 */
export const ERROR_CODES = [
  'bad_request',
  'not_found',
  'conflict',
  'revision_conflict',
  'invalid_state',
  'unauthorized',
  'payload_too_large',
  'unavailable',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const errorCodeSet: ReadonlySet<string> = new Set(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && errorCodeSet.has(value);
}

/**
 * Maps an HTTP status to the closest stable code when a response carries no
 * typed envelope. Both clients use it so a 404 never becomes `unavailable`.
 */
export function errorCodeForHttpStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'internal_error';
  return 'bad_request';
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details: Record<string, unknown> = {},
    /**
     * What this specific failure needs, when the guidance for its code would misdirect. A missing
     * Omarchy plugin is `unavailable`, but telling that user to run `pimpampum install` sends them
     * after a daemon that is running. Leave it unset to inherit the guidance for the code.
     */
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('internal_error', 'An internal error occurred', 500);
}
