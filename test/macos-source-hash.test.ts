import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const module = join(process.cwd(), 'scripts/macosSourceHash.mjs');
const roots: string[] = [];

const inputs = [
  'platforms/macos/Package.swift',
  'platforms/macos/Sources/App.swift',
  'platforms/macos/Resources/Info.plist',
  'branding/app-icon/icon.json',
  'scripts/build-macos-app.sh',
];

function isolatedGitEnvironment(root: string): NodeJS.ProcessEnv {
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

function repository(): { root: string; env: NodeJS.ProcessEnv } {
  const container = mkdtempSync(join(tmpdir(), 'pimpampum-macos-source-hash-'));
  roots.push(container);
  const root = join(container, 'repository');
  mkdirSync(root, { recursive: true });
  const env = isolatedGitEnvironment(container);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git('init', '--quiet');
  writeFileSync(join(root, '.gitignore'), '.DS_Store\n');
  for (const input of inputs) {
    mkdirSync(join(root, dirname(input)), { recursive: true });
    writeFileSync(join(root, input), `contents of ${input}\n`);
  }
  git('add', '--all');
  git('commit', '--quiet', '--message', 'fixture');
  return { root, env };
}

function hash(root: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { macosSourceHash } from ${JSON.stringify(module)};
       process.stdout.write(macosSourceHash(process.argv[1]));`,
      root,
    ],
    { encoding: 'utf8', env },
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('macOS source input hash', () => {
  it('hashes the tracked build inputs deterministically', () => {
    const { root, env } = repository();
    const digest = hash(root, env);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(hash(root, env)).toBe(digest);
  });

  it('ignores untracked working-tree files that Git ignores', () => {
    const { root, env } = repository();
    const digest = hash(root, env);
    writeFileSync(join(root, 'platforms/macos/Sources/.DS_Store'), 'finder metadata');
    writeFileSync(join(root, 'branding/app-icon/.DS_Store'), 'finder metadata');
    expect(hash(root, env)).toBe(digest);
  });

  it('changes when a reviewed build input changes', () => {
    const { root, env } = repository();
    const digest = hash(root, env);
    writeFileSync(join(root, 'platforms/macos/Sources/App.swift'), 'edited\n');
    expect(hash(root, env)).not.toBe(digest);
  });

  it('rejects a build input that became a symlink', () => {
    const { root, env } = repository();
    const target = join(root, 'platforms/macos/Sources/App.swift');
    rmSync(target);
    symlinkSync('/etc/hostname', target);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { macosSourceHash } from ${JSON.stringify(module)};
         macosSourceHash(process.argv[1]);`,
        root,
      ],
      { encoding: 'utf8', env },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must not be a symlink');
  });
});
