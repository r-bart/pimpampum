import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandInvocation } from '../../../src/connectors/types.js';

/**
 * Reads the recorded connector fixtures and turns them into the `run` stub the connector tests
 * inject. The recorded `--version` and `--help` output answer the feature probes exactly as the
 * real CLIs printed them; the JSON and text outputs of `mcp get`/`mcp list` come from the scenario
 * a test selects in `scenarios.json`. See `README.md` for what is recorded and what is synthetic.
 */

export type ConnectorFixtureHost = 'codex' | 'claude-code';

export interface CommandOutputFixture {
  exitCode: number;
  stdoutFixture?: string;
  stderrFixture?: string;
}

export interface ProbeFixture {
  arguments: string[];
  helpFixture: string;
  token: string;
  supported: boolean;
}

export interface CapabilitiesFixture {
  fixtureVersion: number;
  observedCliVersion: string;
  observedOn: string;
  versionFixture: string;
  probes: Record<string, ProbeFixture>;
  expectedDetection: {
    version: string;
    supported: boolean;
    capabilities: { inspect: string; add: boolean; remove: boolean; scopes: string[] };
  };
}

export interface ScenarioFixture {
  expectedState?: string;
  expectedError?: string;
  receipt?: 'none' | 'matching';
  processFixture?: string;
  targetEntryFixture?: string | null;
  scopeFixture?: string;
  mutationFailure?: string;
  revisionFixture?: string;
  getResult?: CommandOutputFixture;
  listResult?: CommandOutputFixture;
}

export interface ScenariosFixture {
  fixtureVersion: number;
  observedCliVersion: string;
  launcherPath: string;
  scenarios: Record<string, ScenarioFixture>;
}

export interface ProcessFailureFixture {
  exitCode: number;
  stdout: string;
  stderr: string;
  mutationCommitted: boolean;
}

export interface HostCommandResultLike {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal: null;
}

const fixtureRoot = import.meta.dirname;

export function connectorFixturePath(host: ConnectorFixtureHost, name: string): string {
  return join(fixtureRoot, host, name);
}

export function readConnectorFixture(host: ConnectorFixtureHost, name: string): string {
  return readFileSync(connectorFixturePath(host, name), 'utf8');
}

export function readConnectorJson<T>(host: ConnectorFixtureHost, name: string): T {
  return JSON.parse(readConnectorFixture(host, name)) as T;
}

export function loadCapabilities(host: ConnectorFixtureHost): CapabilitiesFixture {
  return readConnectorJson<CapabilitiesFixture>(host, 'capabilities.json');
}

export function loadScenarios(host: ConnectorFixtureHost): ScenariosFixture {
  return readConnectorJson<ScenariosFixture>(host, 'scenarios.json');
}

/** Materialises a recorded exit code plus stdout/stderr text into a command result. */
export function resolveOutput(
  host: ConnectorFixtureHost,
  output: CommandOutputFixture,
): HostCommandResultLike {
  return {
    exitCode: output.exitCode,
    stdout:
      output.stdoutFixture === undefined ? '' : readConnectorFixture(host, output.stdoutFixture),
    stderr:
      output.stderrFixture === undefined ? '' : readConnectorFixture(host, output.stderrFixture),
    signal: null,
  };
}

export function success(): HostCommandResultLike {
  return { exitCode: 0, stdout: '', stderr: '', signal: null };
}

export interface FixtureRunOptions {
  /** Answer for `codex mcp get pimpampum --json`; a function is asked on every call. */
  getResult?: CommandOutputFixture | (() => CommandOutputFixture);
  /** Answer for `codex mcp list --json`. */
  listResult?: CommandOutputFixture;
  /** A `shared/*.json` process failure every `add`/`remove` returns. */
  mutationFailure?: string;
  /** Applies a successful `add`/`remove` to the fake host; return a result to override success. */
  onMutation?: (arguments_: string[]) => HostCommandResultLike | undefined;
}

function isMutation(host: ConnectorFixtureHost, arguments_: string[]): boolean {
  if (arguments_[0] !== 'mcp') return false;
  const verb = arguments_[1];
  return host === 'codex'
    ? verb === 'add' || verb === 'remove'
    : verb === 'add-json' || verb === 'remove';
}

/**
 * The `run` stub for `host`: `--version` and every `--help` probe answer with the recorded text,
 * inspection answers with the selected scenario output, mutations go to `onMutation` or fail with
 * the selected process fixture. Any other invocation throws, so a new probe cannot pass unnoticed.
 */
export function createFixtureRun(
  host: ConnectorFixtureHost,
  options: FixtureRunOptions = {},
): (invocation: CommandInvocation) => Promise<HostCommandResultLike> {
  const capabilities = loadCapabilities(host);
  const version = readConnectorFixture(host, capabilities.versionFixture);
  const probes = Object.values(capabilities.probes);
  return async (invocation) => {
    const arguments_ = invocation.arguments;
    if (arguments_[0] === '--version')
      return { exitCode: 0, stdout: version, stderr: '', signal: null };
    if (arguments_.at(-1) === '--help') {
      const probe = probes.find(
        (candidate) => JSON.stringify(candidate.arguments) === JSON.stringify(arguments_),
      );
      if (probe === undefined) throw new Error(`unrecorded ${host} probe: ${arguments_.join(' ')}`);
      return {
        exitCode: 0,
        stdout: readConnectorFixture(host, probe.helpFixture),
        stderr: '',
        signal: null,
      };
    }
    if (host === 'codex' && arguments_.join(' ') === 'mcp get pimpampum --json') {
      const output =
        typeof options.getResult === 'function' ? options.getResult() : options.getResult;
      if (output === undefined) throw new Error('scenario has no `codex mcp get` output');
      return resolveOutput(host, output);
    }
    if (host === 'codex' && arguments_.join(' ') === 'mcp list --json') {
      if (options.listResult === undefined)
        throw new Error('scenario has no `codex mcp list` output');
      return resolveOutput(host, options.listResult);
    }
    if (isMutation(host, arguments_)) {
      if (options.mutationFailure !== undefined) {
        const failure = readConnectorJson<ProcessFailureFixture>(host, options.mutationFailure);
        return {
          exitCode: failure.exitCode,
          stdout: failure.stdout,
          stderr: failure.stderr,
          signal: null,
        };
      }
      return options.onMutation?.(arguments_) ?? success();
    }
    throw new Error(`unexpected ${host} invocation: ${arguments_.join(' ')}`);
  };
}
