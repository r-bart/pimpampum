/**
 * @generated-from thoughts/specs/2026-08-27_real-development-session-evals.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiledCli = join(repositoryRoot, 'dist', 'cli.js');
const fixtureRoot = join(repositoryRoot, 'test', 'fixtures', 'development-session');
const sessionExecutable = join(fixtureRoot, 'session.mjs');
const fixtureEntries = ['package.json', 'spec.md', 'src', 'test'] as const;
const syntheticImplementation = `export function calculateTotal(values) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array');
  return values.reduce((total, value) => total + value, 0);
}
`;

interface Resource {
  id: string;
  revision: number;
  state: string;
}

interface CompletionDetails {
  completionSummary: string | null;
  artifacts: Array<{ label: string; uri: string }>;
  completedAt: string | null;
}

interface ActivityEvent {
  eventType: string;
  actor: string | null;
  data: Record<string, unknown>;
}

interface SessionEvidence {
  pid: number;
  action: string;
  agentId: string;
  repositoryPath: string;
  claim?: { targetType: string; targetId: string; agentId: string };
  commit?: string;
  released?: boolean;
  rejection?: { code: string; message: string };
  tests?: { passed: boolean; output: string };
  completion?: { state: string };
}

interface ProcessResult {
  pid: number;
  code: number;
  stdout: string;
  stderr: string;
}

interface WorkSetup {
  project: Resource;
  spec: Resource;
  target: Resource;
  targetType: 'spec' | 'task';
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a development-session E2E port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function runProcess(
  executable: string,
  arguments_: string[],
  options: { cwd: string; environment: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    if (pid === undefined) {
      reject(new Error(`Could not start ${executable}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolveResult({ pid, code: code ?? -1, stdout, stderr });
    });
  });
}

async function stopDaemon(daemon: ChildProcess | undefined): Promise<void> {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => daemon.kill('SIGKILL'), 2_000);
    daemon.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

function parseJson<T>(serialized: string, label: string): T {
  try {
    return JSON.parse(serialized) as T;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${serialized}`, { cause: error });
  }
}

describe.sequential('real synthetic development sessions through the compiled product', () => {
  let daemon: ChildProcess | undefined;
  let temporaryRoot = '';
  let dataDirectory = '';
  let fixtureRepository = '';
  let baseUrl = '';
  let gitEnvironment: NodeJS.ProcessEnv;
  let environment: NodeJS.ProcessEnv;
  const token = 'synthetic-development-session-token'.repeat(3);

  async function startDaemon(): Promise<void> {
    daemon = spawn(process.execPath, [compiledCli, 'serve'], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    daemon.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    for (let attempt = 0; attempt < 80; attempt++) {
      if (daemon.exitCode !== null) throw new Error(`Daemon exited during startup: ${stderr}`);
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) return;
      } catch {
        // The compiled daemon is still binding its loopback port.
      }
      await delay(50);
    }
    throw new Error(`Development-session daemon did not become healthy: ${stderr}`);
  }

  async function executeCli<T>(...arguments_: string[]): Promise<T> {
    const result = await runProcess(process.execPath, [compiledCli, ...arguments_], {
      cwd: fixtureRepository,
      environment,
    });
    if (result.code !== 0) {
      throw new Error(
        `Compiled CLI ${arguments_[0] ?? ''} failed (${String(result.code)}): ${result.stderr}`,
      );
    }
    return parseJson<T>(result.stdout, `Compiled CLI ${arguments_[0] ?? ''}`);
  }

  async function callTool<T>(name: string, input: Record<string, unknown>): Promise<T> {
    const envelope = await executeCli<{ data: T }>('call', name, '--input', JSON.stringify(input));
    return envelope.data;
  }

  async function runSession(input: {
    action: string;
    agentId: string;
    targetType: 'spec' | 'task';
    targetId: string;
    summary?: string;
    note?: string;
  }): Promise<SessionEvidence> {
    const result = await runProcess(
      process.execPath,
      [
        sessionExecutable,
        JSON.stringify({
          ...input,
          cliPath: compiledCli,
          repositoryPath: fixtureRepository,
        }),
      ],
      { cwd: fixtureRepository, environment },
    );
    if (result.code !== 0) {
      throw new Error(
        `Session ${input.action}/${input.agentId} failed (${String(result.code)}): ${result.stderr}`,
      );
    }
    const evidence = parseJson<SessionEvidence>(result.stdout, `Session ${input.action}`);
    expect(evidence).toMatchObject({
      pid: result.pid,
      action: input.action,
      agentId: input.agentId,
      repositoryPath: realpathSync(fixtureRepository),
    });
    return evidence;
  }

  function git(...arguments_: string[]): string {
    return execFileSync('git', arguments_, {
      cwd: fixtureRepository,
      env: gitEnvironment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  function verifyCommit(commit: string, expectedPath: string): void {
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(() => git('cat-file', '-e', `${commit}^{commit}`)).not.toThrow();
    expect(git('show', '--pretty=format:', '--name-only', commit).split('\n')).toContain(
      expectedPath,
    );
  }

  function verifyRepository(): void {
    const testOutput = execFileSync(process.execPath, ['--test'], {
      cwd: fixtureRepository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(testOutput).toMatch(/pass/iu);
    expect(readFileSync(join(fixtureRepository, 'src', 'calculateTotal.js'), 'utf8')).toBe(
      syntheticImplementation,
    );
    expect(git('status', '--porcelain')).toBe('');
  }

  async function setupWork(targetType: 'spec' | 'task'): Promise<WorkSetup> {
    await executeCli(
      'workspace:add',
      'synthetic-dev-workspace',
      'Synthetic Development Workspace',
      fixtureRepository,
    );
    const project = await executeCli<Resource>(
      'project:create',
      'synthetic-dev-workspace',
      `synthetic-${targetType}-project`,
      `Synthetic ${targetType} development project`,
    );
    const spec = await executeCli<Resource>(
      'spec:create',
      project.id,
      `synthetic-${targetType}-spec`,
      `Synthetic ${targetType} development spec`,
      join(fixtureRepository, 'spec.md'),
    );
    const task =
      targetType === 'task'
        ? await executeCli<Resource>(
            'task:create',
            spec.id,
            'Implement the synthetic calculateTotal function',
          )
        : undefined;
    const readySpec = await executeCli<Resource>('spec:ready', spec.id, String(spec.revision));
    await executeCli<Resource>('project:open', project.id, String(project.revision));
    return { project, spec: readySpec, target: task ?? readySpec, targetType };
  }

  beforeEach(async () => {
    // Spec: FR-1, FR-2, FR-5
    if (!existsSync(compiledCli)) throw new Error('Run npm run build before development E2E');
    if (!existsSync(sessionExecutable)) {
      throw new Error('The bounded development-session executable has not been implemented');
    }
    temporaryRoot = mkdtempSync(join(tmpdir(), 'pimpampum-real-dev-session-'));
    dataDirectory = join(temporaryRoot, 'pimpampum-data');
    fixtureRepository = join(temporaryRoot, 'synthetic repository');
    mkdirSync(fixtureRepository, { recursive: true });
    for (const entry of fixtureEntries) {
      cpSync(join(fixtureRoot, entry), join(fixtureRepository, entry), { recursive: true });
    }
    fixtureRepository = realpathSync(fixtureRepository);
    const gitGlobalConfig = join(temporaryRoot, 'isolated-git-global-config');
    const gitTemplateDirectory = join(temporaryRoot, 'isolated-git-template');
    writeFileSync(gitGlobalConfig, '', { encoding: 'utf8', mode: 0o600 });
    mkdirSync(gitTemplateDirectory, { mode: 0o700 });
    gitEnvironment = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
      ),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: gitGlobalConfig,
      GIT_TEMPLATE_DIR: gitTemplateDirectory,
      GIT_TERMINAL_PROMPT: '0',
    };
    git('init', '--quiet', `--template=${gitTemplateDirectory}`);
    git('config', 'user.name', 'Pimpampum Synthetic Eval');
    git('config', 'user.email', 'synthetic-eval@invalid.example');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'test: seed synthetic development repository');
    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    environment = {
      ...gitEnvironment,
      PIMPAMPUM_DATA_DIR: dataDirectory,
      PIMPAMPUM_HOST: '127.0.0.1',
      PIMPAMPUM_PORT: String(port),
      PIMPAMPUM_TOKEN: token,
    };
    await startDaemon();
  });

  afterEach(async () => {
    await stopDaemon(daemon);
    daemon = undefined;
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('US-1: hands tested repository work from one independent session to another', async () => {
    // Spec: US-1/AC-1 through AC-5, FR-1, FR-2, FR-3, FR-5
    const work = await setupWork('task');
    const owner = await runSession({
      action: 'checkpoint-partial',
      agentId: 'synthetic-owner-session',
      targetType: work.targetType,
      targetId: work.target.id,
    });
    expect(owner.claim).toMatchObject({
      targetType: 'task',
      targetId: work.target.id,
      agentId: 'synthetic-owner-session',
    });
    verifyCommit(owner.commit ?? '', 'src/calculateTotal.js');
    expect(readFileSync(join(fixtureRepository, 'src', 'calculateTotal.js'), 'utf8')).toContain(
      'synthetic checkpoint: intentionally incomplete',
    );

    const competitor = await runSession({
      action: 'attempt-claim',
      agentId: 'synthetic-competing-session',
      targetType: work.targetType,
      targetId: work.target.id,
    });
    expect(competitor.rejection).toMatchObject({ code: 'conflict' });

    const handoffNote =
      'Synthetic handoff: replace the checkpoint implementation, run tests, and commit the result.';
    const release = await runSession({
      action: 'release-handoff',
      agentId: 'synthetic-owner-session',
      targetType: work.targetType,
      targetId: work.target.id,
      note: handoffNote,
    });
    expect(release.released).toBe(true);

    const summary = 'Synthetic calculateTotal implementation completed with repository tests.';
    const finisher = await runSession({
      action: 'finish-and-complete',
      agentId: 'synthetic-finisher-session',
      targetType: work.targetType,
      targetId: work.target.id,
      summary,
    });
    expect(finisher.tests).toMatchObject({ passed: true });
    expect(finisher.completion).toMatchObject({ state: 'done' });
    verifyCommit(finisher.commit ?? '', 'src/calculateTotal.js');
    expect(new Set([owner.pid, competitor.pid, release.pid, finisher.pid]).size).toBe(4);

    verifyRepository();
    const completion = await callTool<CompletionDetails>('task_completion_get', {
      taskId: work.target.id,
    });
    expect(completion).toMatchObject({
      completionSummary: summary,
      artifacts: [{ label: 'synthetic git commit', uri: `git:${String(finisher.commit)}` }],
    });
    expect(completion.completedAt).toBeTruthy();

    const activity = await callTool<ActivityEvent[]>('activity_list', {
      projectId: work.project.id,
      limit: 100,
    });
    expect(activity).toContainEqual(
      expect.objectContaining({
        eventType: 'work.released',
        actor: 'synthetic-owner-session',
        data: expect.objectContaining({ note: handoffNote }),
      }),
    );
  }, 30_000);

  it('US-2: resumes tested work from a new process after a compiled daemon restart', async () => {
    // Spec: US-2/AC-1 through AC-4, FR-1, FR-2, FR-4, FR-5
    const work = await setupWork('spec');
    const checkpoint = await runSession({
      action: 'claim-tested-checkpoint',
      agentId: 'synthetic-resilient-session',
      targetType: work.targetType,
      targetId: work.target.id,
    });
    expect(checkpoint.tests).toMatchObject({ passed: true });
    verifyCommit(checkpoint.commit ?? '', 'src/calculateTotal.js');

    await stopDaemon(daemon);
    daemon = undefined;
    await startDaemon();

    const competitor = await runSession({
      action: 'attempt-claim',
      agentId: 'synthetic-restart-competitor',
      targetType: work.targetType,
      targetId: work.target.id,
    });
    expect(competitor.rejection).toMatchObject({ code: 'conflict' });

    const summary = 'Synthetic tested checkpoint resumed and completed after daemon restart.';
    const resumed = await runSession({
      action: 'resume-and-complete',
      agentId: 'synthetic-resilient-session',
      targetType: work.targetType,
      targetId: work.target.id,
      summary,
    });
    expect(resumed.claim).toMatchObject({
      targetType: 'spec',
      targetId: work.target.id,
      agentId: 'synthetic-resilient-session',
    });
    expect(resumed.tests).toMatchObject({ passed: true });
    expect(resumed.completion).toMatchObject({ state: 'done' });
    expect(resumed.commit).toBe(checkpoint.commit);
    expect(new Set([checkpoint.pid, competitor.pid, resumed.pid]).size).toBe(3);

    verifyRepository();
    const completion = await callTool<CompletionDetails>('spec_completion_get', {
      specId: work.target.id,
    });
    expect(completion).toMatchObject({
      completionSummary: summary,
      artifacts: [{ label: 'synthetic git commit', uri: `git:${String(checkpoint.commit)}` }],
    });
    expect(completion.completedAt).toBeTruthy();
  }, 30_000);
});
