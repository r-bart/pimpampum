export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Per-call bounds a caller may ask of the command runner. Every field is optional and the runner
 * keeps its own defaults for the rest, so a runner built with fixed bounds is still a `RunCommand`.
 */
export interface RunCommandOptions {
  /** Wall-clock limit before the runner stops the child. */
  timeoutMilliseconds?: number;
}

export type RunCommand = (
  executable: string,
  arguments_: string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

export type SupportedServicePlatform = 'darwin' | 'linux';

export type PackagedRuntimeTarget = 'darwin-arm64' | 'linux-arm64' | 'linux-x64';

export interface PackagedRuntimeMetadata {
  version: string;
  target: PackagedRuntimeTarget;
  runtimeDirectory: string;
}

/**
 * What an operation may know about an owned file without holding its bytes. Status reads this shape
 * straight from the install receipt, so nothing in that path can reach for content that was never
 * planned. Every `ServiceArtifact` is also a valid reference.
 */
export interface ServiceArtifactRef {
  path: string;
  mode: number;
}

export interface ServiceArtifact extends ServiceArtifactRef {
  content: string | Buffer;
}

export interface ServiceAdapterContext {
  homeDirectory: string;
  dataDirectory: string;
  nodePath: string;
  cliPath: string;
  version: string;
  host: string;
  port: number;
  logDirectory: string;
  runCommand: RunCommand;
  packagedRuntime?: PackagedRuntimeMetadata;
}

export interface PlatformServiceAdapter {
  readonly id: string;
  readonly platform: SupportedServicePlatform;
  artifacts(context: ServiceAdapterContext): ServiceArtifact[];
  /**
   * Whether `artifacts` can be planned right now. An adapter that reads an installation source
   * it does not always have — the macOS app bundle lives in the build tree, never in the
   * installed runtime — reports false so status verifies its receipt instead of throwing.
   */
  canPlanArtifacts?(context: ServiceAdapterContext): boolean;
  ownedArtifactRoots?(context: ServiceAdapterContext): string[];
  preflight?(
    context: ServiceAdapterContext,
    artifacts: ServiceArtifact[],
    operation: 'install' | 'uninstall',
  ): Promise<void>;
  activate(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  deactivate(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  prepareDeactivationRollback?(
    context: ServiceAdapterContext,
    artifacts: ServiceArtifact[],
  ): Promise<() => Promise<void>>;
  isRunning(context: ServiceAdapterContext, artifacts: ServiceArtifactRef[]): Promise<boolean>;
  afterInstall?(
    context: ServiceAdapterContext,
    artifacts: ServiceArtifact[],
  ): Promise<ServiceIntegrationStatus | undefined>;
  afterRollback?(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  rollbackActivation?(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  /**
   * Final cleanup once the owned files are gone. An adapter that had to leave part of the teardown
   * to the user — a login item whose helper app is already gone — reports it through the outcome,
   * and the manager forwards it as `UninstallResult.manualInstructions`.
   */
  afterUninstall?(
    context: ServiceAdapterContext,
    artifacts: ServiceArtifact[],
  ): Promise<void | ServiceUninstallOutcome>;
  integrationStatus?(
    context: ServiceAdapterContext,
    artifacts: ServiceArtifactRef[],
  ): Promise<ServiceIntegrationStatus | undefined>;
}

export interface ServiceIntegrationStatus {
  loginItem?: 'enabled' | 'requiresApproval' | 'error';
  omarchyPlugin?: 'enabled' | 'disabled' | 'missing';
}

/** What the uninstall could not finish on the user's behalf. */
export interface ServiceUninstallOutcome {
  manualInstructions?: string[];
}

export interface InstallResult {
  installed: true;
  reconciled: boolean;
  receiptPath: string;
  loginItem?: 'enabled' | 'requiresApproval' | 'error';
  omarchyPlugin?: 'enabled' | 'disabled' | 'missing';
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  adapter: string | null;
  version: string | null;
  loginItem?: 'enabled' | 'requiresApproval' | 'error';
  omarchyPlugin?: 'enabled' | 'disabled' | 'missing';
}

export interface UninstallResult {
  uninstalled: boolean;
  dataPreserved: true;
  manualInstructions?: string[];
}

export interface PreparedServiceUninstall {
  commit(): Promise<UninstallResult>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface ServiceManager {
  install(): Promise<InstallResult>;
  status(): Promise<ServiceStatus>;
  prepareUninstall?(): Promise<PreparedServiceUninstall | null>;
  uninstall(): Promise<UninstallResult>;
}

export interface PlatformServiceManagerInput {
  platform: NodeJS.Platform;
  homeDirectory: string;
  dataDirectory: string;
  nodePath: string;
  cliPath: string;
  version: string;
  runCommand: RunCommand;
  host?: string;
  port?: number;
  logDirectory?: string;
  adapters?: Partial<Record<SupportedServicePlatform, PlatformServiceAdapter>>;
  receiptAdapters?: Record<string, PlatformServiceAdapter>;
  packagedRuntime?: PackagedRuntimeMetadata;
  postActivationVerifier?: PostActivationVerifier;
}

export interface ServiceActivationVerification {
  context: Readonly<ServiceAdapterContext>;
  receipt: Readonly<InstallReceipt>;
  previousReceipt: Readonly<InstallReceipt> | null;
  reconciled: boolean;
  packagedRuntime?: Readonly<PackagedRuntimeMetadata>;
}

export type PostActivationVerifier = (verification: ServiceActivationVerification) => Promise<void>;

export interface ReceiptArtifact {
  path: string;
  sha256: string;
  mode: number;
}

export interface InstallReceipt {
  schemaVersion: 1;
  adapter: string;
  platform: SupportedServicePlatform;
  version: string;
  installationKey: string;
  installedAt: string;
  nodePath: string;
  cliPath: string;
  dataDirectory: string;
  baseUrl: string;
  logDirectory: string;
  artifacts: ReceiptArtifact[];
  updateProvider?: 'legacy-npm' | 'packaged-release';
  packagedRuntime?: PackagedRuntimeMetadata;
}

export interface InstallReceiptFileSnapshot {
  receipt: InstallReceipt;
  contents: Buffer;
}
