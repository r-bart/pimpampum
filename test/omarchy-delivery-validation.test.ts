import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface DeliveryValidation {
  runtimeVersion: string;
  runtimeManifestSha256: string;
  targets: Record<string, { artifactSha256: string }>;
  helpers: Record<string, { mode: number }>;
  qmlLaunchedHelpers: string[];
}

let validateOmarchyDelivery: (candidate: string) => DeliveryValidation;
let validateTask62Evidence: (input: {
  evidencePath: string;
  candidatePath: string;
  allowedRoot: string;
}) => unknown;
let createTask62LiveRunner: (dependencies: Record<string, unknown>) => {
  run(input: Record<string, unknown>): Promise<{ scenarios: Array<{ id: string }> }>;
};
let TASK_6_2_SCENARIOS: readonly string[];

const roots: string[] = [];
const source = join(process.cwd(), 'integrations/omarchy/pimpampum-status');

beforeAll(async () => {
  const deliveryModuleUrl = pathToFileURL(
    join(process.cwd(), 'scripts/check-omarchy-delivery.mjs'),
  ).href;
  const evidenceModuleUrl = pathToFileURL(
    join(process.cwd(), 'scripts/check-omarchy-live-evidence.mjs'),
  ).href;
  const runnerModuleUrl = pathToFileURL(join(process.cwd(), 'scripts/test-omarchy-live.mjs')).href;
  const deliveryModule = (await import(deliveryModuleUrl)) as {
    validateOmarchyDelivery(candidate: string): DeliveryValidation;
  };
  const evidenceModule = (await import(evidenceModuleUrl)) as {
    validateTask62Evidence(input: {
      evidencePath: string;
      candidatePath: string;
      allowedRoot: string;
    }): unknown;
  };
  const runnerModule = (await import(runnerModuleUrl)) as {
    createTask62LiveRunner(dependencies: Record<string, unknown>): {
      run(input: Record<string, unknown>): Promise<{ scenarios: Array<{ id: string }> }>;
    };
    TASK_6_2_SCENARIOS: readonly string[];
  };
  validateOmarchyDelivery = deliveryModule.validateOmarchyDelivery;
  validateTask62Evidence = evidenceModule.validateTask62Evidence;
  createTask62LiveRunner = runnerModule.createTask62LiveRunner;
  TASK_6_2_SCENARIOS = runnerModule.TASK_6_2_SCENARIOS;
});

function fixture(): { root: string; candidate: string; evidencePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'pimpampum-omarchy-delivery-'));
  roots.push(root);
  const candidate = join(root, 'candidate');
  cpSync(source, candidate, { recursive: true, preserveTimestamps: true });
  return { root, candidate, evidencePath: join(root, 'evidence', 'omarchy-live.json') };
}

function manifest(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function task62Harness(state: ReturnType<typeof fixture>) {
  const delivery = validateOmarchyDelivery(state.candidate);
  let tick = Date.parse('2026-08-31T10:00:00.000Z');
  const preservedDataSha256 = vi.fn(async () => 'd'.repeat(64));
  const writeEvidenceAtomic = vi.fn((path: string, evidence: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  });
  const dependencies = {
    environment: { PIMPAMPUM_OMARCHY_DELIVERY_LIVE: '1' },
    platform: 'linux',
    uid: 1000,
    now: () => new Date((tick += 25)),
    validateDelivery: vi.fn(async () => ({
      runtimeVersion: delivery.runtimeVersion,
      runtimeManifestSha256: delivery.runtimeManifestSha256,
      artifactSha256: delivery.targets['linux-x64']!.artifactSha256,
    })),
    repositoryCommit: vi.fn(async () => 'a'.repeat(40)),
    preservedDataSha256,
    runScenario: vi.fn(async ({ id }: { id: string }) => ({
      passed: true,
      observed: `${id} passed with bounded fixture commands`,
    })),
    cleanup: vi.fn(async () => ({ completed: true })),
    writeEvidenceAtomic,
  };
  return { dependencies, preservedDataSha256, writeEvidenceAtomic };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('cross-platform Omarchy delivery validation', () => {
  it('binds both Linux artifacts and every launched helper', () => {
    const result = validateOmarchyDelivery(source);
    expect(Object.keys(result.targets).sort()).toEqual(['linux-arm64', 'linux-x64']);
    expect(result.runtimeManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.keys(result.helpers).sort()).toEqual([
      'install.sh',
      'pimpampum-backup',
      'pimpampum-bootstrap',
      'pimpampum-common.sh',
      'pimpampum-connections',
      'pimpampum-control-route',
      'pimpampum-folder-picker',
      'pimpampum-overview',
      'pimpampum-plugin-lifecycle',
      'pimpampum-service',
      'pimpampum-sync',
      'pimpampum-update',
      'uninstall.sh',
    ]);
    expect(Object.values(result.helpers).every(({ mode }) => (mode & 0o111) !== 0)).toBe(true);
    expect(result.qmlLaunchedHelpers).toEqual([
      'pimpampum-backup',
      'pimpampum-connections',
      // The popout's "Add a workspace" button dispatches through the hash-verified route directly.
      'pimpampum-control-route',
      'pimpampum-folder-picker',
      'pimpampum-overview',
      'pimpampum-service',
      'pimpampum-sync',
      'pimpampum-update',
    ]);
  });

  it('rejects a missing architecture, mutable URL, zero hash, excessive bound, and helper drift', () => {
    const cases: Array<(state: ReturnType<typeof fixture>) => void> = [
      ({ candidate }) => {
        const path = join(candidate, 'runtime-manifest.json');
        const value = manifest(path) as { targets: Record<string, unknown> };
        delete value.targets['linux-arm64'];
        writeFileSync(path, JSON.stringify(value));
      },
      ({ candidate }) => {
        const path = join(candidate, 'runtime-manifest.json');
        const value = manifest(path) as { targets: Record<string, { url: string }> };
        value.targets['linux-x64']!.url =
          'https://github.com/r-bart/pimpampum/releases/latest/download/runtime.tar.gz';
        writeFileSync(path, JSON.stringify(value));
      },
      ({ candidate }) => {
        const path = join(candidate, 'runtime-manifest.json');
        const value = manifest(path) as { targets: Record<string, { sha256: string }> };
        value.targets['linux-x64']!.sha256 = '0'.repeat(64);
        writeFileSync(path, JSON.stringify(value));
      },
      ({ candidate }) => {
        const path = join(candidate, 'runtime-manifest.json');
        const value = manifest(path) as { targets: Record<string, { maximumBytes: number }> };
        value.targets['linux-x64']!.maximumBytes = 100_663_297;
        writeFileSync(path, JSON.stringify(value));
      },
      ({ candidate }) => {
        const path = join(candidate, 'runtime-manifest.json');
        const value = manifest(path);
        value.version = '9.9.9';
        writeFileSync(path, JSON.stringify(value));
      },
      ({ candidate }) => chmodSync(join(candidate, 'pimpampum-update'), 0o644),
      ({ candidate }) => {
        const path = join(candidate, 'StatusPopout.qml');
        writeFileSync(
          path,
          `${readFileSync(path, 'utf8')}\n// Qt.resolvedUrl("pimpampum-unvalidated")\n`,
        );
      },
    ];
    for (const mutate of cases) {
      const state = fixture();
      mutate(state);
      expect(() => validateOmarchyDelivery(state.candidate)).toThrow(/validation failed/iu);
    }
  });

  it('rejects symlinked candidate content', () => {
    const state = fixture();
    symlinkSync('/tmp', join(state.candidate, 'unsafe-link'));
    expect(() => validateOmarchyDelivery(state.candidate)).toThrow(/symlink/iu);
  });
});

describe('Task 6.2 opt-in evidence runner', () => {
  it('records the exact scenario matrix, hashes, target, commit, durations, and data preservation', async () => {
    const state = fixture();
    const harness = task62Harness(state);
    const evidence = await createTask62LiveRunner(harness.dependencies).run({
      candidatePath: state.candidate,
      evidencePath: state.evidencePath,
      target: 'linux-x64',
    });
    expect(evidence.scenarios.map(({ id }: { id: string }) => id)).toEqual(TASK_6_2_SCENARIOS);
    expect(harness.dependencies.runScenario).toHaveBeenCalledTimes(TASK_6_2_SCENARIOS.length);
    expect(harness.preservedDataSha256).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.cleanup).toHaveBeenCalledOnce();
    expect(harness.writeEvidenceAtomic).toHaveBeenCalledOnce();
    expect(
      validateTask62Evidence({
        evidencePath: state.evidencePath,
        candidatePath: state.candidate,
        allowedRoot: state.root,
      }),
    ).toMatchObject({ status: 'passed', explicitOptIn: true, target: 'linux-x64' });
  });

  it('fails closed without opt-in, after a failed scenario, or when removal changes data', async () => {
    const noOptIn = fixture();
    const noOptInHarness = task62Harness(noOptIn);
    noOptInHarness.dependencies.environment.PIMPAMPUM_OMARCHY_DELIVERY_LIVE = '0';
    await expect(
      createTask62LiveRunner(noOptInHarness.dependencies).run({
        candidatePath: noOptIn.candidate,
        evidencePath: noOptIn.evidencePath,
        target: 'linux-x64',
      }),
    ).rejects.toThrow(/PIMPAMPUM_OMARCHY_DELIVERY_LIVE/u);
    expect(noOptInHarness.writeEvidenceAtomic).not.toHaveBeenCalled();

    const failed = fixture();
    const failedHarness = task62Harness(failed);
    failedHarness.dependencies.runScenario.mockResolvedValueOnce({
      passed: false,
      observed: 'wrong hash unexpectedly installed',
    });
    await expect(
      createTask62LiveRunner(failedHarness.dependencies).run({
        candidatePath: failed.candidate,
        evidencePath: failed.evidencePath,
        target: 'linux-arm64',
      }),
    ).rejects.toThrow(/scenario did not pass safely/iu);
    expect(failedHarness.dependencies.cleanup).toHaveBeenCalledOnce();
    expect(failedHarness.writeEvidenceAtomic).not.toHaveBeenCalled();

    const changed = fixture();
    const changedHarness = task62Harness(changed);
    changedHarness.preservedDataSha256
      .mockResolvedValueOnce('d'.repeat(64))
      .mockResolvedValueOnce('e'.repeat(64));
    await expect(
      createTask62LiveRunner(changedHarness.dependencies).run({
        candidatePath: changed.candidate,
        evidencePath: changed.evidencePath,
        target: 'linux-x64',
      }),
    ).rejects.toThrow(/changed preserved user data/iu);
    expect(changedHarness.dependencies.cleanup).toHaveBeenCalledOnce();
    expect(changedHarness.writeEvidenceAtomic).not.toHaveBeenCalled();
  });
});
