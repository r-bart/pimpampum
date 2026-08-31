import { isAbsolute } from 'node:path';

import type { RuntimeLauncherInput, RuntimeLaunchers } from './types.js';

function validateExecutablePath(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    value.length === 0 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new Error(`${label} must be an absolute path without control characters`);
  }
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function render(nodePath: string, entrypointPath: string): string {
  return `#!/bin/sh\nset -eu\nexec ${shellQuote(nodePath)} ${shellQuote(entrypointPath)} "$@"\n`;
}

export function createRuntimeLaunchers(input: RuntimeLauncherInput): RuntimeLaunchers {
  const nodePath = validateExecutablePath(input.nodePath, 'Runtime Node path');
  const cliPath = validateExecutablePath(input.cliPath, 'Runtime CLI path');
  const mcpPath = validateExecutablePath(input.mcpPath, 'Runtime MCP path');
  return {
    control: render(nodePath, cliPath),
    mcp: render(nodePath, mcpPath),
  };
}
