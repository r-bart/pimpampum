import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertCompiledBuild,
  availablePort,
  runCompiledCli,
  startCompiledDaemon,
  stopDaemon,
  type CompiledDaemon,
} from './helpers/compiledDaemon.js';

const token = 'shared-sync-e2e-token'.repeat(3);

describe.sequential('compiled shared-folder synchronization end to end', () => {
  let temporary = '';
  let shared = '';
  let workspaceA = '';
  let workspaceB = '';
  let environmentA: NodeJS.ProcessEnv;
  let environmentB: NodeJS.ProcessEnv;
  let daemonA: CompiledDaemon | undefined;
  let daemonB: CompiledDaemon | undefined;

  const commandA = <T>(...arguments_: string[]) =>
    runCompiledCli<T>(arguments_, { environment: environmentA });
  const commandB = <T>(...arguments_: string[]) =>
    runCompiledCli<T>(arguments_, { environment: environmentB });

  beforeAll(async () => {
    assertCompiledBuild();
    temporary = mkdtempSync(join(tmpdir(), 'pimpampum-compiled-sync-'));
    shared = join(temporary, 'Drive');
    workspaceA = join(temporary, 'workspace-a');
    workspaceB = join(temporary, 'workspace-b');
    mkdirSync(shared);
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const [portA, portB] = await Promise.all([availablePort(), availablePort()]);
    environmentA = {
      ...process.env,
      PIMPAMPUM_DATA_DIR: join(temporary, 'a'),
      PIMPAMPUM_PORT: String(portA),
      PIMPAMPUM_TOKEN: token,
    };
    environmentB = {
      ...process.env,
      PIMPAMPUM_DATA_DIR: join(temporary, 'b'),
      PIMPAMPUM_PORT: String(portB),
      PIMPAMPUM_TOKEN: token,
    };
    // The helper rejects with the daemon's stderr when it exits early or never answers `/health`,
    // so a missing build or a port clash names its cause instead of "did not start".
    [daemonA, daemonB] = await Promise.all([
      startCompiledDaemon({ environment: environmentA, port: portA }),
      startCompiledDaemon({ environment: environmentB, port: portB }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([stopDaemon(daemonA?.process), stopDaemon(daemonB?.process)]);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });

  it('moves all Projects between machines and merges unrelated concurrent work', async () => {
    await commandA('sync', 'configure', shared, '--device', 'macbook');
    await commandA('workspace:add', 'portfolio', 'Portfolio', workspaceA);
    const initial = await commandA<{ id: string }>(
      'project:create',
      'portfolio',
      'initial',
      'Initial',
    );
    const spec = await commandA<{ id: string }>(
      'spec:create',
      initial.id,
      'shared-state',
      'Shared state',
    );
    await commandA('task:create', spec.id, 'Verify second machine');
    await commandA('sync', 'now');

    await commandB('sync', 'configure', shared, '--device', 'linux');
    await commandB('workspace:add', 'portfolio', 'Portfolio', workspaceB);
    expect(
      await commandB<{ counts: { projects: number; specs: number; openTasks: number } }>(
        'overview',
      ),
    ).toMatchObject({ counts: { projects: 1, specs: 1, openTasks: 1 } });
    await commandA('project:create', 'portfolio', 'from-mac', 'From Mac');
    await commandB('project:create', 'portfolio', 'from-linux', 'From Linux');
    await Promise.all([commandA('sync', 'now'), commandB('sync', 'now')]);
    await Promise.all([commandA('sync', 'now'), commandB('sync', 'now')]);
    const [overviewA, overviewB] = await Promise.all([
      commandA<{ counts: { projects: number } }>('overview'),
      commandB<{ counts: { projects: number } }>('overview'),
    ]);
    expect(overviewA.counts.projects).toBe(3);
    expect(overviewB.counts.projects).toBe(3);
    expect(await commandA('sync', 'conflicts')).toEqual([]);
    expect(await commandB('sync', 'conflicts')).toEqual([]);
    expect(await commandA('sync', 'status')).toMatchObject({
      state: 'healthy',
      error: null,
      blockedSnapshot: null,
      conflictCount: 0,
    });

    // Every file the compiled daemon writes uses the locale-independent format.
    const deviceDirectory = join(shared, 'Pimpampum', 'devices', 'macbook');
    const snapshots = readdirSync(deviceDirectory).map(
      (name) =>
        JSON.parse(readFileSync(join(deviceDirectory, name), 'utf8')) as {
          schemaVersion: number;
          appliedHeads?: Record<string, string>;
          baseState?: unknown;
        },
    );
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot.schemaVersion).toBe(2);
      expect(snapshot.appliedHeads).toBeDefined();
      expect(snapshot).not.toHaveProperty('baseState');
    }
    expect(snapshots.at(-1)!.appliedHeads).toHaveProperty('linux');
  }, 60_000);
});
