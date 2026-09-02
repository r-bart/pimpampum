/**
 * What a downloaded release must contain before anything activates it: a safe archive listing, one
 * macOS app, a runtime whose every file matches its manifest, and a plugin manifest for the same
 * version. `createPackagedReleaseStager` downloads and validates; `stagePackagedMacOSApplication`
 * reuses it to give `pimpampum install` an app bundle when the CLI came from npm.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path';
import { AppError } from '../errors.js';
import { walkRegularTree } from '../fsGuards.js';
import { isRecord } from '../objects.js';
import { validateRuntimeArchiveFile } from '../runtime/archive.js';
import { parseRuntimeManifest } from '../runtime/manifest.js';
import type { RunCommand } from '../service/types.js';
import {
  createReleaseTrustStore,
  RELEASE_FETCH_TIMEOUT_MS,
  resolvePackagedRelease,
  type PackagedReleaseProviderInput,
  type PackagedReleaseTarget,
} from '../update.js';
import {
  boundedFetchBytes,
  releaseChannelTransport,
  versionedReleaseManifestUrl,
  type ReleaseChannelTransportInput,
} from './releaseChannel.js';

export const MAX_RELEASE_ARCHIVE_ENTRIES = 20_000;

/** `true` for any entry at `path`, a dangling symlink included; only a missing path is `false`. */
export function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
const MAX_RELEASE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RELEASE_UNPACKED_BYTES = 512 * 1024 * 1024;

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

/** Every regular file below `root`, sorted; a symlink or a special file anywhere is a refusal. */
function walkRegularFiles(root: string): string[] {
  const files: string[] = [];
  walkRegularTree(
    root,
    (entry) => {
      if (entry.kind !== 'file') return;
      files.push(entry.path);
      if (files.length > MAX_RELEASE_ARCHIVE_ENTRIES) {
        throw new Error('Packaged release contains too many files');
      }
    },
    { label: 'Packaged release' },
  );
  return files;
}

export function findCandidateApp(root: string): string {
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
    maximumUnpackedBytes: MAX_RELEASE_UNPACKED_BYTES,
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

function isPluginManifestFor(value: unknown, version: string): boolean {
  return (
    isRecord(value) &&
    value.version === version &&
    isRecord(value.targets) &&
    Object.keys(value.targets).length > 0 &&
    Object.keys(value.targets).every((pluginTarget) =>
      ['linux-arm64', 'linux-x64'].includes(pluginTarget),
    )
  );
}

/** Validates the whole unpacked release and returns the app bundle path (`''` off macOS). */
export function validateCandidateInventory(
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
    pluginManifestPath === undefined
  ) {
    throw new Error('Packaged release is missing its app, runtime, or plugin inventory');
  }
  validateRuntimeCandidate(runtimeManifests[0]!, target, version);
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8')) as unknown;
  if (!isPluginManifestFor(pluginManifest, version)) {
    throw new Error('Packaged plugin manifest does not match the signed release');
  }
  return app;
}

/**
 * Linux packaged installs are owned by the Omarchy plugin: its pinned `runtime-manifest.json`
 * and `pimpampum-bootstrap` install the exact runtime, and the plugin update replaces the pin.
 * `update:check` still answers from the signed channel; only the activation is refused, typed, so
 * the Updates panel can show the real remedy instead of a connection guess.
 */
export function linuxPackagedUpdateUnavailable(version: string): AppError {
  return new AppError(
    'unavailable',
    `Pimpampum ${version} is available, but a Linux packaged runtime is installed by the Omarchy plugin: update the Pimpampum Status plugin, then run pimpampum-bootstrap from the plugin directory`,
    503,
    false,
    { remedy: 'pimpampum-bootstrap', version },
  );
}

function createPrivateStagingRoot(homeDirectory: string): string {
  const stagingParent = join(homeDirectory, 'Applications');
  mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
  const parentMetadata = lstatSync(stagingParent);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new Error('Packaged update staging parent must be a regular directory');
  }
  const stagingRoot = mkdtempSync(join(stagingParent, '.pimpampum-update-'));
  chmodSync(stagingRoot, 0o700);
  return stagingRoot;
}

async function unpackVerifiedArchive(input: {
  runCommand: RunCommand;
  archivePath: string;
  extractedPath: string;
  maximumBytes: number;
}): Promise<void> {
  validateRuntimeArchiveFile({
    path: input.archivePath,
    format: 'zip',
    limits: {
      maximumArchiveBytes: input.maximumBytes,
      maximumEntries: MAX_RELEASE_ARCHIVE_ENTRIES,
      maximumFileBytes: MAX_RELEASE_FILE_BYTES,
      maximumTotalBytes: MAX_RELEASE_UNPACKED_BYTES,
    },
  });
  mkdirSync(input.extractedPath, { mode: 0o700 });
  const listing = await input.runCommand('/usr/bin/unzip', ['-Z1', input.archivePath]);
  if (listing.exitCode !== 0) throw new Error('Packaged release archive listing failed');
  assertSafeArchiveListing(listing.stdout);
  const extraction = await input.runCommand('/usr/bin/ditto', [
    '-x',
    '-k',
    input.archivePath,
    input.extractedPath,
  ]);
  if (extraction.exitCode !== 0) throw new Error('Packaged release extraction failed');
}

/** Downloads one signed release asset, verifies hash, size, archive and inventory, and unpacks it. */
export function createPackagedReleaseStager(input: {
  homeDirectory: string;
  runCommand: RunCommand;
  fetchImplementation: typeof globalThis.fetch;
  allowInsecureLoopback: boolean;
}): PackagedReleaseProviderInput['stageCandidate'] {
  return async ({ asset, maximumBytes, timeoutMilliseconds, target, version }) => {
    if (target !== 'darwin-arm64') throw linuxPackagedUpdateUnavailable(version);
    const stagingRoot = createPrivateStagingRoot(input.homeDirectory);
    const archivePath = join(stagingRoot, 'candidate.zip');
    const extractedPath = join(stagingRoot, 'candidate');
    try {
      const bytes = await boundedFetchBytes({
        url: asset.url,
        maximumBytes,
        timeoutMilliseconds,
        fetchImplementation: input.fetchImplementation,
        allowInsecureLoopback: input.allowInsecureLoopback,
      });
      if (bytes.byteLength !== asset.size) {
        throw new Error('Packaged release size does not match its manifest');
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== asset.sha256) {
        throw new Error('Packaged release hash does not match its manifest');
      }
      writeFileSync(archivePath, bytes, { flag: 'wx', mode: 0o600 });
      await unpackVerifiedArchive({
        runCommand: input.runCommand,
        archivePath,
        extractedPath,
        maximumBytes,
      });
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
  };
}

/** The install source provider only resolves and stages; activation is the updater's alone. */
export const refuseStagedSourceActivation: PackagedReleaseProviderInput['reconcile'] = async () => {
  throw new Error('A staged install source is never activated as an update');
};

export interface StagedMacOSApplication {
  appBundlePath: string;
  version: string;
  /** Removes the private staging directory; safe to call more than once. */
  cleanup(): void;
}

/**
 * The macOS app for `pimpampum install` when the CLI came from npm. The npm package carries no app
 * bundle, so the install fetches the signed manifest of its own version, verifies it with the
 * embedded key, downloads the zip and validates hash, size, archive and inventory exactly as an
 * update would. The staged bundle is then the install source the desktop adapter copies from.
 */
export async function stagePackagedMacOSApplication(
  input: ReleaseChannelTransportInput & {
    homeDirectory: string;
    /** When given, the accepted manifest freshness is recorded in `update-trust.json` there. */
    dataDirectory?: string | undefined;
    version: string;
    runCommand: RunCommand;
  },
): Promise<StagedMacOSApplication> {
  const transport = releaseChannelTransport(input);
  const target: PackagedReleaseTarget = 'darwin-arm64';
  const provider: PackagedReleaseProviderInput = {
    channelManifestUrl: transport.channelManifestUrl ?? versionedReleaseManifestUrl(input.version),
    target,
    allowInsecureLoopback: transport.allowInsecureLoopback,
    fetchManifest: transport.fetchManifest,
    verifySignature: transport.verifySignature,
    stageCandidate: createPackagedReleaseStager({
      homeDirectory: input.homeDirectory,
      runCommand: input.runCommand,
      fetchImplementation: transport.fetchImplementation,
      allowInsecureLoopback: transport.allowInsecureLoopback,
    }),
    reconcile: refuseStagedSourceActivation,
  };
  const { manifest, asset } = await resolvePackagedRelease(
    provider,
    input.dataDirectory === undefined ? undefined : createReleaseTrustStore(input.dataDirectory),
  );
  if (manifest.version !== input.version) {
    throw new AppError(
      'unavailable',
      `The release channel offers Pimpampum ${manifest.version}, not ${input.version}; run npm install --global pimpampum@${manifest.version} and retry`,
      503,
      false,
      { channelVersion: manifest.version, installedVersion: input.version },
    );
  }
  const staged = await provider.stageCandidate({
    version: manifest.version,
    target,
    asset,
    maximumBytes: asset.size,
    timeoutMilliseconds: RELEASE_FETCH_TIMEOUT_MS,
  });
  const stagingRoot = dirname(staged.path);
  return {
    appBundlePath: findCandidateApp(staged.path),
    version: manifest.version,
    cleanup: () => rmSync(stagingRoot, { recursive: true, force: true }),
  };
}
