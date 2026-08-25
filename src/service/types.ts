export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (executable: string, arguments_: string[]) => Promise<CommandResult>;

export type SupportedServicePlatform = 'darwin' | 'linux';

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
}

export interface PlatformServiceAdapter {
  readonly id: string;
  readonly platform: SupportedServicePlatform;
  artifacts(context: ServiceAdapterContext): ServiceArtifact[];
  activate(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  deactivate(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
  isRunning(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<boolean>;
  afterRollback?(context: ServiceAdapterContext, artifacts: ServiceArtifact[]): Promise<void>;
}

export interface InstallResult {
  installed: true;
  reconciled: boolean;
  receiptPath: string;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  adapter: string | null;
  version: string | null;
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
}

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
