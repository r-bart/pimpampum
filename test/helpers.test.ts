import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertCompiledBuild,
  availablePort,
  compiledCliPath,
  repositoryRoot,
  unwrapCliEnvelope,
} from './helpers/compiledDaemon.js';
import { createConnectorHarness } from './helpers/connectorHarness.js';
import { isolatedGitEnvironment, runGitQuiet } from './helpers/git.js';
import { acknowledgingOpen, adapterContext, commandResult, success } from './helpers/service.js';
import { lifecycleDependencies, setupDependencies } from './helpers/setupDependencies.js';
import { temporaryDirectory } from './helpers/tmp.js';

let directoryFromPreviousTest = '';
const moduleScopedDirectory = temporaryDirectory('pimpampum-helpers-module-');

describe('shared test helpers', () => {
  it('creates a fresh temporary directory inside a test and removes it when the test ends', () => {
    const directory = temporaryDirectory('pimpampum-helpers-');
    directoryFromPreviousTest = directory;
    expect(statSync(directory).isDirectory()).toBe(true);
    expect(directory).not.toBe(temporaryDirectory('pimpampum-helpers-'));
    expect(statSync(moduleScopedDirectory).isDirectory()).toBe(true);
  });

  it('has removed the previous test directory and the module-scoped one', () => {
    expect(directoryFromPreviousTest).not.toBe('');
    expect(existsSync(directoryFromPreviousTest)).toBe(false);
    expect(existsSync(moduleScopedDirectory)).toBe(false);
  });

  it('unwraps exactly one {data} envelope and names the command on failure', () => {
    expect(unwrapCliEnvelope<{ status: string }>('{"data":{"status":"ok"}}')).toEqual({
      status: 'ok',
    });
    expect(() => unwrapCliEnvelope('not json', 'pimpampum health')).toThrow(
      /pimpampum health returned invalid JSON/u,
    );
    expect(() => unwrapCliEnvelope('{"data":1,"extra":2}', 'pimpampum health')).toThrow(
      /did not return one data envelope/u,
    );
    expect(() => unwrapCliEnvelope('{"error":{"code":"unavailable"}}')).toThrow(
      /CLI did not return one data envelope/u,
    );
  });

  it('names the missing compiled file and the build command', async () => {
    const missing = join(temporaryDirectory(), 'dist', 'cli.js');
    expect(() => assertCompiledBuild([missing])).toThrow(/Compiled build missing: .*cli\.js/u);
    expect(() => assertCompiledBuild([missing])).toThrow(/npm run build/u);
    expect(compiledCliPath()).toBe(join(repositoryRoot, 'dist', 'cli.js'));
    expect(existsSync(join(repositoryRoot, 'package.json'))).toBe(true);
    const port = await availablePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });

  it('isolates Git from the developer environment and runs it quietly', () => {
    const root = temporaryDirectory();
    const environment = isolatedGitEnvironment(root);
    expect(
      Object.keys(environment)
        .filter((name) => name.startsWith('GIT_'))
        .sort(),
    ).toEqual([
      'GIT_ATTR_NOSYSTEM',
      'GIT_AUTHOR_EMAIL',
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TEMPLATE_DIR',
      'GIT_TERMINAL_PROMPT',
    ]);
    expect(statSync(environment.GIT_CONFIG_GLOBAL!).size).toBe(0);
    const repository = join(root, 'repository');
    runGitQuiet(['init', '--quiet', repository], root, environment);
    expect(() => runGitQuiet(['rev-parse', 'HEAD'], repository, environment)).toThrow(
      /git rev-parse HEAD failed \(128\)/u,
    );
    writeFileSync(join(repository, 'README.md'), 'isolated\n');
    runGitQuiet(['add', 'README.md'], repository, environment);
    runGitQuiet(['commit', '--quiet', '--message', 'init'], repository, environment);
    expect(runGitQuiet(['log', '-1', '--format=%an <%ae>'], repository, environment)).toBe(
      'Pimpampum <pimpampum@example.invalid>',
    );
  });

  it('builds service adapter contexts and a login-acknowledging open command', async () => {
    const dataDirectory = temporaryDirectory();
    const context = adapterContext({ homeDirectory: '/home/test', dataDirectory, port: 8080 });
    expect(context).toMatchObject({
      homeDirectory: '/home/test',
      dataDirectory,
      port: 8080,
      logDirectory: join(dataDirectory, 'logs'),
    });
    expect(await context.runCommand('/usr/bin/true', [])).toEqual(success());
    expect(commandResult({ exitCode: 3, stderr: 'denied' })).toEqual({
      exitCode: 3,
      stdout: '',
      stderr: 'denied',
    });
    const open = acknowledgingOpen({ dataDirectory, previousStatus: 'requiresApproval' });
    expect(
      await open('/usr/bin/open', ['-n', '/App.app', '--args', '--unregister-login-item']),
    ).toEqual(success());
    expect(
      JSON.parse(
        readFileSync(join(dataDirectory, 'login-unregistration-acknowledgement.json'), 'utf8'),
      ),
    ).toEqual({
      createdAt: '2026-08-26T20:00:00.000Z',
      previousStatus: 'requiresApproval',
      status: 'disabled',
    });
    expect(await open('/usr/bin/launchctl', ['print'])).toEqual(success());
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('builds setup and lifecycle dependencies whose fakes record their calls', async () => {
    const root = temporaryDirectory();
    const setup = setupDependencies(root, { now: () => '2026-09-01T00:00:00.000Z' });
    expect(setup.dataDirectory).toBe(join(root, 'data'));
    expect(setup.now()).toBe('2026-09-01T00:00:00.000Z');
    expect(await setup.connectors.codex.inspect()).toEqual({ state: 'notConnected' });
    const lifecycle = lifecycleDependencies(root, {
      service: { stop: async () => undefined },
    });
    const staged = await lifecycle.runtime.stage('2.0.0');
    await lifecycle.service.stop();
    await lifecycle.receipt.commit({ ...lifecycle.current.value, runtimeVersion: '2.0.0' });
    expect(staged.cliPath).toBe(join(root, 'runtime', '2.0.0', 'dist/cli.js'));
    expect(lifecycle.events).toEqual(['runtime.stage', 'receipt.commit']);
    expect(lifecycle.current.value.runtimeVersion).toBe('2.0.0');
  });

  it('drives both connector hosts through their fake official CLIs', async () => {
    const codex = createConnectorHarness('codex');
    expect(codex.entry()).toBeNull();
    expect(existsSync(codex.executable)).toBe(true);
    const claude = createConnectorHarness('claude-code', { target: { command: 'other' } });
    expect(claude.readTarget()).toEqual({ command: 'other' });
    claude.writeTarget(undefined);
    expect(claude.readTarget()).toBeUndefined();
    const result = await claude.run({ executable: claude.executable, arguments: ['--version'] });
    expect(result).toMatchObject({ exitCode: 0, signal: null });
  });
});
