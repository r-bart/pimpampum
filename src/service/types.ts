export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (executable: string, arguments_: string[]) => Promise<CommandResult>;

export type SupportedServicePlatform = 'darwin' | 'linux';

export type PackagedRuntimeTarget = 'darwin-arm64' | 'linux-arm64' | 'linux-x64';

export interface PackagedRuntimeMetadata {
  version: string;
  target: PackagedRuntimeTarget;
  runtimeDirectory: string;
}

export interface ServiceArtifact {
  path: string;
  content: string | Buffer;
  mode: number;
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
  isRunning(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<boolean>;
  afterInstall?(
    context: ServiceAdapterContext,
    artifacts: ServiceArtifact[],
  ): Promise<ServiceIntegrationStatus | undefined>;
  afterRollback?(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  rollbackActivation?(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  afterUninstall?(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  integrationStatus?(
    context: ServiceAdapterContext,
    artifacts: ServiceArtifact[],
  ): Promise<ServiceIntegrationStatus | undefined>;
}

export interface ServiceIntegrationStatus {
  loginItem?: 'enabled' | 'requiresApproval' | 'error';
  omarchyPlugin?: 'enabled' | 'disabled' | 'missing';
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
}

export interface ServiceManager {
  install(): Promise<InstallResult>;
  status(): Promise<ServiceStatus>;
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
}
