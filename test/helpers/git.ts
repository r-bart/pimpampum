import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Builds a Git environment that cannot see the developer's configuration: inherited `GIT_*`
 * variables are dropped, the system config and attributes are disabled, and the global config and
 * template directory point at empty files created under `root`. Identity is fixed so commits are
 * reproducible. This is the CLAUDE.md rule for every Git-driven eval.
 */
export function isolatedGitEnvironment(root: string): NodeJS.ProcessEnv {
  const globalConfig = join(root, 'gitconfig');
  const templateDirectory = join(root, 'git-template');
  writeFileSync(globalConfig, '');
  mkdirSync(templateDirectory, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('GIT_')) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_TEMPLATE_DIR: templateDirectory,
    GIT_AUTHOR_NAME: 'Pimpampum',
    GIT_AUTHOR_EMAIL: 'pimpampum@example.invalid',
    GIT_COMMITTER_NAME: 'Pimpampum',
    GIT_COMMITTER_EMAIL: 'pimpampum@example.invalid',
  };
}

let sharedIsolationRoot: string | undefined;

/**
 * One isolated Git environment per worker, for callers that do not own a temporary root. Its
 * config files live in a private `mkdtemp` directory removed when the process exits.
 */
export function sharedIsolatedGitEnvironment(): NodeJS.ProcessEnv {
  if (sharedIsolationRoot === undefined) {
    const root = mkdtempSync(join(tmpdir(), 'pimpampum-git-isolation-'));
    sharedIsolationRoot = root;
    process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  }
  return isolatedGitEnvironment(sharedIsolationRoot);
}

/**
 * Runs `git` with stdin ignored and both output streams captured, so nothing reaches the vitest
 * output. Returns trimmed stdout. A non-zero exit throws with the exit code and stderr.
 */
export function runGitQuiet(
  arguments_: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = sharedIsolatedGitEnvironment(),
): string {
  try {
    return execFileSync('git', [...arguments_], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const failure = error as { status?: number | null; stderr?: string | Buffer };
    const stderr = failure.stderr === undefined ? '' : failure.stderr.toString().trim();
    throw new Error(
      `git ${arguments_.join(' ')} failed (${String(failure.status ?? 'signal')}) in ${cwd}: ${stderr}`,
      { cause: error },
    );
  }
}
