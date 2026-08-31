export type RuntimePlatform = 'darwin' | 'linux';

export type RuntimeArchitecture = 'arm64' | 'x64';

export type RuntimeTarget =
  | { platform: 'darwin'; architecture: 'arm64' }
  | { platform: 'linux'; architecture: RuntimeArchitecture };

export type RuntimeTargetId = 'darwin-arm64' | 'linux-arm64' | 'linux-x64';

export interface RuntimeManifestFile {
  path: string;
  sha256: string;
  mode: number;
  size: number;
}

export interface RuntimeEntrypoints {
  node: string;
  cli: string;
  mcp: string;
}

export interface RuntimeManifest {
  schemaVersion: 1;
  pimpampumVersion: string;
  nodeVersion: string;
  target: RuntimeTarget;
  unpackedBytes: number;
  entrypoints: RuntimeEntrypoints;
  files: RuntimeManifestFile[];
}

export interface ParseRuntimeManifestOptions {
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  maximumUnpackedBytes: number;
}

export interface RuntimeLayoutInput {
  homeDirectory: string;
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  version: string;
}

export interface RuntimeLayout {
  target: RuntimeTarget;
  targetId: RuntimeTargetId;
  dataDirectory: string;
  logDirectory: string;
  runtimeDirectory: string;
  versionsDirectory: string;
  versionDirectory: string;
  launchersDirectory: string;
  controlLauncherPath: string;
  mcpLauncherPath: string;
  applicationDirectory: string;
  pluginDirectory: string;
}

export interface RuntimeInstallation {
  activated: boolean;
  version: string;
  nodePath: string;
  cliPath: string;
  mcpLauncherPath: string;
  previousVersion: string | null;
}

export interface RuntimeLauncherInput {
  nodePath: string;
  cliPath: string;
  mcpPath: string;
}

export interface RuntimeLaunchers {
  control: string;
  mcp: string;
}

export interface RuntimeOwnedVersion {
  version: string;
  targetId: RuntimeTargetId;
  directory: string;
}

export interface RuntimeInstallReceipt {
  schemaVersion: 1;
  currentVersion: string;
  targetId: RuntimeTargetId;
  nodePath: string;
  cliPath: string;
  mcpPath: string;
  controlLauncherPath: string;
  controlLauncherSha256: string;
  mcpLauncherPath: string;
  mcpLauncherSha256: string;
  ownedVersions: RuntimeOwnedVersion[];
}
