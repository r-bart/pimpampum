#!/usr/bin/env node
/**
 * A deliberately tiny bootstrap. It imports nothing from the application at module scope and loads
 * the real entry point dynamically, so a failure while evaluating the module graph — an unreadable
 * package manifest, a missing dependency, a broken native binding — still leaves the process as one
 * `{"error": ...}` envelope on stderr instead of a raw Node stack trace. An agent can parse every
 * failure this binary can produce, including the ones that happen before any of our code runs.
 */
async function bootstrap(): Promise<void> {
  const { runCliEntrypoint } = await import('./cliMain.js');
  await runCliEntrypoint(import.meta.url);
}

const startupSuggestion =
  'Pimpampum could not load. The installation is incomplete or corrupt: reinstall with `npm install --global pimpampum`, then run `pimpampum status`.';

async function reportStartupFailure(error: unknown): Promise<void> {
  // Reuse the shared envelope when it is loadable, because it carries the cause chain, but always
  // replace the suggestion: this failure happened before the daemon was ever contacted, so pointing
  // at daemon logs would send the caller to the wrong place.
  let envelope: unknown = {
    error: {
      code: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      details: { phase: 'startup' },
      suggestion: startupSuggestion,
    },
  };
  try {
    const { createLocalErrorEnvelope } = await import('./agentProtocol.js');
    const built = createLocalErrorEnvelope(error);
    envelope = {
      error: {
        ...built.error,
        details: { ...built.error.details, phase: 'startup' },
        suggestion: startupSuggestion,
      },
    };
  } catch {
    // The envelope module itself failed to load; the hand-built envelope above still applies.
  }
  process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
  process.exit(1);
}

bootstrap().catch((error: unknown) => void reportStartupFailure(error));
