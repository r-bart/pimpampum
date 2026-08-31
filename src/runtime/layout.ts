import { isAbsolute, join, normalize, parse, resolve } from 'node:path';

import { parseRuntimeTarget, parseRuntimeVersion, runtimeTargetId } from './manifest.js';
import type { RuntimeLayout, RuntimeLayoutInput } from './types.js';

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizedHomeDirectory(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isAbsolute(value) ||
    containsControlCharacter(value)
  ) {
    throw new Error('Runtime home directory must be an absolute path without control characters');
  }
  const normalized = normalize(value);
  if (normalized === parse(normalized).root || resolve(normalized) !== normalized) {
    throw new Error(
      'Runtime home directory must be private, normalized, and below a filesystem root',
    );
  }
  return normalized;
}

export function resolveRuntimeLayout(input: RuntimeLayoutInput): RuntimeLayout {
  const homeDirectory = normalizedHomeDirectory(input.homeDirectory);
  const target = parseRuntimeTarget(input.platform, input.architecture);
  const targetId = runtimeTargetId(target);
  const version = parseRuntimeVersion(input.version, 'runtime layout version');
  const dataDirectory = join(homeDirectory, '.pimpampum');

  if (target.platform === 'darwin') {
    const applicationSupportDirectory = join(
      homeDirectory,
      'Library',
      'Application Support',
      'Pimpampum',
    );
    const runtimeDirectory = join(applicationSupportDirectory, 'Runtime');
    const launchersDirectory = join(applicationSupportDirectory, 'bin');
    return {
      target,
      targetId,
      dataDirectory,
      logDirectory: join(dataDirectory, 'logs'),
      runtimeDirectory,
      versionsDirectory: runtimeDirectory,
      versionDirectory: join(runtimeDirectory, version, targetId),
      launchersDirectory,
      controlLauncherPath: join(launchersDirectory, 'pimpampum-control'),
      mcpLauncherPath: join(launchersDirectory, 'pimpampum-mcp'),
      applicationDirectory: join(homeDirectory, 'Applications', 'Pimpampum.app'),
      pluginDirectory: join(applicationSupportDirectory, 'Integrations'),
    };
  }

  const productShareDirectory = join(homeDirectory, '.local', 'share', 'pimpampum');
  const runtimeDirectory = join(productShareDirectory, 'runtime');
  const launchersDirectory = join(productShareDirectory, 'bin');
  return {
    target,
    targetId,
    dataDirectory,
    logDirectory: join(dataDirectory, 'logs'),
    runtimeDirectory,
    versionsDirectory: runtimeDirectory,
    versionDirectory: join(runtimeDirectory, version, targetId),
    launchersDirectory,
    controlLauncherPath: join(launchersDirectory, 'pimpampum-control'),
    mcpLauncherPath: join(launchersDirectory, 'pimpampum-mcp'),
    applicationDirectory: join(productShareDirectory, 'app'),
    pluginDirectory: join(homeDirectory, '.config', 'omarchy', 'plugins', 'dev.pimpampum.status'),
  };
}
