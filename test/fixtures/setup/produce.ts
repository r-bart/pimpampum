import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createCliSetupRuntime, runCli, type CliRuntime } from '../../../src/cliProgram.js';
import { createSetupCoordinator } from '../../../src/setup/coordinator.js';
import { createSetupPlanStore, createSetupStateStore } from '../../../src/setup/state.js';
import type { SetupPlan, SetupPlanStore, SetupStateStore } from '../../../src/setup/types.js';

/**
 * The producer behind `test/fixtures/setup/*.json`. `scripts/regenerate-fixtures.mjs` writes the
 * files from here and `test/setup-envelope-shape.test.ts` regenerates them in-test and compares
 * bytes, so the fixture can never drift from what `pimpampum setup plan` prints again.
 *
 * The plan comes from the real `createSetupCoordinator` behind the real `runCli` boundary. Only
 * the boundaries the coordinator would call during `apply` are fakes, and `plan` never calls them.
 */

/** The home directory every fixture path is expressed against. */
export const FIXTURE_HOME = '/Users/example';
/** The operation id substituted for the random one; the revision is recomputed for it. */
export const FIXTURE_OPERATION_ID = '6c5bd965-8f55-455f-84f8-64aa3eb5693c';
const FIXTURE_NOW = '2026-09-02T09:00:00.000Z';

/** The change targets the macOS composition in `src/cliMain.ts` derives from a home directory. */
export function macosChangeTargets(homeDirectory: string) {
  const applicationSupport = join(homeDirectory, 'Library', 'Application Support', 'Pimpampum');
  return {
    runtimeDirectory: join(applicationSupport, 'Runtime'),
    servicePath: join(homeDirectory, 'Library', 'LaunchAgents', 'dev.pimpampum.daemon.plist'),
    dataDirectory: join(homeDirectory, '.pimpampum'),
    connectorConfigPaths: {
      codex: join(homeDirectory, '.codex', 'config.toml'),
      'claude-code': join(homeDirectory, '.claude.json'),
    },
  };
}

export interface SetupCli {
  runtime: CliRuntime;
  stateStore: SetupStateStore;
  planStore: SetupPlanStore;
  /** Every stdout chunk `runCli` printed, one envelope (or one NDJSON event) per entry. */
  stdout: string[];
  stderr: string[];
  exits: number[];
}

/**
 * A CLI whose `setup` verbs reach a real coordinator journaling into `<root>/data`. Runtime,
 * service, login item and both connectors are boundary fakes that succeed.
 */
export function createSetupCli(root: string): SetupCli {
  const dataDirectory = join(root, 'data');
  const stateStore = createSetupStateStore(dataDirectory);
  const planStore = createSetupPlanStore(dataDirectory);
  const connector = () => ({
    inspect: async () => ({ state: 'notConnected' }),
    connect: async () => undefined,
    verify: async () => ({ available: true, newSessionRequired: false }),
    restore: async () => undefined,
  });
  const coordinator = createSetupCoordinator({
    lifecycleLock: { run: async <T>(operation: () => Promise<T>) => operation() },
    changeTargets: macosChangeTargets(FIXTURE_HOME),
    runtime: { install: async () => ({ version: '2.0.0' }), rollback: async () => undefined },
    service: {
      install: async () => undefined,
      verify: async () => undefined,
      rollback: async () => undefined,
    },
    connectors: { codex: connector(), 'claude-code': connector() },
    loginItem: { register: async () => 'enabled' as const },
    dataDirectory,
    now: () => FIXTURE_NOW,
    stateStore,
    planStore,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exits: number[] = [];
  const runtime = {
    setup: createCliSetupRuntime(coordinator, stateStore),
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
    exit: (code: number) => {
      exits.push(code);
      return undefined as never;
    },
  } as unknown as CliRuntime;
  return { runtime, stateStore, planStore, stdout, stderr, exits };
}

/** `src/setup/coordinator.ts` derives the revision from the plan without it, in key order. */
export function planRevision(plan: Omit<SetupPlan, 'revision'>): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export interface ProducedEnvelope {
  /** The exact bytes the CLI printed. */
  raw: string;
  /** The bytes with the random operation id replaced and the revision recomputed. */
  normalized: string;
}

/** `pimpampum setup plan` with no connector selected, as the fixture records it. */
export async function producePlanEnvelope(
  root: string,
): Promise<ProducedEnvelope & { plan: SetupPlan }> {
  const cli = createSetupCli(root);
  await runCli(['setup', 'plan'], cli.runtime);
  if (cli.stderr.length > 0 || cli.stdout.length !== 1) {
    throw new Error(`setup plan did not print one envelope: ${JSON.stringify(cli)}`);
  }
  const raw = cli.stdout[0] as string;
  const envelope = JSON.parse(raw) as { data: SetupPlan };
  const { revision: _revision, ...withoutRevision } = {
    ...envelope.data,
    operationId: FIXTURE_OPERATION_ID,
  };
  const normalizedPlan: SetupPlan = { ...withoutRevision, revision: planRevision(withoutRevision) };
  return {
    raw,
    normalized: `${JSON.stringify({ data: normalizedPlan }, null, 2)}\n`,
    plan: envelope.data,
  };
}

/** `pimpampum setup status` before any setup ran: the `null` journal the decoder maps to idle. */
export async function produceEmptyJournalEnvelope(root: string): Promise<ProducedEnvelope> {
  const cli = createSetupCli(root);
  await runCli(['setup', 'status'], cli.runtime);
  if (cli.stderr.length > 0 || cli.stdout.length !== 1) {
    throw new Error(`setup status did not print one envelope: ${JSON.stringify(cli)}`);
  }
  const raw = cli.stdout[0] as string;
  return { raw, normalized: raw };
}
