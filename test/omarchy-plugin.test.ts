import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const pluginSource = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
const validator = join(repositoryRoot, 'scripts/validate-omarchy-plugin.mjs');
const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-omarchy-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeLifecycle(
  label: string,
  exitCode = 0,
): {
  environment: NodeJS.ProcessEnv;
  log: string;
  untouched: string;
} {
  const root = temporaryDirectory(label);
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  const untouched = join(root, 'plugins');
  mkdirSync(bin, { recursive: true });
  mkdirSync(untouched, { recursive: true });
  writeFileSync(join(untouched, 'unrelated-plugin'), 'unchanged');
  const executable = join(bin, 'pimpampum');
  writeFileSync(
    executable,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
exit "$FAKE_EXIT_CODE"
`,
    { mode: 0o755 },
  );
  chmodSync(executable, 0o755);
  return {
    environment: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_LOG: log,
      FAKE_EXIT_CODE: String(exitCode),
      PIMPAMPUM_CLI: executable,
    },
    log,
    untouched,
  };
}

/** A writable copy of the reviewed plugin, so a test can break one invariant and ask the validator. */
function candidate(label: string): string {
  const copy = join(temporaryDirectory(label), 'candidate');
  cpSync(pluginSource, copy, { recursive: true });
  return copy;
}

function validate(pluginRoot: string) {
  return spawnSync(process.execPath, [validator, pluginRoot], { encoding: 'utf8' });
}

/** The QML file of the candidate that holds `fragment`; the contract does not pin which one. */
function qmlFileContaining(pluginRoot: string, fragment: string): string {
  const name = readdirSync(pluginRoot)
    .filter((entry) => entry.endsWith('.qml'))
    .find((entry) => readFileSync(join(pluginRoot, entry), 'utf8').includes(fragment));
  if (!name) throw new Error(`no QML file contains ${fragment}`);
  return name;
}

function rewrite(
  pluginRoot: string,
  target: string | ((pluginRoot: string) => string),
  edit: (source: string) => string,
): void {
  const name = typeof target === 'function' ? target(pluginRoot) : target;
  const path = join(pluginRoot, name);
  const before = readFileSync(path, 'utf8');
  const after = edit(before);
  if (after === before) throw new Error(`mutation did not change ${name}`);
  writeFileSync(path, after);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Omarchy Quattro plugin', () => {
  it('passes the cross-platform manifest, QML and frozen-fixture validator', () => {
    expect(execFileSync(process.execPath, [validator], { encoding: 'utf8' })).toContain(
      'Validated Omarchy plugin',
    );
  });

  it('rejects a candidate whose fixture drifts from the frozen shared contract', () => {
    const plugin = candidate('fixture-drift');
    writeFileSync(join(plugin, 'fixtures/mixed.json'), '{}\n');

    const result = validate(plugin);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from frozen shared fixture');
  });

  // The validator is the one place the QML contract is spelled out; these cases prove it rejects
  // the regressions this suite used to grep for, instead of re-asserting the QML text here.
  it.each([
    [
      'an update reader that accepts only the {data} envelope',
      'UpdateService.qml',
      (source: string) =>
        source.replace(
          'isObject(envelope) && isObject(envelope.data) ? envelope.data : envelope',
          'envelope.data',
        ),
      'must accept both the bare payload and the {data} envelope',
    ],
    [
      'popout copy that sends the user to npm',
      // The Updates card moved to the settings page during the QML split; the sweep covers the
      // whole popout surface, so the mutation follows the copy instead of pinning a file name.
      (plugin: string) => qmlFileContaining(plugin, 'Check for a newer Pimpampum release'),
      (source: string) =>
        source.replace(
          '"Check for a newer Pimpampum release. Nothing changes until you install it."',
          '"Check npm for a newer Pimpampum release. Nothing changes until you install it."',
        ),
      'must not name npm',
    ],
    [
      'a helper launched through a shell with an interpolated path',
      // The directory opener moved between services during the QML split; the sweep covers every
      // QML file, so the mutation follows the fragment instead of pinning a file name.
      (plugin: string) => qmlFileContaining(plugin, 'var arguments = ["xdg-open", directory]'),
      (source: string) =>
        source.replace(
          'var arguments = ["xdg-open", directory]',
          'var arguments = ["sh", "-c", "xdg-open " + directory]',
        ),
      'must not interpolate paths into shell commands',
    ],
    [
      'settings copy that leaks into the portfolio page',
      // The validator addresses surfaces, not files: the settings controls belong to the settings
      // page, and the portfolio must not grow a second copy of one.
      (plugin: string) => qmlFileContaining(plugin, 'text: "Active work ("'),
      (source: string) =>
        source.replace('text: "Active work ("', 'title: "Backup"\n    text: "Active work ("'),
      'leave the dedicated settings controls out',
    ],
    [
      'a service control that reads stdout before the collector publishes it',
      'ServiceControl.qml',
      (source: string) =>
        source.replace(
          'Qt.callLater(function() { root.accept(exitCode) })',
          'root.accept(exitCode)',
        ),
      'deferred turn',
    ],
  ])('rejects %s', (_label, file, mutate, verdict) => {
    const plugin = candidate('mutation');
    rewrite(plugin, file, mutate);

    const result = validate(plugin);
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toContain(verdict);
  });

  // The surface rule is not "the copy exists somewhere in the popout": the empty state belongs to
  // the portfolio page, so moving its explanation to the help page of the same popout must fail.
  it('rejects empty-state copy moved to another page of the same popout', () => {
    const plugin = candidate('surface-move');
    const explanation = '"Projects appear here as your agents create them."';
    const portfolioFile = qmlFileContaining(plugin, explanation);
    const helpAnchor = '"Inspect both candidates before resolving a conflict:"';
    const helpFile = qmlFileContaining(plugin, helpAnchor);
    rewrite(plugin, portfolioFile, (source) =>
      source.replace(explanation, '"Projects appear here."'),
    );
    rewrite(plugin, helpFile, (source) => source.replace(helpAnchor, explanation));

    const result = validate(plugin);
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toContain('empty states must teach');
    expect(result.stderr).toContain('the PortfolioPage surface');
  });

  it('delegates install and uninstall to the single Pimpampum lifecycle', () => {
    const fake = fakeLifecycle('wrappers');
    const before = readdirSync(fake.untouched);

    execFileSync('/bin/bash', [join(pluginSource, 'install.sh')], { env: fake.environment });
    execFileSync('/bin/bash', [join(pluginSource, 'uninstall.sh')], { env: fake.environment });

    expect(readFileSync(fake.log, 'utf8')).toBe('install\nuninstall\n');
    expect(readdirSync(fake.untouched)).toEqual(before);
    expect(readFileSync(join(fake.untouched, 'unrelated-plugin'), 'utf8')).toBe('unchanged');
  });

  it('propagates lifecycle command failures without a fallback mutation path', () => {
    const fake = fakeLifecycle('wrapper-failure', 42);
    const before = readdirSync(fake.untouched);

    const result = spawnSync('/bin/bash', [join(pluginSource, 'install.sh')], {
      env: fake.environment,
      encoding: 'utf8',
    });

    expect(result.status).toBe(42);
    expect(readFileSync(fake.log, 'utf8')).toBe('install\n');
    expect(readdirSync(fake.untouched)).toEqual(before);
  });
});

// D-01: the popout's "Add a workspace" hands the chosen folder to the bounded route, which turns it
// into the CLI's `workspace:add <id> <name> <root-path>` through the receipt-owned launcher.
describe('bounded Omarchy workspace route', () => {
  const route = join(pluginSource, 'pimpampum-control-route');

  function launcherFixture(label: string, homeName = 'home') {
    const root = temporaryDirectory(label);
    const home = join(root, homeName);
    const data = join(home, '.pimpampum');
    const launcher = join(home, '.local/share/pimpampum/bin/pimpampum-control');
    const log = join(root, 'arguments.log');
    mkdirSync(data, { recursive: true });
    mkdirSync(join(home, '.local/share/pimpampum/bin'), { recursive: true });
    writeFileSync(
      launcher,
      `#!/bin/sh
printf '%s\\n' "$@" >> "$PIMPAMPUM_FAKE_LOG"
printf -- '---\\n' >> "$PIMPAMPUM_FAKE_LOG"
printf '%s\\n' '{ "data": { "id": "x", "name": "X", "rootPath": "/x" } }'
`,
      { mode: 0o755 },
    );
    const launcherSha256 = createHash('sha256').update(readFileSync(launcher)).digest('hex');
    writeFileSync(
      join(data, 'runtime-install-receipt.json'),
      `${JSON.stringify(
        { schemaVersion: 1, controlLauncherPath: launcher, controlLauncherSha256: launcherSha256 },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    writeFileSync(log, '');
    return { home, log };
  }

  function run(state: { home: string; log: string }, arguments_: string[]) {
    return spawnSync('/bin/sh', [route, ...arguments_], {
      encoding: 'utf8',
      env: { HOME: state.home, PIMPAMPUM_FAKE_LOG: state.log },
    });
  }

  function loggedInvocations(state: { log: string }): string[][] {
    return readFileSync(state.log, 'utf8')
      .split('---\n')
      .filter((block) => block.length > 0)
      .map((block) => block.replace(/\n$/u, '').split('\n'));
  }

  it('derives the id and name from the folder and passes them as separate arguments', () => {
    const state = launcherFixture('workspace-add');
    const folder = join(state.home, 'Projects', 'My Store Front');
    const accented = join(state.home, 'Projects', 'Señor Ünïcode 2026.09');

    expect(run(state, ['workspace', 'add', folder]).status).toBe(0);
    expect(run(state, ['workspace', 'add', accented, 'Custom  Name']).status).toBe(0);
    expect(run(state, ['workspace', 'add', `${folder}/`]).status).toBe(0);
    // An empty name means "the folder name", exactly like an absent one.
    expect(run(state, ['workspace', 'add', folder, '']).status).toBe(0);

    expect(loggedInvocations(state)).toEqual([
      ['workspace:add', 'my-store-front', 'My Store Front', folder],
      ['workspace:add', 'custom-name', 'Custom  Name', accented],
      ['workspace:add', 'my-store-front', 'My Store Front', `${folder}/`],
      ['workspace:add', 'my-store-front', 'My Store Front', folder],
    ]);
  });

  it('caps the derived id at eighty characters without a trailing hyphen', () => {
    const state = launcherFixture('workspace-id-cap');
    const name = `${'a'.repeat(79)} b`;
    expect(run(state, ['workspace', 'add', join(state.home, name)]).status).toBe(0);
    expect(loggedInvocations(state)[0]?.[1]).toBe('a'.repeat(79));
  });

  it('refuses every argument shape outside the closed verb', () => {
    const state = launcherFixture('workspace-rejections');
    const folder = join(state.home, 'Projects', 'Store');
    const rejected: Array<[string, string[]]> = [
      ['unknown action', ['workspace', 'list']],
      ['missing directory', ['workspace', 'add']],
      ['too many arguments', ['workspace', 'add', folder, 'Name', 'extra']],
      ['relative directory', ['workspace', 'add', 'relative/folder']],
      ['filesystem root', ['workspace', 'add', '/']],
      ['control character in directory', ['workspace', 'add', `${folder}\nrm -rf /`]],
      ['control character in name', ['workspace', 'add', folder, 'Bad\tName']],
      ['name over 120 characters', ['workspace', 'add', folder, 'n'.repeat(121)]],
      ['directory over 4096 characters', ['workspace', 'add', `/${'d'.repeat(4096)}`]],
      ['no letter or digit in the name', ['workspace', 'add', join(state.home, '···')]],
    ];
    for (const [label, arguments_] of rejected) {
      const result = run(state, arguments_);
      expect(result.status, label).toBe(69);
      expect(result.stderr, label).toMatch(/^pimpampum-control-route: /u);
    }
    expect(readFileSync(state.log, 'utf8')).toBe('');
  });
});
