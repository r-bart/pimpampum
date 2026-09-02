/**
 * One redaction for every diagnostic that leaves the process: the connector verifier and the setup
 * coordinator carried the same regex chain. Credentials become a fixed token, home directories
 * collapse to `~`, whitespace flattens to one line, and the result is bounded to 320 characters.
 */
export function redactDiagnostic(value: string): string {
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

/** The redacted message of an `Error`; a thrown non-Error value gets a neutral sentence. */
export function redactErrorMessage(error: unknown): string {
  return redactDiagnostic(error instanceof Error ? error.message : 'The operation failed');
}
