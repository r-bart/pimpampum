import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { assertNoSymlinkTraversal } from './receipt.js';
import type {
  CommandResult,
  PlatformServiceAdapter,
  ServiceAdapterContext,
  ServiceArtifact,
  ServiceIntegrationStatus,
} from './types.js';

export const OMARCHY_PLUGIN_ID = 'dev.pimpampum.status';

export function isCompatibleOmarchyVersion(output: string): boolean {
  return /\b(?:quattro|4(?:\.|\b))/iu.test(output.trim());
}

export interface OmarchyAdapterOptions {
  pluginSourcePath: string;
  daemonAdapter: PlatformServiceAdapter;
  omarchyPath: string;
  omarchyShellPath: string;
}

interface PluginState {
  installed: boolean;
  enabled: boolean;
}

interface LifecycleState extends PluginState {
  enableChanged: boolean;
}

interface BarWidgetLayout {
  section: 'left' | 'center' | 'right';
  index: number;
  entry: Record<string, unknown>;
}

type AsyncRollback = () => Promise<void>;

const MAX_SHELL_CONFIG_BYTES = 1024 * 1024;
const MAX_BAR_ENTRIES_PER_SECTION = 1024;
const MAX_WIDGET_SETTINGS = 64;
const MAX_WIDGET_ENTRY_BYTES = 64 * 1024;
const WIDGET_READINESS_DEADLINE_MS = 5000;
const WIDGET_READINESS_INITIAL_DELAY_MS = 50;
const WIDGET_READINESS_MAX_DELAY_MS = 800;
const RETRYABLE_WIDGET_ENABLE_RESULTS = new Set(['unknown', 'not ready']);

function requireAbsolute(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be absolute`);
  return resolve(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function commandError(label: string, result: CommandResult): Error {
  return new Error(
    `${label} failed with exit code ${result.exitCode}; stderr=${JSON.stringify(result.stderr.trim())}`,
  );
}

async function runRequired(
  context: ServiceAdapterContext,
  executable: string,
  arguments_: string[],
  label: string,
): Promise<CommandResult> {
  const result = await context.runCommand(executable, arguments_);
  if (result.exitCode !== 0) throw commandError(label, result);
  return result;
}

async function readOmarchyVersion(
  context: ServiceAdapterContext,
  executable: string,
): Promise<CommandResult> {
  const current = await context.runCommand(executable, ['version']);
  if (current.exitCode === 0) return current;
  return runRequired(context, executable, ['--version'], 'omarchy version');
}

function pluginTarget(context: ServiceAdapterContext): string {
  return join(context.homeDirectory, '.config', 'omarchy', 'plugins', OMARCHY_PLUGIN_ID);
}

function pluginDirectory(context: ServiceAdapterContext): string {
  return dirname(pluginTarget(context));
}

function backupNamePrefix(): string {
  return `.${OMARCHY_PLUGIN_ID}.bak.`;
}

function shellQuote(value: string, label: string): string {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must not contain null bytes or line breaks`);
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function renderOverviewHelper(context: ServiceAdapterContext): string {
  return `#!/bin/bash
set -euo pipefail

export PIMPAMPUM_DATA_DIR=${shellQuote(context.dataDirectory, 'Pimpampum data directory')}
export PIMPAMPUM_HOST=${shellQuote(context.host, 'Pimpampum host')}
export PIMPAMPUM_PORT=${shellQuote(String(context.port), 'Pimpampum port')}
exec ${shellQuote(context.nodePath, 'Node executable')} ${shellQuote(context.cliPath, 'Pimpampum CLI')} overview
`;
}

function renderBackupHelper(context: ServiceAdapterContext): string {
  return `#!/bin/bash
set -euo pipefail

case \${1:-} in
  status|retry|disable)
    [[ $# -eq 1 ]] || { printf '%s\\n' 'pimpampum-backup: invalid arguments' >&2; exit 64; }
    ;;
  configure)
    [[ $# -eq 2 ]] || { printf '%s\\n' 'pimpampum-backup: configure requires one directory' >&2; exit 64; }
    ;;
  *)
    printf '%s\\n' 'pimpampum-backup: expected status, configure, retry, or disable' >&2
    exit 64
    ;;
esac

export PIMPAMPUM_DATA_DIR=${shellQuote(context.dataDirectory, 'Pimpampum data directory')}
export PIMPAMPUM_HOST=${shellQuote(context.host, 'Pimpampum host')}
export PIMPAMPUM_PORT=${shellQuote(String(context.port), 'Pimpampum port')}
exec ${shellQuote(context.nodePath, 'Node executable')} ${shellQuote(context.cliPath, 'Pimpampum CLI')} backup "$@"
`;
}

function renderSyncHelper(context: ServiceAdapterContext): string {
  return `#!/bin/bash
set -euo pipefail

case \${1:-} in
  status|now|pause|resume|conflicts|forget)
    [[ $# -eq 1 ]] || { printf '%s\\n' 'pimpampum-sync: invalid arguments' >&2; exit 64; }
    ;;
  configure)
    [[ $# -eq 2 ]] || { printf '%s\\n' 'pimpampum-sync: configure requires one directory' >&2; exit 64; }
    ;;
  *)
    printf '%s\\n' 'pimpampum-sync: expected status, configure, now, pause, resume, conflicts, or forget' >&2
    exit 64
    ;;
esac

export PIMPAMPUM_DATA_DIR=${shellQuote(context.dataDirectory, 'Pimpampum data directory')}
export PIMPAMPUM_HOST=${shellQuote(context.host, 'Pimpampum host')}
export PIMPAMPUM_PORT=${shellQuote(String(context.port), 'Pimpampum port')}

if [[ $1 == configure ]]; then
  device_id=$(hostname | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-63)
  [[ -n $device_id ]] || device_id=linux
  exec ${shellQuote(context.nodePath, 'Node executable')} ${shellQuote(context.cliPath, 'Pimpampum CLI')} sync configure "$2" --device "$device_id" --json
fi

exec ${shellQuote(context.nodePath, 'Node executable')} ${shellQuote(context.cliPath, 'Pimpampum CLI')} sync "$1" --json
`;
}

function walkPluginSource(sourceRoot: string, directory = sourceRoot): string[] {
  const paths: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name === '.git') continue;
    const path = join(directory, name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`Omarchy plugin contains a symlink: ${path}`);
    if (metadata.isDirectory()) paths.push(...walkPluginSource(sourceRoot, path));
    else if (metadata.isFile()) paths.push(path);
    else throw new Error(`Omarchy plugin contains a non-regular file: ${path}`);
  }
  return paths;
}

function pluginArtifacts(sourceRoot: string, context: ServiceAdapterContext): ServiceArtifact[] {
  const target = pluginTarget(context);
  return walkPluginSource(sourceRoot).map((sourcePath) => {
    const child = relative(sourceRoot, sourcePath);
    const executable = [
      'install.sh',
      'uninstall.sh',
      'pimpampum-backup',
      'pimpampum-folder-picker',
      'pimpampum-overview',
      'pimpampum-sync',
    ].includes(child);
    return {
      path: join(target, child),
      content:
        child === 'pimpampum-overview'
          ? renderOverviewHelper(context)
          : child === 'pimpampum-backup'
            ? renderBackupHelper(context)
            : child === 'pimpampum-sync'
              ? renderSyncHelper(context)
              : readFileSync(sourcePath),
      mode: executable ? 0o755 : 0o644,
    };
  });
}

function assertOwnedPluginDirectory(directory: string, context: ServiceAdapterContext): void {
  assertNoSymlinkTraversal(directory, 'Omarchy plugin ownership target', pluginDirectory(context));
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Owned Omarchy plugin target must be a regular directory');
  }
  const marker = join(directory, '.pimpampum-plugin-owner.json');
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink() || !lstatSync(marker).isFile()) {
    throw new Error('Refusing to use an unowned Omarchy plugin directory');
  }
  let owner: unknown;
  try {
    owner = JSON.parse(readFileSync(marker, 'utf8')) as unknown;
  } catch (error) {
    throw new Error('Refusing to use an invalid Omarchy plugin owner marker', { cause: error });
  }
  if (
    !isRecord(owner) ||
    owner.schemaVersion !== 1 ||
    owner.owner !== 'pimpampum' ||
    owner.pluginId !== OMARCHY_PLUGIN_ID
  ) {
    throw new Error('Refusing to use an unowned Omarchy plugin directory');
  }
}

function removeEmptyPluginDirectories(context: ServiceAdapterContext): void {
  const target = pluginTarget(context);
  if (!existsSync(target)) return;
  assertNoSymlinkTraversal(target, 'Omarchy plugin cleanup target', context.homeDirectory);
  const directories = [target];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const child = join(directory, name);
      const metadata = lstatSync(child);
      if (metadata.isDirectory()) {
        directories.push(child);
        visit(child);
      }
    }
  };
  visit(target);
  for (const directory of directories.reverse()) {
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePluginList(stdout: string): PluginState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error('omarchy plugin list returned invalid JSON', { cause: error });
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.plugins)
      ? parsed.plugins
      : null;
  if (!entries || !entries.every(isRecord)) {
    throw new Error('omarchy plugin list returned an incompatible JSON shape');
  }
  const match = entries.find((entry) => entry.id === OMARCHY_PLUGIN_ID);
  if (!match) return { installed: false, enabled: false };
  if (typeof match.enabled !== 'boolean') {
    throw new Error('omarchy plugin list omitted the enabled state');
  }
  return { installed: true, enabled: match.enabled };
}

function pluginIntegration(state: PluginState): ServiceIntegrationStatus {
  return {
    omarchyPlugin: state.enabled ? 'enabled' : state.installed ? 'disabled' : 'missing',
  };
}

function validateOwnedDestination(context: ServiceAdapterContext): void {
  const target = pluginTarget(context);
  assertNoSymlinkTraversal(target, 'Omarchy plugin target', context.homeDirectory);
  if (!existsSync(target)) return;
  const metadata = lstatSync(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Refusing to replace a non-directory Omarchy plugin target');
  }
  try {
    assertOwnedPluginDirectory(target, context);
  } catch (error) {
    throw new Error('Refusing to replace an unowned Omarchy plugin', { cause: error });
  }
}

function validateRemovalTree(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): void {
  const target = pluginTarget(context);
  assertOwnedPluginDirectory(target, context);
  const allowedFiles = new Set(
    artifacts
      .map((artifact) => normalize(artifact.path))
      .filter((path) => path === target || relative(target, path).split(/[\\/]/u)[0] !== '..')
      .filter((path) => path !== target),
  );
  const allowedDirectories = new Set<string>([target]);
  for (const path of allowedFiles) {
    let current = dirname(path);
    while (current !== target) {
      allowedDirectories.add(current);
      current = dirname(current);
    }
  }
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const child = join(directory, name);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing to remove an Omarchy plugin containing a symlink: ${child}`);
      }
      if (metadata.isDirectory()) {
        if (!allowedDirectories.has(child)) {
          throw new Error(`Refusing to remove an unreceipted Omarchy plugin directory: ${child}`);
        }
        visit(child);
      } else if (!metadata.isFile() || !allowedFiles.has(child)) {
        throw new Error(`Refusing to remove an unreceipted Omarchy plugin artifact: ${child}`);
      }
    }
  };
  visit(target);
}

function removalBackupNames(context: ServiceAdapterContext): Set<string> {
  const directory = pluginDirectory(context);
  assertNoSymlinkTraversal(directory, 'Omarchy plugins directory', context.homeDirectory);
  return new Set(readdirSync(directory).filter((name) => name.startsWith(backupNamePrefix())));
}

function newRemovalBackup(context: ServiceAdapterContext, before: Set<string>): string | null {
  const directory = pluginDirectory(context);
  const newNames = [...removalBackupNames(context)].filter((name) => !before.has(name));
  return newNames.length === 1 ? join(directory, newNames[0]!) : null;
}

function validateReportedRemovalBackup(
  context: ServiceAdapterContext,
  before: Set<string>,
  stdout: string,
  candidate: string | null,
): void {
  const outputPrefix = `Removed ${OMARCHY_PLUGIN_ID}. Backup at: `;
  const line = stdout.split(/\r?\n/u).find((output) => output.startsWith(outputPrefix));
  const reported = line
    ? requireAbsolute(line.slice(outputPrefix.length), 'Omarchy removal backup')
    : candidate;
  if (!reported && !candidate) return;
  if (!reported || !candidate) {
    throw new Error('omarchy plugin remove reported an unsafe or pre-existing backup');
  }
  const name = basename(candidate);
  if (
    reported !== candidate ||
    dirname(candidate) !== pluginDirectory(context) ||
    !name.startsWith(backupNamePrefix()) ||
    before.has(name)
  ) {
    throw new Error('omarchy plugin remove reported an unsafe or pre-existing backup');
  }
}

function removeTrackedBackup(context: ServiceAdapterContext, backupPath: string | null): null {
  if (!backupPath || !existsSync(backupPath)) return null;
  assertOwnedPluginDirectory(backupPath, context);
  rmSync(backupPath, { recursive: true });
  return null;
}

async function readPluginState(
  context: ServiceAdapterContext,
  omarchyPath: string,
): Promise<PluginState> {
  const result = await runRequired(
    context,
    omarchyPath,
    ['plugin', 'list', '--json'],
    'omarchy plugin list',
  );
  return parsePluginList(result.stdout);
}

async function setPluginEnabled(
  context: ServiceAdapterContext,
  omarchyPath: string,
  enabled: boolean,
): Promise<void> {
  await runRequired(
    context,
    omarchyPath,
    ['plugin', enabled ? 'enable' : 'disable', OMARCHY_PLUGIN_ID],
    `omarchy plugin ${enabled ? 'enable' : 'disable'}`,
  );
}

async function rescan(context: ServiceAdapterContext, omarchyShellPath: string): Promise<void> {
  await runRequired(
    context,
    omarchyShellPath,
    ['shell', 'rescanPlugins'],
    'omarchy-shell rescanPlugins',
  );
}

function parseBarWidgetLayout(stdout: string): BarWidgetLayout | null {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_SHELL_CONFIG_BYTES) {
    throw new Error('omarchy-shell listShellConfig exceeded the supported size limit');
  }
  let config: unknown;
  try {
    config = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error('omarchy-shell listShellConfig returned invalid JSON', { cause: error });
  }
  const bar = isRecord(config) ? config.bar : null;
  const layout = isRecord(bar) ? bar.layout : null;
  if (!isRecord(layout)) {
    throw new Error('omarchy-shell listShellConfig returned an incompatible bar layout');
  }
  const matches: BarWidgetLayout[] = [];
  for (const section of ['left', 'center', 'right'] as const) {
    const entries = layout[section];
    if (!Array.isArray(entries) || entries.length > MAX_BAR_ENTRIES_PER_SECTION) {
      throw new Error('omarchy-shell listShellConfig returned an incompatible bar layout');
    }
    for (const [index, entry] of entries.entries()) {
      const id = isRecord(entry) ? entry.id : entry;
      if (id !== OMARCHY_PLUGIN_ID) continue;
      if (!isRecord(entry)) {
        throw new Error('Pimpampum bar widget layout entry must be an object');
      }
      if (
        Object.keys(entry).length > MAX_WIDGET_SETTINGS ||
        Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_WIDGET_ENTRY_BYTES
      ) {
        throw new Error('Pimpampum bar widget layout entry exceeded the supported size limit');
      }
      matches.push({ section, index, entry });
    }
  }
  if (matches.length > 1) {
    throw new Error('Pimpampum bar widget has multiple unsupported layout entries');
  }
  return matches[0] ?? null;
}

async function readBarWidgetLayout(
  context: ServiceAdapterContext,
  omarchyShellPath: string,
): Promise<BarWidgetLayout | null> {
  const result = await runRequired(
    context,
    omarchyShellPath,
    ['shell', 'listShellConfig'],
    'omarchy-shell listShellConfig',
  );
  return parseBarWidgetLayout(result.stdout);
}

async function runShellMutation(
  context: ServiceAdapterContext,
  omarchyShellPath: string,
  arguments_: string[],
  label: string,
): Promise<void> {
  const result = await runRequired(context, omarchyShellPath, ['shell', ...arguments_], label);
  if (result.stdout.trim() !== 'ok') {
    throw new Error(`${label} returned ${JSON.stringify(result.stdout.trim() || 'no result')}`);
  }
}

async function restoreWidgetPlacementWhenReady(
  context: ServiceAdapterContext,
  omarchyShellPath: string,
  selector: string,
): Promise<void> {
  const arguments_ = ['shell', 'enablePlugin', OMARCHY_PLUGIN_ID, selector];
  const deadline = Date.now() + WIDGET_READINESS_DEADLINE_MS;
  let delay = WIDGET_READINESS_INITIAL_DELAY_MS;
  while (Date.now() < deadline) {
    const result = await runRequired(
      context,
      omarchyShellPath,
      arguments_,
      'omarchy-shell restore Pimpampum widget placement',
    );
    const response = result.stdout.trim();
    if (response === 'ok') return;
    if (!RETRYABLE_WIDGET_ENABLE_RESULTS.has(response)) {
      throw new Error(
        `omarchy-shell restore Pimpampum widget placement returned ${JSON.stringify(response || 'no result')}`,
      );
    }
    if (response === 'unknown') {
      await rescan(context, omarchyShellPath);
    }
    const remaining = deadline - Date.now();
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, Math.max(0, Math.min(delay, remaining)));
    });
    delay = Math.min(delay * 2, WIDGET_READINESS_MAX_DELAY_MS);
  }
  throw new Error(
    `omarchy-shell did not rediscover ${OMARCHY_PLUGIN_ID} within ${WIDGET_READINESS_DEADLINE_MS}ms`,
  );
}

function sameBarWidgetLayout(left: BarWidgetLayout | null, right: BarWidgetLayout | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function restoreBarWidgetLayout(
  context: ServiceAdapterContext,
  omarchyShellPath: string,
  expected: BarWidgetLayout | null,
): Promise<void> {
  await rescan(context, omarchyShellPath);
  const current = await readBarWidgetLayout(context, omarchyShellPath);
  if (sameBarWidgetLayout(current, expected)) return;
  if (current) {
    await runShellMutation(
      context,
      omarchyShellPath,
      ['setPluginEnabled', OMARCHY_PLUGIN_ID, 'false'],
      'omarchy-shell disable Pimpampum widget for rollback',
    );
  }
  if (!expected) return;
  const selector = JSON.stringify({ section: expected.section, index: expected.index });
  await restoreWidgetPlacementWhenReady(context, omarchyShellPath, selector);
  for (const [key, value] of Object.entries(expected.entry)) {
    if (key === 'id') continue;
    await runShellMutation(
      context,
      omarchyShellPath,
      ['setBarWidget', OMARCHY_PLUGIN_ID, key, JSON.stringify(value), selector],
      `omarchy-shell restore Pimpampum widget setting ${key}`,
    );
  }
  const restored = await readBarWidgetLayout(context, omarchyShellPath);
  if (!sameBarWidgetLayout(restored, expected)) {
    throw new Error('omarchy-shell did not restore the exact Pimpampum bar widget layout');
  }
}

async function restorePluginState(
  context: ServiceAdapterContext,
  omarchyPath: string,
  omarchyShellPath: string,
  expected: PluginState,
): Promise<void> {
  await rescan(context, omarchyShellPath);
  const current = await readPluginState(context, omarchyPath);
  if (current.installed && current.enabled !== expected.enabled) {
    await setPluginEnabled(context, omarchyPath, expected.enabled);
  }
}

async function allOrAggregate(actions: Array<() => Promise<void>>, message: string): Promise<void> {
  const errors: Error[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(asError(error));
    }
  }
  if (errors.length === 1) throw errors[0]!;
  if (errors.length > 1) throw new AggregateError(errors, message);
}

async function prepareDaemonActivationRollback(
  adapter: PlatformServiceAdapter,
  context: ServiceAdapterContext,
  artifacts: ServiceArtifact[],
): Promise<AsyncRollback> {
  const prepared = await adapter.prepareDeactivationRollback?.(context, artifacts);
  if (prepared) return prepared;
  const wasRunning = await adapter.isRunning(context, artifacts);
  return async () => {
    if (adapter.rollbackActivation) await adapter.rollbackActivation(context, artifacts);
    else if (wasRunning) await adapter.activate(context, artifacts);
    else await adapter.deactivate(context, artifacts);
  };
}

export function createOmarchyAdapter(options: OmarchyAdapterOptions): PlatformServiceAdapter {
  if (options.daemonAdapter.platform !== 'linux') {
    throw new Error('Omarchy requires a Linux daemon adapter');
  }
  const sourceInput = requireAbsolute(options.pluginSourcePath, 'Omarchy plugin source');
  if (!existsSync(sourceInput) || !lstatSync(sourceInput).isDirectory()) {
    throw new Error('Omarchy plugin source must be an existing directory');
  }
  const sourceRoot = realpathSync(sourceInput);
  const omarchyPath = requireAbsolute(options.omarchyPath, 'Omarchy executable');
  const omarchyShellPath = requireAbsolute(options.omarchyShellPath, 'Omarchy shell executable');
  let lifecycle: LifecycleState | null = null;
  let pendingDaemonRestore: AsyncRollback | null = null;
  let removalBackup: string | null = null;

  return {
    id: 'systemd-omarchy-quattro',
    platform: 'linux',
    artifacts(context) {
      return [...options.daemonAdapter.artifacts(context), ...pluginArtifacts(sourceRoot, context)];
    },
    ownedArtifactRoots(context) {
      return [
        ...(options.daemonAdapter.ownedArtifactRoots?.(context) ?? []),
        pluginTarget(context),
      ];
    },
    async preflight(context, artifacts, operation) {
      await options.daemonAdapter.preflight?.(context, artifacts, operation);
      validateOwnedDestination(context);
      const version = await readOmarchyVersion(context, omarchyPath);
      if (!isCompatibleOmarchyVersion(version.stdout)) {
        throw new Error(`Unsupported Omarchy build: ${version.stdout.trim() || 'unknown'}`);
      }
      await runRequired(context, omarchyShellPath, ['shell', 'ping'], 'omarchy-shell ping');
      lifecycle = { ...(await readPluginState(context, omarchyPath)), enableChanged: false };
      if (operation === 'install') {
        await runRequired(
          context,
          omarchyPath,
          ['plugin', 'validate', sourceRoot],
          'omarchy plugin validate source',
        );
        await runRequired(
          context,
          omarchyPath,
          ['plugin', 'enable', '--help'],
          'omarchy plugin enable preflight',
        );
      } else {
        // Pinned Quattro IPC exposes the effective config through listShellConfig;
        // this verifies exact-layout rollback is available before manager writes.
        await readBarWidgetLayout(context, omarchyShellPath);
        await runRequired(
          context,
          omarchyPath,
          ['plugin', 'remove', '--help'],
          'omarchy plugin remove preflight',
        );
      }
    },
    async activate(context, artifacts) {
      const prior = lifecycle;
      if (!prior) throw new Error('Omarchy activation requires a completed preflight');
      pendingDaemonRestore = await prepareDaemonActivationRollback(
        options.daemonAdapter,
        context,
        artifacts,
      );
      try {
        await options.daemonAdapter.activate(context, artifacts);
      } catch (error) {
        pendingDaemonRestore = null;
        throw error;
      }
      try {
        await runRequired(
          context,
          omarchyPath,
          ['plugin', 'validate', pluginTarget(context)],
          'omarchy plugin validate installed candidate',
        );
        await rescan(context, omarchyShellPath);
        if (!prior.enabled) {
          await setPluginEnabled(context, omarchyPath, true);
          prior.enableChanged = true;
        }
      } catch (error) {
        const activationError = asError(error);
        const actions: Array<() => Promise<void>> = [];
        if (prior.enableChanged) {
          actions.push(() => setPluginEnabled(context, omarchyPath, false));
        }
        actions.push(() => rescan(context, omarchyShellPath));
        actions.push(() => options.daemonAdapter.deactivate(context, artifacts));
        try {
          await allOrAggregate(actions, 'Omarchy activation compensation failed');
        } catch (compensationError) {
          throw new AggregateError(
            [activationError, asError(compensationError)],
            'Omarchy activation and compensation failed',
          );
        }
        throw activationError;
      }
    },
    async rollbackActivation(context, artifacts) {
      const prior = lifecycle;
      await allOrAggregate(
        [
          ...(prior?.enableChanged
            ? [() => setPluginEnabled(context, omarchyPath, prior.enabled)]
            : []),
          () => rescan(context, omarchyShellPath),
          () => options.daemonAdapter.deactivate(context, artifacts),
        ],
        'Omarchy activation rollback failed',
      );
    },
    async afterRollback(context, artifacts) {
      const prior = lifecycle;
      const restoreDaemon = pendingDaemonRestore;
      pendingDaemonRestore = null;
      await allOrAggregate(
        [
          async () => {
            if (prior && !prior.installed) removeEmptyPluginDirectories(context);
            if (prior) await restorePluginState(context, omarchyPath, omarchyShellPath, prior);
          },
          ...(restoreDaemon ? [restoreDaemon] : []),
          ...(options.daemonAdapter.afterRollback
            ? [() => options.daemonAdapter.afterRollback!(context, artifacts)]
            : []),
        ],
        'Omarchy installation rollback restoration failed',
      );
    },
    async prepareDeactivationRollback(context, artifacts) {
      const prior = lifecycle ?? (await readPluginState(context, omarchyPath));
      const layout = await readBarWidgetLayout(context, omarchyShellPath);
      if (prior.enabled !== (layout !== null)) {
        throw new Error('Omarchy plugin state and Pimpampum bar layout are inconsistent');
      }
      const daemonWasRunning = await options.daemonAdapter.isRunning(context, artifacts);
      const daemonRollback = await options.daemonAdapter.prepareDeactivationRollback?.(
        context,
        artifacts,
      );
      return async () => {
        await allOrAggregate(
          [
            async () => {
              removalBackup = removeTrackedBackup(context, removalBackup);
            },
            () => restoreBarWidgetLayout(context, omarchyShellPath, layout),
            async () => {
              if (daemonRollback) await daemonRollback();
              else if (daemonWasRunning) await options.daemonAdapter.activate(context, artifacts);
            },
          ],
          'Omarchy uninstallation rollback failed',
        );
      };
    },
    async deactivate(context, artifacts) {
      validateRemovalTree(context, artifacts);
      const backupsBefore = removalBackupNames(context);
      await options.daemonAdapter.deactivate(context, artifacts);
      const result = await context.runCommand(omarchyPath, [
        'plugin',
        'remove',
        OMARCHY_PLUGIN_ID,
        '--yes',
      ]);
      removalBackup = newRemovalBackup(context, backupsBefore);
      if (removalBackup) assertOwnedPluginDirectory(removalBackup, context);
      validateReportedRemovalBackup(context, backupsBefore, result.stdout, removalBackup);
      if (result.exitCode !== 0) throw commandError('omarchy plugin remove', result);
      if (!removalBackup) {
        throw new Error('omarchy plugin remove did not report its owned backup');
      }
    },
    async afterUninstall(context, artifacts) {
      removalBackup = removeTrackedBackup(context, removalBackup);
      removeEmptyPluginDirectories(context);
      await options.daemonAdapter.afterUninstall?.(context, artifacts);
    },
    async isRunning(context, artifacts) {
      return options.daemonAdapter.isRunning(context, artifacts);
    },
    async afterInstall(context) {
      return pluginIntegration(await readPluginState(context, omarchyPath));
    },
    async integrationStatus(context) {
      return pluginIntegration(await readPluginState(context, omarchyPath));
    },
  };
}
