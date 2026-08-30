import { readFileSync } from 'node:fs';

/**
 * The one place the product version is read. Every surface that reports a version — the CLI usage
 * banner, `pimpampum version`, `/health`, the MCP server handshake, the OpenAPI document, and the
 * agent CLI client — imports this constant, so a release cannot leave one of them behind.
 *
 * The manifest path resolves against this module's own URL rather than the working directory, so it
 * holds for `src/version.ts` under tsx, for `dist/version.js` in the repository, and for
 * `dist/version.js` inside the published package. All three sit one directory below the manifest.
 */
export function parseVersion(manifestText: string): string {
  const manifest = JSON.parse(manifestText) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('package.json does not declare a version');
  }
  return manifest.version;
}

export const PIMPAMPUM_VERSION = parseVersion(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
