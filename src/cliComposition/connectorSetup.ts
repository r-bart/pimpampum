/**
 * The agent connectors and the guided setup over them. Connectors are built once per process from
 * the runtime layout's launcher; `connect`, `repair` and `disconnect` reach them through the
 * connections runtime, and `setup apply` drives them through the coordinator adapter below.
 */
import { join, resolve } from 'node:path';
import { createCliSetupRuntime, type CliSetupRuntime } from '../cliProgram.js';
import { createClaudeCodeConnector } from '../connectors/claudeCode.js';
import { createCodexConnector } from '../connectors/codex.js';
import { fingerprintCommand } from '../connectors/receipt.js';
import { createConnectorRegistry } from '../connectors/registry.js';
import type {
  ConnectorId,
  ConnectorInspection,
  ConnectorSnapshot,
  HostConnector,
} from '../connectors/types.js';
import type { PackagedRuntimeBootstrap } from '../runtime/bootstrap.js';
import {
  pruneOwnedRuntimeVersions,
  type RuntimeInstallationTransaction,
} from '../runtime/installer.js';
import type { RuntimeLayout } from '../runtime/types.js';
import { keepPreviousRuntime, packagedCliSmoke } from '../service/packagedLifecycle.js';
import type { InstallResult, RunCommand, ServiceManager } from '../service/types.js';
import { createSetupCoordinator, type SetupCoordinatorDependencies } from '../setup/coordinator.js';
import {
  createSetupLifecycleLock,
  createSetupPlanStore,
  createSetupStateStore,
} from '../setup/state.js';
import { createConnectionReceiptStore, type ConnectionReceiptStore } from './connectionReceipts.js';
import type { SupportedRuntimeTarget } from './host.js';

/** The tools a connected host must be able to reach for the connection to count as verified. */
const REQUIRED_TOOLS = ['project_list', 'work_start'];

export interface HostConnectorSet {
  /** In registry order, which is the order every list and plan presents them. */
  ordered: HostConnector[];
  receiptStores: ReadonlyMap<ConnectorId, ConnectionReceiptStore>;
  launcherPath: string;
}

export function createHostConnectors(input: {
  homeDirectory: string;
  dataDirectory: string;
  launcherPath: string;
  pathValue: string;
  cwd: string;
}): HostConnectorSet {
  const boundedLocations = [
    join(input.homeDirectory, '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const codexReceipt = createConnectionReceiptStore(input.dataDirectory, 'codex');
  const claudeReceipt = createConnectionReceiptStore(input.dataDirectory, 'claude-code');
  const codex = createCodexConnector({
    launcherPath: input.launcherPath,
    boundedLocations: [...boundedLocations, '/Applications/Codex.app/Contents/Resources'],
    path: input.pathValue,
    requiredTools: [...REQUIRED_TOOLS],
    receipt: codexReceipt,
  });
  const claudeCode = createClaudeCodeConnector({
    launcherPath: input.launcherPath,
    userConfigPath: join(input.homeDirectory, '.claude.json'),
    boundedExecutableLocations: boundedLocations,
    pathValue: input.pathValue,
    higherPrecedenceConfigSources: [{ path: resolve(input.cwd, '.mcp.json'), scope: 'project' }],
    requiredTools: REQUIRED_TOOLS,
    receiptStore: claudeReceipt,
  });
  const byId = new Map<ConnectorId, HostConnector>([
    ['codex', codex],
    ['claude-code', claudeCode],
  ]);
  return {
    ordered: createConnectorRegistry().map(({ id }) => byId.get(id)!),
    receiptStores: new Map<ConnectorId, ConnectionReceiptStore>([
      ['codex', codexReceipt],
      ['claude-code', claudeReceipt],
    ]),
    launcherPath: input.launcherPath,
  };
}

type SetupConnectors = SetupCoordinatorDependencies['connectors'];
type SetupConnector = SetupConnectors[keyof SetupConnectors];

/** What the plan discloses about a conflicting entry: that it differs, and whether it can be put back. */
function conflictDisclosure(
  inspected: ConnectorInspection,
): Partial<
  Pick<
    Awaited<ReturnType<SetupConnector['inspect']>>,
    'comparison' | 'revision' | 'replacementSupported'
  >
> {
  if (inspected.state !== 'conflict') return {};
  return {
    comparison: 'An existing entry differs from the Pimpampum-owned launcher.',
    ...(inspected.entry === null
      ? {}
      : {
          revision: fingerprintCommand(inspected.entry),
          replacementSupported: inspected.entry.restorable !== false,
        }),
  };
}

/**
 * One connector as the setup coordinator sees it. The snapshot taken before `connect` is what
 * `restore` puts back, and `verify` reports whether the host needs a new session to see the entry.
 */
function setupConnectorAdapter(connector: HostConnector): SetupConnector {
  let snapshot: ConnectorSnapshot | null = null;
  let newSessionRequired = false;
  return {
    inspect: async () => {
      const inspected = await connector.inspect();
      return { state: inspected.state, ...conflictDisclosure(inspected) };
    },
    connect: async (input) => {
      const plan = await connector.plan(input);
      if (
        plan.state === 'conflict' &&
        (plan.conflictDecision !== 'replace' || plan.mutations.length === 0)
      ) {
        throw Object.assign(new Error('The existing connector entry requires a decision'), {
          code: 'CONNECTOR_CONFLICT',
        });
      }
      snapshot = await connector.snapshot();
      newSessionRequired = plan.newSessionRequired;
      await connector.connect(plan);
    },
    verify: async () => ({ available: (await connector.verify()).available, newSessionRequired }),
    restore: async () => {
      if (snapshot !== null) await connector.restore(snapshot);
    },
  };
}

export function createSetupConnectorAdapters(
  connectors: readonly HostConnector[],
): SetupConnectors {
  return Object.fromEntries(
    connectors.map((connector) => [connector.id, setupConnectorAdapter(connector)]),
  ) as SetupConnectors;
}

function loginItemOutcome(
  install: InstallResult | null,
): 'enabled' | 'requires-approval' | 'denied' {
  if (install?.loginItem === 'requiresApproval') return 'requires-approval';
  return install?.loginItem === 'error' ? 'denied' : 'enabled';
}

export interface GuidedSetupInput {
  dataDirectory: string;
  homeDirectory: string;
  version: string;
  target: SupportedRuntimeTarget;
  layout: RuntimeLayout;
  /** `null` on an npm install, which has no private runtime to activate. */
  bootstrap: PackagedRuntimeBootstrap | null;
  runCommand: RunCommand;
  serviceManager: Pick<ServiceManager, 'install'>;
  servicePath: string;
  connectors: HostConnectorSet;
  now?: () => string;
}

const nothing = async (): Promise<void> => undefined;

/**
 * The guided setup the desktop app drives. The runtime transaction opened by `runtime.install` is
 * committed only when the login item registers, the last phase, so any earlier failure still finds
 * it open to roll back.
 */
export function createGuidedSetup(input: GuidedSetupInput): CliSetupRuntime {
  const stateStore = createSetupStateStore(input.dataDirectory);
  const ownedRuntime = {
    homeDirectory: input.homeDirectory,
    dataDirectory: input.dataDirectory,
    platform: input.target.platform,
    architecture: input.target.architecture,
  };
  let lastInstall: InstallResult | null = null;
  let runtimeTransaction: RuntimeInstallationTransaction | null = null;
  const commitRuntime = (): void => {
    if (runtimeTransaction === null) return;
    pruneOwnedRuntimeVersions({
      ...ownedRuntime,
      ...keepPreviousRuntime(runtimeTransaction.installation.previousVersion),
    });
    runtimeTransaction.commit();
    runtimeTransaction = null;
  };
  const coordinator = createSetupCoordinator({
    lifecycleLock: createSetupLifecycleLock(input.dataDirectory),
    changeTargets: {
      runtimeDirectory: input.layout.runtimeDirectory,
      servicePath: input.servicePath,
      dataDirectory: input.dataDirectory,
      connectorConfigPaths: {
        codex: join(input.homeDirectory, '.codex', 'config.toml'),
        'claude-code': join(input.homeDirectory, '.claude.json'),
      },
    },
    runtime: {
      install: async () => {
        if (input.bootstrap === null) return { version: input.version };
        runtimeTransaction = await input.bootstrap.prepareInstallation(
          packagedCliSmoke(input.runCommand, {
            failure: 'Packaged runtime CLI smoke failed',
            expectedVersion: input.version,
          }),
        );
        return { version: runtimeTransaction.installation.version };
      },
      rollback: async () => {
        runtimeTransaction?.rollback();
        runtimeTransaction = null;
      },
    },
    service: {
      install: async () => {
        lastInstall = await input.serviceManager.install();
      },
      // The manager's post-activation verifier completed inside service.install's rollback
      // boundary; the explicit phase keeps the durable progress ordering. Service installation
      // has its own receipt-backed rollback transaction, so there is nothing more to undo here.
      verify: nothing,
      rollback: nothing,
    },
    connectors: createSetupConnectorAdapters(input.connectors.ordered),
    loginItem: {
      register: async () => {
        commitRuntime();
        return loginItemOutcome(lastInstall);
      },
    },
    dataDirectory: input.dataDirectory,
    now: input.now ?? (() => new Date().toISOString()),
    stateStore,
    planStore: createSetupPlanStore(input.dataDirectory),
  });
  return createCliSetupRuntime(coordinator, stateStore);
}
