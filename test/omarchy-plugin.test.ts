import { execFileSync, spawnSync } from 'node:child_process';
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
    const candidate = join(temporaryDirectory('fixture-drift'), 'candidate');
    cpSync(pluginSource, candidate, { recursive: true });
    writeFileSync(join(candidate, 'fixtures/mixed.json'), '{}\n');

    const result = spawnSync(process.execPath, [validator, candidate], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from frozen shared fixture');
  });

  it('keeps completed status green and credential rejection actionable', () => {
    const widget = readFileSync(join(pluginSource, 'BarWidget.qml'), 'utf8');
    const service = readFileSync(join(pluginSource, 'OverviewService.qml'), 'utf8');

    expect(widget).toContain('completedGreen');
    expect(widget).toContain('effectiveStatus === "complete"');
    expect(widget).toContain('root.themeForeground');
    expect(service).toContain('fail("credentials"');
    expect(service).toContain('Run pimpampum install');
    expect(service).not.toMatch(/errorMessage\s*=\s*processError/u);
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
