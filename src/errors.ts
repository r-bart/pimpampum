export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'revision_conflict'
  | 'invalid_state'
  | 'unauthorized'
  | 'payload_too_large'
  | 'unavailable'
  | 'internal_error';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError('internal_error', 'An internal error occurred', 500);
  }
  return new AppError('internal_error', 'An internal error occurred', 500);
}
