import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentCliClient } from './agentClient.js';
import { createHttpClient } from './client.js';
import {
  createCliConnectionsRuntime,
  createCliSetupRuntime,
  MAX_AGENT_INPUT_BYTES,
  runCli,
} from './cliProgram.js';
import { loadConfig } from './config.js';
import { createClaudeCodeConnector } from './connectors/claudeCode.js';
import { createCodexConnector } from './connectors/codex.js';
import {
  configurationRevision,
  readHostConfiguration,
  replaceHostConfigurationEntry,
} from './connectors/process.js';
import { createConnectorRegistry } from './connectors/registry.js';
import { fingerprintCommand } from './connectors/receipt.js';
import type {
  ConnectionReceipt,
  ConnectorId,
  ConnectorSnapshot,
  HostConnector,
} from './connectors/types.js';
import { AppError } from './errors.js';
import { createLaunchdAdapter } from './service/launchd.js';
import { createMacOSDesktopAdapter } from './service/macosApp.js';
import { createPlatformServiceManager } from './service/manager.js';
import { verifyServiceHealth } from './service/health.js';
import { createOmarchyAdapter, isCompatibleOmarchyVersion } from './service/omarchy.js';
import { findExecutable, runServiceCommand } from './service/platform.js';
import {
  installReceiptPath,
  readInstallReceipt,
  restoreInstallReceiptSnapshot,
  snapshotInstallReceipt,
} from './service/receipt.js';
import { createSystemdAdapter } from './service/systemd.js';
import type {
  InstallReceiptFileSnapshot,
  PackagedRuntimeMetadata,
  PlatformServiceManagerInput,
  PreparedServiceUninstall,
  RunCommand,
  ServiceManager,
} from './service/types.js';
import { startServer } from './server.js';
import { PIMPAMPUM_VERSION } from './version.js';
import {
  createUpdateManager,
  resolveNpmPath,
  type PackagedReleaseProviderInput,
  type PackagedReleaseTarget,
  type UpdateInstallReceiptMetadata,
  type UpdateManager,
} from './update.js';
import { resolveRuntimeLayout } from './runtime/layout.js';
import { parseRuntimeManifest } from './runtime/manifest.js';
import {
  installRuntimeTransaction,
  prepareOwnedRuntimeRemoval,
  pruneOwnedRuntimeVersions,
  type PreparedRuntimeRemoval,
  type RuntimeInstallationTransaction,
} from './runtime/installer.js';
import { resolvePackagedRuntimeBootstrap } from './runtime/bootstrap.js';
import { validateRuntimeArchiveFile } from './runtime/archive.js';
import { createInstallationLifecycle, createSetupCoordinator } from './setup/coordinator.js';
import {
  createSetupLifecycleLock,
  createSetupPlanStore,
  createSetupStateStore,
} from './setup/state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createHealthVerifiedServiceManager(
  input: PlatformServiceManagerInput,
  healthVerifier: typeof verifyServiceHealth = verifyServiceHealth,
): ServiceManager {
  return createPlatformServiceManager({
    ...input,
    postActivationVerifier: async ({ receipt }) => {
      // The service manager already holds its lifecycle lock here and has verified the exact
      // receipt. Re-entering manager.status() would deadlock against that same process-owned lock;
      // the versioned loopback health response is the authoritative running check.
      await healthVerifier({ baseUrl: receipt.baseUrl, version: receipt.version });
    },
  });
}

function parseConnectionReceipt(value: unknown, connectorId: ConnectorId): ConnectionReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.connectorId !== connectorId ||
    (value.scope !== 'user' && value.scope !== 'global') ||
    typeof value.commandFingerprint !== 'string' ||
    value.commandFingerprint.length === 0 ||
    value.commandFingerprint.length > 128 ||
    value.commandFingerprint.includes('\0') ||
    typeof value.configuredAt !== 'string' ||
    value.configuredAt.length === 0 ||
    value.configuredAt.length > 128 ||
    (value.lastVerifiedAt !== null && typeof value.lastVerifiedAt !== 'string')
  ) {
    throw new Error('Invalid private connector receipt');
  }
  const capabilities = value.capabilities;
  if (
    capabilities !== undefined &&
    (!Array.isArray(capabilities) ||
      capabilities.length > 32 ||
      capabilities.some(
        (capability) =>
          typeof capability !== 'string' ||
          capability.length === 0 ||
          capability.length > 128 ||
          capability.includes('\0'),
      ))
  ) {
    throw new Error('Invalid private connector receipt capabilities');
  }
  return {
    schemaVersion: 1,
    connectorId,
    scope: value.scope,
    commandFingerprint: value.commandFingerprint,
    configuredAt: value.configuredAt,
    lastVerifiedAt: value.lastVerifiedAt,
    ...(Array.isArray(capabilities) ? { capabilities: [...capabilities] as string[] } : {}),
  };
}

function assertSafeReceiptDirectory(path: string): boolean {
  try {
    const metadata = lstatSync(dirname(path));
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Private connector receipt directory must not be a symlink');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function createConnectionReceiptStore(dataDirectory: string, connectorId: ConnectorId) {
  const path = join(dataDirectory, 'connections', `${connectorId}.json`);
  return {
    async read(): Promise<ConnectionReceipt | null> {
      if (!assertSafeReceiptDirectory(path)) return null;
      try {
        return parseConnectionReceipt(readHostConfiguration(path).value, connectorId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(receipt: ConnectionReceipt): Promise<void> {
      assertSafeReceiptDirectory(path);
      let expectedRevision: string | null = null;
      try {
        expectedRevision = configurationRevision(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await replaceHostConfigurationEntry({
        path,
        expectedRevision,
        mode: 0o600,
        update: () => parseConnectionReceipt(receipt, connectorId),
      });
    },
    async remove(): Promise<void> {
      if (!assertSafeReceiptDirectory(path)) return;
      let metadata: ReturnType<typeof lstatSync>;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Private connector receipt must be a regular file and not a symlink');
      }
      unlinkSync(path);
    },
  };
}

function decodeToolInput(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new AppError('bad_request', 'Tool input must be valid UTF-8', 400);
  }
}

function inputTooLarge(maxBytes: number): AppError {
  return new AppError(
    'payload_too_large',
    `Tool input exceeds ${String(maxBytes)} UTF-8 bytes`,
    413,
  );
}

function readBoundedUtf8File(path: string, maxBytes: number): string {
  const descriptor = openSync(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1 - total));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
  } finally {
    closeSync(descriptor);
  }
  if (total > maxBytes) throw inputTooLarge(maxBytes);
  return decodeToolInput(Buffer.concat(chunks, total));
}

const DEFAULT_RELEASE_CHANNEL_URL =
  'https://github.com/r-bart/pimpampum/releases/download/update-channel-stable/release-manifest.json';
const MAX_RELEASE_KEY_BYTES = 16 * 1024;
const MAX_RELEASE_ARCHIVE_ENTRIES = 20_000;

export interface CliUpdateManagerInput {
  currentVersion: string;
  dataDirectory: string;
  homeDirectory: string;
  target: PackagedReleaseTarget | null;
  nodePath: string;
  runCommand: RunCommand;
  currentServiceManager: ServiceManager;
  createCandidateServiceManager(input: {
    appBundlePath: string;
    version: string;
    nodePath: string;
    cliPath: string;
    packagedRuntime: PackagedRuntimeMetadata;
  }): ServiceManager;
  npmPath?: string | null;
  channelManifestUrl?: string;
  publicKeyPath?: string;
  fetchImplementation?: typeof globalThis.fetch;
  packagedRelease?: PackagedReleaseProviderInput;
}

function pathInside(root: string, candidate: string): boolean {
  const child = relativePath(resolve(root), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertTrustedReleaseKey(path: string, allowedRoots: string[]): Buffer {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new Error('Release public key path must be absolute');
  }
  const root = allowedRoots.find((candidate) => pathInside(candidate, path));
  if (!root) throw new Error('Release public key is outside a Pimpampum-owned root');
  let current = resolve(root);
  const child = relativePath(current, resolve(path));
  for (const segment of child.split(sep).filter(Boolean)) {
    const metadata = lstatSync(current);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('Release public key path traverses an unsafe directory');
    }
    current = join(current, segment);
  }
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Release public key must be a regular file');
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid && metadata.uid !== 0) {
    throw new Error('Release public key is not owned by the current user or root');
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error('Release public key must not be group- or world-writable');
  }
  if (pathInside(allowedRoots[0]!, path) && (metadata.mode & 0o077) !== 0) {
    throw new Error('Release public key in private data must use mode 0600');
  }
  if (metadata.size <= 0 || metadata.size > MAX_RELEASE_KEY_BYTES) {
    throw new Error('Release public key has an invalid size');
  }
  return readFileSync(path);
}

export function createReleaseSignatureVerifier(input: {
  publicKeyPath: string;
  allowedRoots: string[];
}): PackagedReleaseProviderInput['verifySignature'] {
  return ({ payload, signature }) => {
    const bytes = assertTrustedReleaseKey(input.publicKeyPath, input.allowedRoots);
    const key = createPublicKey(bytes);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Release public key must be Ed25519');
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(signature, 'base64');
    } catch (error) {
      throw new Error('Release signature is not valid base64', { cause: error });
    }
    if (decoded.length !== 64) throw new Error('Release signature has an invalid size');
    return verifySignature(null, Buffer.from(payload, 'utf8'), key, decoded);
  };
}

async function boundedFetchBytes(input: {
  url: string;
  maximumBytes: number;
  timeoutMilliseconds: number;
  fetchImplementation: typeof globalThis.fetch;
}): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMilliseconds);
  try {
    const response = await input.fetchImplementation(input.url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/octet-stream, application/json' },
    });
    if (!response.ok || response.body === null)
      throw new Error(`Release fetch returned HTTP ${response.status}`);
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > input.maximumBytes)) {
      throw new Error('Release response exceeds its declared size limit');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > input.maximumBytes) {
        await reader.cancel();
        throw new Error('Release response exceeds its streaming size limit');
      }
      chunks.push(result.value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    clearTimeout(timeout);
  }
}

export function createBoundedReleaseManifestFetcher(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): PackagedReleaseProviderInput['fetchManifest'] {
  return (input) => boundedFetchBytes({ ...input, fetchImplementation });
}

function assertSafeArchiveListing(stdout: string): void {
  const entries = stdout.split('\n').filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_RELEASE_ARCHIVE_ENTRIES) {
    throw new Error('Packaged release archive has an invalid entry count');
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\\/gu, '/');
    if (
      normalized.includes('\0') ||
      normalized.startsWith('/') ||
      /^[A-Za-z]:\//u.test(normalized) ||
      normalized.split('/').some((part) => part === '..')
    ) {
      throw new Error('Packaged release archive contains an unsafe path');
    }
  }
}

function walkRegularFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error('Packaged release contains a symlink');
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
      else throw new Error('Packaged release contains a device or special file');
      if (files.length > MAX_RELEASE_ARCHIVE_ENTRIES) {
        throw new Error('Packaged release contains too many files');
      }
    }
  };
  visit(root);
  return files;
}

function findCandidateApp(root: string): string {
  const matches = walkRegularFiles(root)
    .filter((path) => path.endsWith(`${sep}Contents${sep}MacOS${sep}PimpampumMenuBar`))
    .map((path) => dirname(dirname(dirname(path))));
  if (matches.length !== 1 || !matches[0]!.endsWith('.app')) {
    throw new Error('Packaged release must contain exactly one Pimpampum macOS app');
  }
  return matches[0]!;
}

function validateRuntimeCandidate(
  manifestPath: string,
  target: PackagedReleaseTarget,
  version: string,
): void {
  const [runtimePlatform, runtimeArchitecture] = target.split('-') as [
    'darwin' | 'linux',
    'arm64' | 'x64',
  ];
  const manifest = parseRuntimeManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown, {
    platform: runtimePlatform,
    architecture: runtimeArchitecture,
    maximumUnpackedBytes: 512 * 1024 * 1024,
  });
  if (manifest.pimpampumVersion !== version) {
    throw new Error('Packaged runtime version does not match the signed release');
  }
  const payloadRoot = join(dirname(manifestPath), 'payload');
  const actual = walkRegularFiles(payloadRoot)
    .map((path) => relativePath(payloadRoot, path).split(sep).join('/'))
    .sort();
  const expected = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Packaged runtime has missing or unexpected files');
  }
  for (const file of manifest.files) {
    const path = join(payloadRoot, ...file.path.split('/'));
    const metadata = lstatSync(path);
    const bytes = readFileSync(path);
    if (
      bytes.byteLength !== file.size ||
      (metadata.mode & 0o777) !== file.mode ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    ) {
      throw new Error(`Packaged runtime integrity mismatch: ${file.path}`);
    }
  }
}

function validateCandidateInventory(
  root: string,
  target: PackagedReleaseTarget,
  version: string,
): string {
  const files = walkRegularFiles(root);
  const app = target === 'darwin-arm64' ? findCandidateApp(root) : '';
  const runtimeManifests = files.filter(
    (path) =>
      path.endsWith(`${sep}runtime-manifest.json`) &&
      !path.includes(`${sep}pimpampum-status${sep}`),
  );
  const pluginFiles = files.filter(
    (path) => path.includes(`${sep}pimpampum-status${sep}`) && path.endsWith('.qml'),
  );
  const pluginManifestPath = files.find(
    (path) =>
      path.includes(`${sep}pimpampum-status${sep}`) && path.endsWith(`${sep}runtime-manifest.json`),
  );
  if (
    runtimeManifests.length !== 1 ||
    pluginFiles.length === 0 ||
    pluginManifestPath === undefined ||
    (target === 'darwin-arm64' && app === '')
  ) {
    throw new Error('Packaged release is missing its app, runtime, or plugin inventory');
  }
  validateRuntimeCandidate(runtimeManifests[0]!, target, version);
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as unknown;
  if (
    !isRecord(pluginManifest) ||
    pluginManifest.version !== version ||
    !isRecord(pluginManifest.targets) ||
    Object.keys(pluginManifest.targets).length === 0 ||
    !Object.keys(pluginManifest.targets).every((pluginTarget) =>
      ['linux-arm64', 'linux-x64'].includes(pluginTarget),
    )
  ) {
    throw new Error('Packaged plugin manifest does not match the signed release');
  }
  return app;
}

function readUpdateReceipt(dataDirectory: string): UpdateInstallReceiptMetadata | undefined {
  const receipt = readInstallReceipt(installReceiptPath(dataDirectory), dataDirectory);
  return receipt
    ? {
        schemaVersion: 1,
        adapter: receipt.adapter,
        ...(receipt.updateProvider === undefined ? {} : { updateProvider: receipt.updateProvider }),
        ...(receipt.packagedRuntime === undefined
          ? {}
          : { packagedRuntime: receipt.packagedRuntime }),
      }
    : undefined;
}

export function createConcretePackagedProvider(
  input: CliUpdateManagerInput,
): PackagedReleaseProviderInput {
  if (input.target === null) throw new Error('Packaged release target is unsupported');
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const installedResources = join(
    input.homeDirectory,
    'Applications',
    'Pimpampum.app',
    'Contents',
    'Resources',
  );
  const keyPath =
    input.publicKeyPath ??
    process.env.PIMPAMPUM_RELEASE_PUBLIC_KEY_PATH ??
    join(installedResources, 'pimpampum-release-public-key.pem');
  const allowedKeyRoots = [input.dataDirectory, installedResources];
  return {
    channelManifestUrl:
      input.channelManifestUrl ??
      process.env.PIMPAMPUM_RELEASE_MANIFEST_URL ??
      DEFAULT_RELEASE_CHANNEL_URL,
    target: input.target,
    fetchManifest: createBoundedReleaseManifestFetcher(fetchImplementation),
    verifySignature: createReleaseSignatureVerifier({
      publicKeyPath: keyPath,
      allowedRoots: allowedKeyRoots,
    }),
    async stageCandidate({ asset, maximumBytes, timeoutMilliseconds, target, version }) {
      const stagingParent = join(input.homeDirectory, 'Applications');
      mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
      const parentMetadata = lstatSync(stagingParent);
      if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
        throw new Error('Packaged update staging parent must be a regular directory');
      }
      const stagingRoot = mkdtempSync(join(stagingParent, '.pimpampum-update-'));
      chmodSync(stagingRoot, 0o700);
      const archivePath = join(
        stagingRoot,
        target === 'darwin-arm64' ? 'candidate.zip' : 'candidate.tar.gz',
      );
      const extractedPath = join(stagingRoot, 'candidate');
      try {
        const bytes = await boundedFetchBytes({
          url: asset.url,
          maximumBytes,
          timeoutMilliseconds,
          fetchImplementation,
        });
        if (bytes.byteLength !== asset.size)
          throw new Error('Packaged release size does not match its manifest');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== asset.sha256)
          throw new Error('Packaged release hash does not match its manifest');
        writeFileSync(archivePath, bytes, { flag: 'wx', mode: 0o600 });
        validateRuntimeArchiveFile({
          path: archivePath,
          format: target === 'darwin-arm64' ? 'zip' : 'tar.gz',
          limits: {
            maximumArchiveBytes: maximumBytes,
            maximumEntries: MAX_RELEASE_ARCHIVE_ENTRIES,
            maximumFileBytes: 256 * 1024 * 1024,
            maximumTotalBytes: 512 * 1024 * 1024,
          },
        });
        mkdirSync(extractedPath, { mode: 0o700 });
        const listing =
          target === 'darwin-arm64'
            ? await input.runCommand('/usr/bin/unzip', ['-Z1', archivePath])
            : await input.runCommand('/usr/bin/tar', ['-tzf', archivePath]);
        if (listing.exitCode !== 0) throw new Error('Packaged release archive listing failed');
        assertSafeArchiveListing(listing.stdout);
        const extraction =
          target === 'darwin-arm64'
            ? await input.runCommand('/usr/bin/ditto', ['-x', '-k', archivePath, extractedPath])
            : await input.runCommand('/usr/bin/tar', [
                '-xzf',
                archivePath,
                '-C',
                extractedPath,
                '--no-same-owner',
                '--no-same-permissions',
              ]);
        if (extraction.exitCode !== 0) throw new Error('Packaged release extraction failed');
        validateCandidateInventory(extractedPath, target, version);
        rmSync(archivePath, { force: true });
        return {
          path: resolve(extractedPath),
          sha256,
          size: bytes.byteLength,
          contains: { app: true, runtime: true, plugin: true },
        };
      } catch (error) {
        rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    },
    async reconcile({ version, candidatePath, target }) {
      try {
        if (target !== 'darwin-arm64') {
          throw new Error('This packaged release activator supports only macOS arm64');
        }
        const stagedAppPath = validateCandidateInventory(candidatePath, target, version);
        if (!pathInside(candidatePath, stagedAppPath))
          throw new Error('Staged app escaped its candidate root');
        const installedApp = join(input.homeDirectory, 'Applications', 'Pimpampum.app');
        const candidateRuntimeRoot = join(
          stagedAppPath,
          'Contents',
          'Resources',
          'PimpampumRuntime',
        );
        const candidateManifest = parseRuntimeManifest(
          JSON.parse(
            readFileSync(join(candidateRuntimeRoot, 'runtime-manifest.json'), 'utf8'),
          ) as unknown,
          {
            platform: 'darwin',
            architecture: 'arm64',
            maximumUnpackedBytes: 175 * 1024 * 1024,
          },
        );
        if (candidateManifest.pimpampumVersion !== version) {
          throw new Error('Candidate runtime version does not match the packaged update');
        }
        const candidateLayout = resolveRuntimeLayout({
          homeDirectory: input.homeDirectory,
          platform: 'darwin',
          architecture: 'arm64',
          version,
        });
        const nodePath = join(
          candidateLayout.versionDirectory,
          ...candidateManifest.entrypoints.node.split('/'),
        );
        const cliPath = join(
          candidateLayout.versionDirectory,
          ...candidateManifest.entrypoints.cli.split('/'),
        );
        const packagedRuntime: PackagedRuntimeMetadata = {
          version,
          target: 'darwin-arm64',
          runtimeDirectory: candidateLayout.versionDirectory,
        };
        const candidateManager = input.createCandidateServiceManager({
          appBundlePath: stagedAppPath,
          version,
          nodePath,
          cliPath,
          packagedRuntime,
        });
        const applicationsDirectory = join(input.homeDirectory, 'Applications');
        let currentReceipt: ReturnType<typeof readInstallReceipt> = null;
        let currentReceiptSnapshot: InstallReceiptFileSnapshot | null = null;
        let backupRoot: string | null = null;
        let backupApp: string | null = null;
        let appBackedUp = false;
        let runtimeTransaction: RuntimeInstallationTransaction | null = null;
        const restoreApplication = (): void => {
          if (pathEntryExists(installedApp)) {
            const metadata = lstatSync(installedApp);
            if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
              throw new Error('Updated application path is unsafe to roll back');
            }
            rmSync(installedApp, { recursive: true });
          }
          if (appBackedUp) {
            if (backupApp === null) throw new Error('Application rollback snapshot is missing');
            renameSync(backupApp, installedApp);
            appBackedUp = false;
          }
        };
        const lifecycle = createInstallationLifecycle({
          dataDirectory: input.dataDirectory,
          homeDirectory: input.homeDirectory,
          lifecycleLock: createSetupLifecycleLock(input.dataDirectory),
          runtime: {
            stage: async () => ({ version, nodePath, cliPath }),
            activate: async () => {
              runtimeTransaction = await installRuntimeTransaction({
                homeDirectory: input.homeDirectory,
                dataDirectory: input.dataDirectory,
                platform: 'darwin',
                architecture: 'arm64',
                sourceDirectory: join(candidateRuntimeRoot, 'payload'),
                manifest: candidateManifest,
                smoke: async (installation) => {
                  const smoke = await input.runCommand(installation.nodePath, [
                    installation.cliPath,
                    'version',
                  ]);
                  if (smoke.exitCode !== 0) {
                    throw new Error('Candidate packaged runtime CLI smoke failed');
                  }
                },
              });
            },
            restore: async () => {
              runtimeTransaction?.rollback();
              runtimeTransaction = null;
            },
            removeOwned: async () => undefined,
          },
          service: {
            stop: async () => undefined,
            install: async () => {
              const currentApp = lstatSync(installedApp);
              if (currentApp.isSymbolicLink() || !currentApp.isDirectory()) {
                throw new Error('Installed application must be a regular directory');
              }
              if (backupApp === null) throw new Error('Application backup was not staged');
              renameSync(installedApp, backupApp);
              appBackedUp = true;
              await candidateManager.install();
            },
            start: async () => undefined,
            verify: async () => {
              const status = await candidateManager.status();
              if (!status.installed || !status.running || status.version !== version) {
                throw new Error('Updated packaged service failed health verification');
              }
            },
            restore: async () => {
              restoreApplication();
              if (currentReceiptSnapshot === null) {
                throw new Error('Service receipt rollback snapshot is missing');
              }
              restoreInstallReceiptSnapshot(
                installReceiptPath(input.dataDirectory),
                currentReceiptSnapshot,
                input.dataDirectory,
              );
              await input.currentServiceManager.install();
            },
            removeOwned: async () => undefined,
          },
          connectors: {
            reconcileOwned: async () => undefined,
            snapshotOwned: async () => ({}),
            restoreOwned: async () => undefined,
            disconnectOwned: async () => undefined,
          },
          receipt: {
            read: async () => {
              currentReceipt = readInstallReceipt(
                installReceiptPath(input.dataDirectory),
                input.dataDirectory,
              );
              if (currentReceipt === null) {
                throw new Error('Packaged update requires an installation receipt');
              }
              currentReceiptSnapshot = snapshotInstallReceipt(
                installReceiptPath(input.dataDirectory),
                input.dataDirectory,
              );
              if (currentReceiptSnapshot === null) {
                throw new Error('Packaged update receipt disappeared before staging');
              }
              backupRoot = mkdtempSync(join(applicationsDirectory, '.pimpampum-app-backup-'));
              backupApp = join(backupRoot, 'Pimpampum.app');
              return {
                runtimeVersion: currentReceipt.version,
                serviceCommand: [currentReceipt.nodePath, currentReceipt.cliPath],
                connectorEntries: {},
              };
            },
            commit: async (snapshot) => {
              const installed = readInstallReceipt(
                installReceiptPath(input.dataDirectory),
                input.dataDirectory,
              );
              if (snapshot.runtimeVersion !== version) {
                if (
                  !installed ||
                  installed.version !== snapshot.runtimeVersion ||
                  installed.nodePath !== snapshot.serviceCommand[0] ||
                  installed.cliPath !== snapshot.serviceCommand[1]
                ) {
                  throw new Error('Previous service receipt was not restored exactly');
                }
                return;
              }
              if (
                !installed ||
                installed.version !== snapshot.runtimeVersion ||
                installed.nodePath !== nodePath ||
                installed.cliPath !== cliPath ||
                installed.updateProvider !== 'packaged-release' ||
                installed.packagedRuntime?.version !== version ||
                installed.packagedRuntime.target !== 'darwin-arm64' ||
                installed.packagedRuntime.runtimeDirectory !== candidateLayout.versionDirectory
              ) {
                throw new Error('Updated service receipt did not commit the expected version');
              }
              pruneOwnedRuntimeVersions({
                homeDirectory: input.homeDirectory,
                dataDirectory: input.dataDirectory,
                platform: 'darwin',
                architecture: 'arm64',
                keepVersions: [currentReceipt!.version],
              });
              runtimeTransaction?.commit();
              runtimeTransaction = null;
            },
            remove: async () => undefined,
          },
        });
        try {
          await lifecycle.update({ targetVersion: version });
          appBackedUp = false;
          if (backupRoot !== null) rmSync(backupRoot, { recursive: true, force: true });
        } catch (error) {
          if (appBackedUp) restoreApplication();
          if (backupRoot !== null) rmSync(backupRoot, { recursive: true, force: true });
          throw error;
        }
      } finally {
        const stagingRoot = dirname(candidatePath);
        if (
          stagingRoot.startsWith(join(input.homeDirectory, 'Applications', '.pimpampum-update-'))
        ) {
          rmSync(stagingRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

export function createCliUpdateManager(input: CliUpdateManagerInput): UpdateManager {
  const installReceipt = readUpdateReceipt(input.dataDirectory);
  return createUpdateManager({
    currentVersion: input.currentVersion,
    npmPath: input.npmPath === undefined ? resolveNpmPath(input.nodePath) : input.npmPath,
    nodePath: input.nodePath,
    runCommand: input.runCommand,
    ...(installReceipt ? { installReceipt } : {}),
    ...(input.packagedRelease
      ? { packagedRelease: input.packagedRelease }
      : (installReceipt?.adapter === 'launchd-macos-app' ||
            installReceipt?.adapter === 'macos-app') &&
          input.target === 'darwin-arm64'
        ? { packagedRelease: createConcretePackagedProvider(input) }
        : {}),
  });
}

async function readBoundedStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += bytes.length;
    if (total > maxBytes) throw inputTooLarge(maxBytes);
    chunks.push(bytes);
  }
  return decodeToolInput(Buffer.concat(chunks, total));
}

/**
 * The real entry point. It receives the URL of `cli.ts` rather than using its own, so
 * `compiledCliPath` keeps resolving to `dist/cli.js`, which is the bin target and the file the
 * generated LaunchAgent and systemd unit invoke.
 */
export async function runCliEntrypoint(entryUrl: string): Promise<void> {
  const config = loadConfig();
  const tokenFromEnvironment = Boolean(process.env.PIMPAMPUM_TOKEN?.trim());
  const modulePath = fileURLToPath(entryUrl);
  const sourceMode = modulePath.endsWith('.ts');
  const compiledCliPath = sourceMode
    ? resolve(dirname(modulePath), '..', 'dist', 'cli.js')
    : modulePath;
  const compiledMcpStdioPath = sourceMode
    ? resolve(dirname(modulePath), '..', 'dist', 'mcpStdio.js')
    : resolve(dirname(modulePath), 'mcpStdio.js');
  const hostPlatform = platform();
  const runtimeArchitecture = arch() === 'arm64' ? 'arm64' : arch() === 'x64' ? 'x64' : null;
  const runtimePlatform =
    hostPlatform === 'darwin' || hostPlatform === 'linux' ? hostPlatform : null;
  const supportedRuntimeTarget =
    runtimeArchitecture !== null &&
    runtimePlatform !== null &&
    !(runtimePlatform === 'darwin' && runtimeArchitecture !== 'arm64');
  const homeDirectory = homedir();
  const packagedRuntimeBootstrap = supportedRuntimeTarget
    ? resolvePackagedRuntimeBootstrap({
        homeDirectory,
        dataDirectory: config.dataDirectory,
        platform: runtimePlatform,
        architecture: runtimeArchitecture,
        version: PIMPAMPUM_VERSION,
        nodePath: process.execPath,
        cliPath: compiledCliPath,
      })
    : null;
  const bundledMacOSApp =
    packagedRuntimeBootstrap?.sourceApplicationPath ??
    resolve(dirname(modulePath), '..', 'platforms', 'macos', 'dist', 'Pimpampum.app');
  const bundledOmarchyPlugin = resolve(
    dirname(modulePath),
    '..',
    'integrations',
    'omarchy',
    'pimpampum-status',
  );
  const omarchyPath = hostPlatform === 'linux' ? findExecutable('omarchy') : null;
  const omarchyShellPath = hostPlatform === 'linux' ? findExecutable('omarchy-shell') : null;
  const serviceLifecycleRequested = new Set(['install', 'status', 'uninstall']).has(
    process.argv[2] ?? '',
  );
  let omarchyVersion = null;
  if (serviceLifecycleRequested && omarchyPath && omarchyShellPath) {
    omarchyVersion = await runServiceCommand(omarchyPath, ['version']).catch(() => null);
    if (omarchyVersion && omarchyVersion.exitCode !== 0) {
      omarchyVersion = await runServiceCommand(omarchyPath, ['--version']).catch(() => null);
    }
  }
  const useOmarchy =
    omarchyVersion?.exitCode === 0 && isCompatibleOmarchyVersion(omarchyVersion.stdout);
  const linuxSystemdAdapter = hostPlatform === 'linux' ? createSystemdAdapter() : null;
  const linuxOmarchyAdapter =
    hostPlatform === 'linux' && omarchyPath && omarchyShellPath && linuxSystemdAdapter
      ? createOmarchyAdapter({
          pluginSourcePath: bundledOmarchyPlugin,
          daemonAdapter: linuxSystemdAdapter,
          omarchyPath,
          omarchyShellPath,
        })
      : null;
  const macOSLaunchdAdapter = hostPlatform === 'darwin' ? createLaunchdAdapter() : null;
  const macOSDesktopAdapter =
    hostPlatform === 'darwin' && macOSLaunchdAdapter
      ? createMacOSDesktopAdapter({
          appBundlePath: bundledMacOSApp,
          daemonAdapter: macOSLaunchdAdapter,
        })
      : null;

  const managerInput = {
    platform: hostPlatform,
    homeDirectory,
    dataDirectory: config.dataDirectory,
    nodePath: packagedRuntimeBootstrap?.nodePath ?? process.execPath,
    cliPath: packagedRuntimeBootstrap?.cliPath ?? compiledCliPath,
    version: PIMPAMPUM_VERSION,
    host: config.host,
    port: config.port,
    runCommand: runServiceCommand,
    ...(packagedRuntimeBootstrap === null
      ? {}
      : { packagedRuntime: packagedRuntimeBootstrap.packagedRuntime }),
  };
  const serviceManager = createHealthVerifiedServiceManager({
    ...managerInput,
    ...(macOSLaunchdAdapter && macOSDesktopAdapter
      ? {
          adapters: { darwin: macOSDesktopAdapter },
          receiptAdapters: {
            [macOSLaunchdAdapter.id]: macOSLaunchdAdapter,
            [macOSDesktopAdapter.id]: macOSDesktopAdapter,
          },
        }
      : hostPlatform === 'linux' && linuxSystemdAdapter
        ? {
            adapters: {
              linux: useOmarchy && linuxOmarchyAdapter ? linuxOmarchyAdapter : linuxSystemdAdapter,
            },
            receiptAdapters: {
              [linuxSystemdAdapter.id]: linuxSystemdAdapter,
              ...(linuxOmarchyAdapter ? { [linuxOmarchyAdapter.id]: linuxOmarchyAdapter } : {}),
            },
          }
        : {}),
  });
  const serviceOnlyManager =
    macOSLaunchdAdapter && macOSDesktopAdapter
      ? createHealthVerifiedServiceManager({
          ...managerInput,
          adapters: { darwin: macOSLaunchdAdapter },
          receiptAdapters: {
            [macOSLaunchdAdapter.id]: macOSLaunchdAdapter,
            [macOSDesktopAdapter.id]: macOSDesktopAdapter,
          },
        })
      : null;

  let connections: ReturnType<typeof createCliConnectionsRuntime> | undefined;
  let setup: ReturnType<typeof createCliSetupRuntime> | undefined;
  let packagedUninstall: ServiceManager['uninstall'] | undefined;
  if (supportedRuntimeTarget) {
    const layout = resolveRuntimeLayout({
      homeDirectory,
      platform: runtimePlatform,
      architecture: runtimeArchitecture,
      version: PIMPAMPUM_VERSION,
    });
    const codexReceipt = createConnectionReceiptStore(config.dataDirectory, 'codex');
    const claudeReceipt = createConnectionReceiptStore(config.dataDirectory, 'claude-code');
    const codex = createCodexConnector({
      launcherPath: layout.mcpLauncherPath,
      boundedLocations: [
        join(homeDirectory, '.local', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/Applications/Codex.app/Contents/Resources',
      ],
      path: process.env.PATH ?? '',
      requiredTools: ['project_list', 'work_start'],
      receipt: codexReceipt,
    });
    const claudeCode = createClaudeCodeConnector({
      launcherPath: layout.mcpLauncherPath,
      userConfigPath: join(homeDirectory, '.claude.json'),
      boundedExecutableLocations: [
        join(homeDirectory, '.local', 'bin'),
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ],
      pathValue: process.env.PATH ?? '',
      higherPrecedenceConfigSources: [{ path: resolve('.mcp.json'), scope: 'project' }],
      requiredTools: ['project_list', 'work_start'],
      receiptStore: claudeReceipt,
    });
    const connectorById = new Map<ConnectorId, HostConnector>([
      ['codex', codex],
      ['claude-code', claudeCode],
    ]);
    const orderedConnectors = createConnectorRegistry().map(({ id }) => connectorById.get(id)!);
    const connectorReceiptById = new Map([
      ['codex', codexReceipt],
      ['claude-code', claudeReceipt],
    ] as const);
    connections = createCliConnectionsRuntime({
      connectors: orderedConnectors,
      launcherPath: layout.mcpLauncherPath,
    });

    const snapshots = new Map<ConnectorId, ConnectorSnapshot>();
    const newSessionRequired = new Map<ConnectorId, boolean>();
    const setupConnectors = Object.fromEntries(
      orderedConnectors.map((connector) => [
        connector.id,
        {
          inspect: async () => {
            const inspected = await connector.inspect();
            return {
              state: inspected.state,
              ...(inspected.state === 'conflict'
                ? {
                    comparison: 'An existing entry differs from the Pimpampum-owned launcher.',
                    ...(inspected.entry === null
                      ? {}
                      : {
                          revision: fingerprintCommand(inspected.entry),
                          replacementSupported: inspected.entry.restorable !== false,
                        }),
                  }
                : {}),
            };
          },
          connect: async (input?: {
            conflictDecision?: 'keep' | 'replace' | 'cancel';
            reviewedEntryFingerprint?: string;
          }) => {
            const plan = await connector.plan(input);
            if (
              plan.state === 'conflict' &&
              (plan.conflictDecision !== 'replace' || plan.mutations.length === 0)
            ) {
              throw Object.assign(new Error('The existing connector entry requires a decision'), {
                code: 'CONNECTOR_CONFLICT',
              });
            }
            snapshots.set(connector.id, await connector.snapshot());
            newSessionRequired.set(connector.id, plan.newSessionRequired);
            await connector.connect(plan);
          },
          verify: async () => {
            const verified = await connector.verify();
            return {
              available: verified.available,
              newSessionRequired: newSessionRequired.get(connector.id) ?? false,
            };
          },
          restore: async () => {
            const snapshot = snapshots.get(connector.id);
            if (snapshot !== undefined) await connector.restore(snapshot);
          },
        },
      ]),
    ) as Parameters<typeof createSetupCoordinator>[0]['connectors'];
    let lastInstall: Awaited<ReturnType<typeof serviceManager.install>> | null = null;
    const setupState = createSetupStateStore(config.dataDirectory);
    const setupPlan = createSetupPlanStore(config.dataDirectory);
    let setupRuntimeTransaction: Awaited<
      ReturnType<NonNullable<typeof packagedRuntimeBootstrap>['prepareInstallation']>
    > | null = null;
    const commitSetupRuntime = (): void => {
      if (setupRuntimeTransaction === null) return;
      pruneOwnedRuntimeVersions({
        homeDirectory,
        dataDirectory: config.dataDirectory,
        platform: runtimePlatform,
        architecture: runtimeArchitecture,
        ...(setupRuntimeTransaction.installation.previousVersion === null
          ? {}
          : { keepVersions: [setupRuntimeTransaction.installation.previousVersion] }),
      });
      setupRuntimeTransaction.commit();
      setupRuntimeTransaction = null;
    };
    const setupCoordinator = createSetupCoordinator({
      lifecycleLock: createSetupLifecycleLock(config.dataDirectory),
      changeTargets: {
        runtimeDirectory: layout.runtimeDirectory,
        servicePath:
          hostPlatform === 'darwin'
            ? join(homeDirectory, 'Library', 'LaunchAgents', 'dev.pimpampum.daemon.plist')
            : join(homeDirectory, '.config', 'systemd', 'user', 'pimpampum.service'),
        dataDirectory: config.dataDirectory,
        connectorConfigPaths: {
          codex: join(homeDirectory, '.codex', 'config.toml'),
          'claude-code': join(homeDirectory, '.claude.json'),
        },
      },
      runtime: {
        install: async () => {
          if (packagedRuntimeBootstrap === null) return { version: PIMPAMPUM_VERSION };
          setupRuntimeTransaction = await packagedRuntimeBootstrap.prepareInstallation(
            async (installation) => {
              const smoke = await runServiceCommand(installation.nodePath, [
                installation.cliPath,
                'version',
              ]);
              if (smoke.exitCode !== 0) throw new Error('Packaged runtime CLI smoke failed');
              const envelope = JSON.parse(smoke.stdout) as unknown;
              if (
                !isRecord(envelope) ||
                !isRecord(envelope.data) ||
                envelope.data.version !== PIMPAMPUM_VERSION
              ) {
                throw new Error('Packaged runtime CLI smoke returned an unexpected version');
              }
            },
          );
          return { version: setupRuntimeTransaction.installation.version };
        },
        rollback: async () => {
          setupRuntimeTransaction?.rollback();
          setupRuntimeTransaction = null;
        },
      },
      service: {
        install: async () => {
          lastInstall = await serviceManager.install();
        },
        verify: async () => {
          // The manager's post-activation verifier completed inside service.install's rollback
          // boundary. Keeping this coordinator phase explicit preserves durable progress ordering.
        },
        // Service installation has its own receipt-backed rollback transaction.
        rollback: async () => undefined,
      },
      connectors: setupConnectors,
      loginItem: {
        register: async () => {
          commitSetupRuntime();
          return lastInstall?.loginItem === 'requiresApproval'
            ? 'requires-approval'
            : lastInstall?.loginItem === 'error'
              ? 'denied'
              : 'enabled';
        },
      },
      dataDirectory: config.dataDirectory,
      now: () => new Date().toISOString(),
      stateStore: setupState,
      planStore: setupPlan,
    });
    setup = createCliSetupRuntime(setupCoordinator, setupState);

    packagedUninstall = async () => {
      const serviceReceiptPath = installReceiptPath(config.dataDirectory);
      const serviceReceipt = readInstallReceipt(serviceReceiptPath, config.dataDirectory);
      const packaged =
        serviceReceipt !== null &&
        (serviceReceipt.updateProvider === 'packaged-release' ||
          serviceReceipt.packagedRuntime !== undefined ||
          ['launchd-macos-app', 'macos-app', 'systemd-omarchy-quattro'].includes(
            serviceReceipt.adapter,
          ));
      if (!packaged) return serviceManager.uninstall();
      if (!serviceManager.prepareUninstall) {
        throw new Error('Packaged service removal transaction is unavailable');
      }

      let preparedService: PreparedServiceUninstall | null = null;
      let preparedRuntime: PreparedRuntimeRemoval | null = null;
      let capturedServiceReceipt: InstallReceiptFileSnapshot | null = null;
      let disconnectedConnectorIds: ConnectorId[] = [];
      const lifecycle = createInstallationLifecycle({
        dataDirectory: config.dataDirectory,
        homeDirectory,
        lifecycleLock: createSetupLifecycleLock(config.dataDirectory),
        runtime: {
          stage: async () => {
            throw new Error('Runtime staging is unavailable during removal');
          },
          activate: async () => undefined,
          restore: async () => {
            preparedRuntime?.rollback();
            preparedRuntime = null;
          },
          removeOwned: async () => {
            preparedRuntime = prepareOwnedRuntimeRemoval({
              homeDirectory,
              dataDirectory: config.dataDirectory,
              platform: runtimePlatform,
              architecture: runtimeArchitecture,
            });
          },
          finalizeRemoval: async () => {
            preparedRuntime?.commit();
            preparedRuntime = null;
          },
        },
        service: {
          // prepareUninstall deactivates the native registration inside its rollback boundary.
          stop: async () => undefined,
          install: async () => {
            throw new Error('Service installation is unavailable during removal');
          },
          start: async () => undefined,
          verify: async () => undefined,
          restore: async () => {
            if (preparedService === null) return;
            const transaction = preparedService;
            preparedService = null;
            await transaction.rollback();
          },
          removeOwned: async () => {
            preparedService = await serviceManager.prepareUninstall!();
            if (preparedService === null) {
              throw new Error('Packaged service receipt disappeared during removal');
            }
          },
          finalizeRemoval: async () => {
            if (preparedService === null) return;
            const transaction = preparedService;
            await transaction.finalize();
            preparedService = null;
          },
        },
        connectors: {
          reconcileOwned: async () => undefined,
          snapshotOwned: async () => ({}),
          planRemoval: async () => {
            const ownedEntries: Record<string, unknown> = {};
            const unprovenConnectorIds: string[] = [];
            for (const connector of orderedConnectors) {
              const inspection = await connector.inspect();
              const receiptStore = connectorReceiptById.get(connector.id)!;
              const receipt = await receiptStore.read();
              if (
                (inspection.state === 'ownedCurrent' || inspection.state === 'ownedStale') &&
                inspection.entry !== null &&
                receipt !== null
              ) {
                const snapshot = await connector.snapshot();
                if (
                  snapshot.entry !== null &&
                  fingerprintCommand(snapshot.entry) === fingerprintCommand(inspection.entry)
                ) {
                  ownedEntries[connector.id] = { snapshot, receipt };
                  continue;
                }
              }
              if (inspection.entry !== null || receipt !== null) {
                unprovenConnectorIds.push(connector.id);
              }
            }
            return { ownedEntries, unprovenConnectorIds };
          },
          disconnectOwned: async (entries = {}) => {
            disconnectedConnectorIds = [];
            for (const connector of orderedConnectors) {
              if (!Object.hasOwn(entries, connector.id)) continue;
              disconnectedConnectorIds.push(connector.id);
              const result = await connector.disconnect();
              if (!result.changed) {
                throw new Error(`${connector.displayName} owned entry changed during removal`);
              }
            }
          },
          restoreOwned: async (entries) => {
            const errors: unknown[] = [];
            for (const connectorId of [...disconnectedConnectorIds].reverse()) {
              const value = entries[connectorId];
              if (!isRecord(value) || !isRecord(value.snapshot) || !isRecord(value.receipt)) {
                errors.push(new Error(`Invalid ${connectorId} removal snapshot`));
                continue;
              }
              const connector = connectorById.get(connectorId)!;
              const receiptStore = connectorReceiptById.get(connectorId)!;
              try {
                await connector.restore(value.snapshot as unknown as ConnectorSnapshot);
                await receiptStore.write(value.receipt as unknown as ConnectionReceipt);
              } catch (error) {
                errors.push(error);
              }
            }
            if (errors.length > 0) {
              throw new AggregateError(errors, 'Agent connection removal rollback failed');
            }
          },
        },
        receipt: {
          read: async () => ({
            runtimeVersion: serviceReceipt.version,
            serviceCommand: [serviceReceipt.nodePath, serviceReceipt.cliPath],
            connectorEntries: {},
            adapter: serviceReceipt.adapter,
            dataDirectory: serviceReceipt.dataDirectory,
            runtimeKind: 'packaged',
          }),
          capture: async () => {
            capturedServiceReceipt = snapshotInstallReceipt(
              serviceReceiptPath,
              config.dataDirectory,
            );
            if (capturedServiceReceipt === null) {
              throw new Error('Packaged service receipt disappeared during removal planning');
            }
            return {
              snapshot: {
                runtimeVersion: capturedServiceReceipt.receipt.version,
                serviceCommand: [
                  capturedServiceReceipt.receipt.nodePath,
                  capturedServiceReceipt.receipt.cliPath,
                ],
                connectorEntries: {},
                adapter: capturedServiceReceipt.receipt.adapter,
                dataDirectory: capturedServiceReceipt.receipt.dataDirectory,
                runtimeKind: 'packaged',
              },
              contents: capturedServiceReceipt.contents,
            };
          },
          commit: async () => {
            throw new Error('Packaged removal cannot rewrite a semantic receipt snapshot');
          },
          restore: async ({ contents }) => {
            if (
              capturedServiceReceipt === null ||
              !Buffer.from(contents).equals(capturedServiceReceipt.contents)
            ) {
              throw new Error('Packaged service receipt rollback snapshot changed');
            }
            restoreInstallReceiptSnapshot(
              serviceReceiptPath,
              capturedServiceReceipt,
              config.dataDirectory,
            );
          },
          remove: async () => {
            if (preparedService === null) {
              throw new Error('Packaged service removal was not prepared');
            }
            const transaction = preparedService;
            await transaction.commit();
          },
        },
      });
      const removed = await lifecycle.remove();
      return {
        uninstalled: removed.removed,
        dataPreserved: true,
        ...(removed.manualInstructions.length === 0
          ? {}
          : { manualInstructions: removed.manualInstructions }),
      };
    };
  }

  const installPackagedCommand = async (
    manager: ServiceManager,
  ): ReturnType<ServiceManager['install']> => {
    if (packagedRuntimeBootstrap === null) return manager.install();
    return createSetupLifecycleLock(config.dataDirectory).run(async () => {
      const transaction = await packagedRuntimeBootstrap.prepareInstallation(
        async (installation) => {
          const smoke = await runServiceCommand(installation.nodePath, [
            installation.cliPath,
            'version',
          ]);
          if (smoke.exitCode !== 0) throw new Error('Packaged runtime CLI smoke failed');
        },
      );
      try {
        const result = await manager.install();
        pruneOwnedRuntimeVersions({
          homeDirectory,
          dataDirectory: config.dataDirectory,
          platform: runtimePlatform!,
          architecture: runtimeArchitecture!,
          ...(transaction.installation.previousVersion === null
            ? {}
            : { keepVersions: [transaction.installation.previousVersion] }),
        });
        transaction.commit();
        return result;
      } catch (error) {
        transaction.rollback();
        throw error;
      }
    });
  };

  const commandServiceManager: ServiceManager =
    packagedUninstall === undefined
      ? serviceManager
      : {
          install: () => installPackagedCommand(serviceManager),
          status: () => serviceManager.status(),
          uninstall: () => packagedUninstall!(),
          ...(serviceManager.prepareUninstall
            ? { prepareUninstall: () => serviceManager.prepareUninstall!() }
            : {}),
        };

  await runCli(process.argv.slice(2), {
    createClient: () => createHttpClient(config),
    createAgentClient: () => createAgentCliClient(config),
    describeConfig: () => ({
      dataDirectory: config.dataDirectory,
      databasePath: config.databasePath,
      baseUrl: config.baseUrl,
      tokenPath: tokenFromEnvironment ? null : join(config.dataDirectory, 'token'),
      tokenSource: tokenFromEnvironment ? 'environment' : 'file',
      tokenConfigured: config.token.length > 0,
      mcp: {
        streamableHttpUrl: `${config.baseUrl}/mcp`,
        stdio: {
          command: process.execPath,
          args: [compiledMcpStdioPath],
        },
      },
    }),
    serviceManager: commandServiceManager,
    updateManager: createCliUpdateManager({
      currentVersion: PIMPAMPUM_VERSION,
      dataDirectory: config.dataDirectory,
      homeDirectory: homedir(),
      target:
        runtimePlatform === 'darwin' && runtimeArchitecture === 'arm64'
          ? 'darwin-arm64'
          : runtimePlatform === 'linux' && runtimeArchitecture === 'arm64'
            ? 'linux-arm64'
            : runtimePlatform === 'linux' && runtimeArchitecture === 'x64'
              ? 'linux-x64'
              : null,
      npmPath: resolveNpmPath(process.execPath),
      nodePath: process.execPath,
      runCommand: runServiceCommand,
      currentServiceManager: serviceManager,
      createCandidateServiceManager: ({
        appBundlePath,
        version,
        nodePath,
        cliPath,
        packagedRuntime,
      }) => {
        if (hostPlatform !== 'darwin') {
          throw new Error('Packaged macOS candidates can only activate on macOS');
        }
        const daemonAdapter = createLaunchdAdapter();
        const desktopAdapter = createMacOSDesktopAdapter({ appBundlePath, daemonAdapter });
        return createHealthVerifiedServiceManager({
          ...managerInput,
          version,
          nodePath,
          cliPath,
          packagedRuntime,
          adapters: { darwin: desktopAdapter },
          receiptAdapters: {
            [daemonAdapter.id]: daemonAdapter,
            [desktopAdapter.id]: desktopAdapter,
          },
        });
      },
    }),
    ...(connections === undefined ? {} : { connections }),
    ...(setup === undefined ? {} : { setup }),
    ...(serviceOnlyManager ? { serviceOnlyManager } : {}),
    startServer: () => startServer(config),
    // The stdio bridge entry point wires its own signals and runs on import.
    startStdioBridge: async () => {
      await import('./mcpStdio.js');
    },
    readFile: (path, maxBytes) =>
      maxBytes === undefined ? readFileSync(path, 'utf8') : readBoundedUtf8File(path, maxBytes),
    readStdin: (maxBytes = MAX_AGENT_INPUT_BYTES) => readBoundedStdin(maxBytes),
    resolvePath: resolve,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    onSignal: (signal, callback) => process.once(signal, callback),
    exit: (code) => process.exit(code),
  });
}
