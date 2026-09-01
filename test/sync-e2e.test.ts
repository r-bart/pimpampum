import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');
const token = 'shared-sync-e2e-token'.repeat(3);

async function port(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No port'));
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function command(environment: NodeJS.ProcessEnv, args: string[]): Promise<unknown> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`${args.join(' ')} failed: ${stderr}`));
        return;
      }
      // Unwrapping here asserts the envelope contract on every CLI call this suite makes:
      // a success is always exactly one {"data": ...} object on stdout.
      const envelope = JSON.parse(stdout) as unknown;
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        Object.keys(envelope).length !== 1 ||
        !('data' in envelope)
      ) {
        reject(new Error(`${args.join(' ')} did not return one data envelope: ${stdout}`));
        return;
      }
      resolveResult((envelope as { data: unknown }).data);
    });
  });
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveStop) => child.once('exit', () => resolveStop()));
}

describe.sequential('compiled shared-folder synchronization end to end', () => {
  let temporary = '';
  let shared = '';
  let workspaceA = '';
  let workspaceB = '';
  let environmentA: NodeJS.ProcessEnv;
  let environmentB: NodeJS.ProcessEnv;
  let daemonA: ChildProcess | undefined;
  let daemonB: ChildProcess | undefined;

  beforeAll(async () => {
    temporary = mkdtempSync(join(tmpdir(), 'pimpampum-compiled-sync-'));
    shared = join(temporary, 'Drive');
    workspaceA = join(temporary, 'workspace-a');
    workspaceB = join(temporary, 'workspace-b');
    mkdirSync(shared);
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const [portA, portB] = await Promise.all([port(), port()]);
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
    daemonA = spawn(process.execPath, [cli, 'serve'], {
      cwd: root,
      env: environmentA,
      stdio: 'ignore',
    });
    daemonB = spawn(process.execPath, [cli, 'serve'], {
      cwd: root,
      env: environmentB,
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        await Promise.all([command(environmentA, ['health']), command(environmentB, ['health'])]);
        return;
      } catch {
        await delay(50);
      }
    }
    throw new Error('Compiled sync daemons did not start');
  });

  afterAll(async () => {
    await Promise.all([stop(daemonA), stop(daemonB)]);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  });

  it('moves all Projects between machines and merges unrelated concurrent work', async () => {
    await command(environmentA, ['sync', 'configure', shared, '--device', 'macbook']);
    await command(environmentA, ['workspace:add', 'portfolio', 'Portfolio', workspaceA]);
    const initial = (await command(environmentA, [
      'project:create',
      'portfolio',
      'initial',
      'Initial',
    ])) as { id: string };
    const spec = (await command(environmentA, [
      'spec:create',
      initial.id,
      'shared-state',
      'Shared state',
    ])) as { id: string };
    await command(environmentA, ['task:create', spec.id, 'Verify second machine']);
    await command(environmentA, ['sync', 'now']);

    await command(environmentB, ['sync', 'configure', shared, '--device', 'linux']);
    await command(environmentB, ['workspace:add', 'portfolio', 'Portfolio', workspaceB]);
    expect(
      (await command(environmentB, ['overview'])) as {
        counts: { projects: number; specs: number; openTasks: number };
      },
    ).toMatchObject({ counts: { projects: 1, specs: 1, openTasks: 1 } });
    await command(environmentA, ['project:create', 'portfolio', 'from-mac', 'From Mac']);
    await command(environmentB, ['project:create', 'portfolio', 'from-linux', 'From Linux']);
    await Promise.all([
      command(environmentA, ['sync', 'now']),
      command(environmentB, ['sync', 'now']),
    ]);
    await Promise.all([
      command(environmentA, ['sync', 'now']),
      command(environmentB, ['sync', 'now']),
    ]);
    const [overviewA, overviewB] = await Promise.all([
      command(environmentA, ['overview']) as Promise<{ counts: { projects: number } }>,
      command(environmentB, ['overview']) as Promise<{ counts: { projects: number } }>,
    ]);
    expect(overviewA.counts.projects).toBe(3);
    expect(overviewB.counts.projects).toBe(3);
    expect(await command(environmentA, ['sync', 'conflicts'])).toEqual([]);
    expect(await command(environmentB, ['sync', 'conflicts'])).toEqual([]);
    expect(await command(environmentA, ['sync', 'status'])).toMatchObject({
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
