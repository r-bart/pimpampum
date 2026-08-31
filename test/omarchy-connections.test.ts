import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const pluginRoot = join(process.cwd(), 'integrations/omarchy/pimpampum-status');
const helper = join(pluginRoot, 'pimpampum-connections');
const service = join(pluginRoot, 'AgentConnectionService.qml');
const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-connections-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function fixture(label: string) {
  const root = temporaryDirectory(label);
  const home = join(root, 'home');
  const data = join(home, '.pimpampum');
  const launcher = join(home, '.local/share/pimpampum/bin/pimpampum-control');
  const receipt = join(data, 'runtime-install-receipt.json');
  const timeout = join(root, 'timeout');
  const response = join(root, 'response.json');
  const log = join(root, 'arguments.log');
  mkdirSync(data, { recursive: true });
  write(
    launcher,
    `#!/bin/sh
printf '%s\n' "$*" >> "$PIMPAMPUM_FAKE_LOG"
[ "\${PIMPAMPUM_FAKE_EXIT:-0}" -eq 0 ] || exit "$PIMPAMPUM_FAKE_EXIT"
/bin/cat "$PIMPAMPUM_FAKE_RESPONSE"
`,
    0o755,
  );
  const launcherSha256 = createHash('sha256').update(readFileSync(launcher)).digest('hex');
  write(
    receipt,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        controlLauncherPath: launcher,
        controlLauncherSha256: launcherSha256,
      },
      null,
      2,
    )}\n`,
    0o600,
  );
  write(timeout, '#!/bin/sh\nshift 3\nexec "$@"\n', 0o755);
  write(log, '');
  write(
    response,
    `${JSON.stringify({
      data: {
        connections: [
          { id: 'codex', state: 'ownedCurrent', available: true },
          { id: 'claude-code', state: 'notConnected', available: false },
        ],
      },
    })}\n`,
  );
  return { root, home, data, launcher, receipt, timeout, response, log };
}

function run(
  state: ReturnType<typeof fixture>,
  arguments_: string[],
  overrides: NodeJS.ProcessEnv = {},
) {
  return spawnSync('/bin/sh', [helper, ...arguments_], {
    encoding: 'utf8',
    env: {
      HOME: state.home,
      PIMPAMPUM_CONNECTIONS_TIMEOUT: state.timeout,
      PIMPAMPUM_FAKE_LOG: state.log,
      PIMPAMPUM_FAKE_RESPONSE: state.response,
      ...overrides,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('bounded Omarchy connection helper', () => {
  it('dispatches only the reviewed argument arrays through the receipt-owned launcher', () => {
    const state = fixture('dispatch');
    const operations = [
      ['list'],
      ['plan', 'codex'],
      ['connect', 'codex'],
      ['test', 'claude-code'],
      ['repair', 'claude-code'],
      ['repair', 'codex', 'replace'],
      ['disconnect', 'codex'],
      ['resume'],
    ];
    for (const operation of operations) {
      const result = run(state, operation);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        ok: true,
        action: operation[0],
      });
    }
    expect(readFileSync(state.log, 'utf8').trim().split('\n')).toEqual([
      'connections',
      'setup plan --connector codex',
      'connect codex --yes',
      'connections',
      'repair claude-code --yes',
      'repair codex --yes --replace',
      'disconnect codex --yes',
      'setup resume',
    ]);
  });

  it('rejects unknown actions, ids, extra arguments and receipt mismatch before dispatch', () => {
    const state = fixture('reject');
    for (const arguments_ of [
      ['shell', 'codex'],
      ['connect', 'other'],
      ['list', 'codex'],
      ['repair'],
      ['disconnect', 'codex', '--replace'],
    ]) {
      const result = run(state, arguments_);
      expect(result.status).toBe(64);
      expect(JSON.parse(result.stderr)).toMatchObject({ schemaVersion: 1, ok: false });
    }
    writeFileSync(state.receipt, '{}\n');
    const mismatch = run(state, ['list']);
    expect(mismatch.status).toBe(69);
    expect(mismatch.stderr).toContain('receipt_mismatch');
    expect(readFileSync(state.log, 'utf8')).toBe('');
  });

  it('serializes operations and bounds process output and failures', () => {
    const state = fixture('bounds');
    mkdirSync(join(state.data, '.connections-helper.lock'));
    const busy = run(state, ['connect', 'codex']);
    expect(busy.status).toBe(75);
    expect(busy.stderr).toContain('operation_in_progress');
    rmSync(join(state.data, '.connections-helper.lock'), { recursive: true });

    mkdirSync(join(state.data, '.connections-helper.lock'));
    writeFileSync(join(state.data, '.connections-helper.lock/owner'), '999999:stale-owner\n');
    const recovered = run(state, ['list']);
    expect(recovered.status, recovered.stderr).toBe(0);

    writeFileSync(state.response, `{"data":"${'x'.repeat(70_000)}"}\n`);
    const oversized = run(state, ['list']);
    expect(oversized.status).not.toBe(0);
    expect(oversized.stdout.length + oversized.stderr.length).toBeLessThan(4096);

    writeFileSync(state.response, '{}\n');
    const failed = run(state, ['repair', 'codex'], { PIMPAMPUM_FAKE_EXIT: '42' });
    expect(failed.status).toBe(70);
    expect(failed.stderr).toContain('command_failed');
  });

  it('keeps QML typed, serialized and outside host configuration and daemon ownership', () => {
    const qml = readFileSync(service, 'utf8');
    const shell = readFileSync(helper, 'utf8');

    expect(statSync(helper).mode & 0o111).not.toBe(0);
    for (const action of ['list', 'plan', 'connect', 'test', 'repair', 'disconnect', 'resume']) {
      expect(shell).toContain(action);
    }
    for (const state of [
      'Not installed',
      'Not connected',
      'Connecting',
      'Connected',
      'New session required',
      'Needs repair',
      'Configuration conflict',
      'Unsupported version',
    ]) {
      expect(qml).toContain(state);
    }
    expect(qml).toContain('if (busy) return');
    expect(qml).toContain('connectionProcess.command = arguments');
    expect(qml).toContain('envelope.schemaVersion !== 1');
    expect(qml).toContain('case "ownedCurrent"');
    expect(qml).toContain('Array.isArray(data.connectors)');
    expect(`${shell}\n${qml}`).not.toMatch(
      /eval\s|sh\s+-c|bash\s+-c|bearer|token|mcpServers|\.claude\.json|config\.toml|systemctl/iu,
    );
    expect(shell).toContain('/bin/kill -0 "$owner_pid"');
  });
});
