import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const pluginRoot = join(process.cwd(), 'integrations/omarchy/pimpampum-status');
const helper = join(pluginRoot, 'pimpampum-connections');
const common = join(pluginRoot, 'pimpampum-common.sh');
const service = join(pluginRoot, 'AgentConnectionService.qml');
const vocabulary = join(pluginRoot, 'StateVocabulary.qml');
const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pimpampum-connections-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

/**
 * The `id -> label` table of `StateVocabulary.qml`, which `scripts/generate-state-vocabulary.mjs`
 * emits for the plugin and the macOS app from one source. Its body is a JSON object literal.
 */
function generatedAgentStateLabels(): Record<string, string> {
  const block = /agentStateLabels:\s*\(\{([\s\S]*?)\}\)/u.exec(readFileSync(vocabulary, 'utf8'));
  expect(block, 'StateVocabulary.qml must declare agentStateLabels').not.toBeNull();
  return JSON.parse(`{${block![1]}}`) as Record<string, string>;
}

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

// The fake launcher mimics what the CLI does on Omarchy: on a connect it rewrites the agent's host
// configuration in HOME (Claude Code keeps per-project history there, far above 64 KiB), and on a
// failure it writes the pretty-printed typed envelope to stderr with an empty stdout.
function fixture(label: string, homeName = 'home') {
  const root = temporaryDirectory(label);
  const home = join(root, homeName);
  const data = join(home, '.pimpampum');
  const launcher = join(home, '.local/share/pimpampum/bin/pimpampum-control');
  const receipt = join(data, 'runtime-install-receipt.json');
  const timeout = join(root, 'timeout');
  const response = join(root, 'response.json');
  const failure = join(root, 'failure.json');
  const log = join(root, 'arguments.log');
  const hostConfiguration = join(home, 'host-configuration.json');
  mkdirSync(data, { recursive: true });
  write(
    launcher,
    `#!/bin/sh
printf '%s\n' "$*" >> "$PIMPAMPUM_FAKE_LOG"
if [ -n "\${PIMPAMPUM_FAKE_HOST_CONFIGURATION_BYTES:-}" ]; then
  /usr/bin/head -c "$PIMPAMPUM_FAKE_HOST_CONFIGURATION_BYTES" /dev/zero > "$HOME/host-configuration.json" || exit 99
fi
if [ "\${PIMPAMPUM_FAKE_EXIT:-0}" -ne 0 ]; then
  [ -z "\${PIMPAMPUM_FAKE_FAILURE:-}" ] || /bin/cat "$PIMPAMPUM_FAKE_FAILURE" >&2
  exit "$PIMPAMPUM_FAKE_EXIT"
fi
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
  return {
    root,
    home,
    data,
    launcher,
    receipt,
    timeout,
    response,
    failure,
    log,
    hostConfiguration,
  };
}

function cliFailure(error: Record<string, unknown>): string {
  return `${JSON.stringify({ error }, null, 2)}\n`;
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

function failureEnvelope(stderr: string): Record<string, unknown> {
  return JSON.parse(stderr) as Record<string, unknown>;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Five of these seven cases spawn the real helper against a fixture HOME, and the dispatch case
// spawns it once per reviewed argument array. Measured on an idle machine the file runs 4.7 s and
// its heaviest case 1.7 s, but that case passed 5.2 s once vitest ran the suite's files in
// parallel. The budget covers the contention, not a grown workload: the file is unchanged in this
// wave apart from the QML assertion, which dropped from a string sweep to 3 ms.
describe('bounded Omarchy connection helper', { timeout: 20_000 }, () => {
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

  it('lets the CLI rewrite a 200 KiB host configuration during connect', () => {
    // H-03: `ulimit -f 128` gave the CLI a 64 KiB file-size limit under /bin/sh, so rewriting
    // ~/.claude.json (234 KiB on the reviewed machine) died with EFBIG and the popout said
    // "Needs repair" for a command that worked from a terminal.
    const state = fixture('large-host-configuration');
    const result = run(state, ['connect', 'claude-code'], {
      PIMPAMPUM_FAKE_HOST_CONFIGURATION_BYTES: String(200 * 1024),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, action: 'connect' });
    expect(statSync(state.hostConfiguration).size).toBe(200 * 1024);
  });

  it('accepts a HOME with spaces and non-ASCII letters and rejects quotes and control characters', () => {
    const accepted = fixture('home-unicode', 'Home With Spaces ü ñ');
    const result = run(accepted, ['list']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, action: 'list' });

    for (const [label, homeName] of [
      ['single-quote', "Home 'quoted'"],
      ['double-quote', 'Home "quoted"'],
      ['backslash', 'Home\\slash'],
      ['newline', 'Home\nbroken'],
    ] as const) {
      const rejected = fixture(`home-${label}`, homeName);
      const outcome = run(rejected, ['list']);
      expect(outcome.status, label).toBe(73);
      expect(failureEnvelope(outcome.stderr)).toEqual({
        schemaVersion: 1,
        ok: false,
        action: 'list',
        code: 'invalid_home',
      });
      expect(readFileSync(rejected.log, 'utf8')).toBe('');
    }
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

    // The shared prologue also refuses a receipt other users could read.
    const exposed = fixture('exposed-receipt');
    chmodSync(exposed.receipt, 0o644);
    const exposedResult = run(exposed, ['list']);
    expect(exposedResult.status).toBe(69);
    expect(failureEnvelope(exposedResult.stderr)).toMatchObject({ code: 'receipt_mismatch' });
    expect(readFileSync(exposed.log, 'utf8')).toBe('');
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
    expect(failureEnvelope(failed.stderr)).toEqual({
      schemaVersion: 1,
      ok: false,
      action: 'repair',
      code: 'command_failed',
      cliCode: null,
      message: null,
    });
  });

  it('forwards the typed CLI error code and one bounded message line', () => {
    // M-O4: `unavailable`, a missing agent binary and a real connector failure all collapsed
    // into `command_failed`. The helper now forwards the envelope code and its message.
    const state = fixture('forward');
    const cases: Array<{
      error: Record<string, unknown>;
      code: string;
      cliCode: string | null;
      message: string | null;
    }> = [
      {
        error: {
          code: 'unavailable',
          message: 'Pimpampum daemon is not reachable at http://127.0.0.1:7337',
          retryable: true,
          suggestion: 'Run pimpampum status.',
        },
        code: 'command_failed',
        cliCode: 'unavailable',
        message: 'Pimpampum daemon is not reachable at http://127.0.0.1:7337',
      },
      {
        error: { code: 'conflict', message: 'The existing connector entry requires a decision' },
        code: 'connector_conflict',
        cliCode: 'conflict',
        message: 'The existing connector entry requires a decision',
      },
      {
        // Quotes, backslashes and control characters cannot enter the helper's one-line JSON,
        // so a control character arrives as its JSON escape without the backslash; non-ASCII is
        // dropped rather than risk a split UTF-8 sequence at the 200-byte cut.
        error: {
          code: 'internal_error',
          message: `Claude Code is not installed: "claude" \\ missing\tat /home/ü/.local\u0007bin ${'z'.repeat(300)}`,
        },
        code: 'command_failed',
        cliCode: 'internal_error',
        message:
          `Claude Code is not installed: 'claude'  missingtat /home//.localu0007bin ${'z'.repeat(300)}`.slice(
            0,
            200,
          ),
      },
      {
        // A code outside ^[a-z_]{1,40}$ is dropped instead of forwarded.
        error: { code: 'Bad-Code', message: 'x'.repeat(10) },
        code: 'command_failed',
        cliCode: null,
        message: 'xxxxxxxxxx',
      },
    ];
    for (const testCase of cases) {
      writeFileSync(state.failure, cliFailure(testCase.error));
      const result = run(state, ['connect', 'codex'], {
        PIMPAMPUM_FAKE_EXIT: '1',
        PIMPAMPUM_FAKE_FAILURE: state.failure,
      });
      expect(result.status, JSON.stringify(testCase.error)).toBe(70);
      expect(result.stdout).toBe('');
      expect(failureEnvelope(result.stderr)).toEqual({
        schemaVersion: 1,
        ok: false,
        action: 'connect',
        code: testCase.code,
        cliCode: testCase.cliCode,
        message: testCase.message,
      });
    }

    // Node warnings ahead of the envelope do not confuse the extraction.
    writeFileSync(
      state.failure,
      `(node:1) ExperimentalWarning: something\n${cliFailure({ code: 'unauthorized', message: 'Bearer token rejected' })}`,
    );
    const noisy = run(state, ['test', 'codex'], {
      PIMPAMPUM_FAKE_EXIT: '1',
      PIMPAMPUM_FAKE_FAILURE: state.failure,
    });
    expect(failureEnvelope(noisy.stderr)).toMatchObject({
      cliCode: 'unauthorized',
      message: 'Bearer token rejected',
    });
  });

  it('keeps QML typed, serialized and outside host configuration and daemon ownership', () => {
    const qml = readFileSync(service, 'utf8');
    const shell = readFileSync(helper, 'utf8');
    const shared = readFileSync(common, 'utf8');

    expect(statSync(helper).mode & 0o111).not.toBe(0);
    expect(shell).toContain('. "$plugin_root/pimpampum-common.sh"');
    expect(shell).toContain('validate_home 73');
    expect(shell).toContain('verify_control_launcher 69');
    for (const action of ['list', 'plan', 'connect', 'test', 'repair', 'disconnect', 'resume']) {
      expect(shell).toContain(action);
    }
    // The state names are generated, so the assertion is a property, not a copy of the list: the
    // service must render exactly the shared agent vocabulary and invent nothing. A state reaches a
    // connector either as a `labels.<id>` reference or as a literal handed to `setState`; the union
    // of both routes has to equal the generated table.
    const labels = generatedAgentStateLabels();
    const idByLabel = new Map(Object.entries(labels).map(([id, label]) => [label, id]));
    expect(qml).toContain('StateVocabulary { id: vocabulary }');
    expect(qml).toContain('readonly property var sharedStates: vocabulary.agentLabels');
    expect(qml).toContain('readonly property var labels: vocabulary.agentStateLabels');
    const rendered = new Set<string>();
    for (const match of qml.matchAll(/\blabels\.([A-Za-z][A-Za-z0-9]*)/gu)) rendered.add(match[1]!);
    for (const match of qml.matchAll(/\bsetState\([^,]+,\s*"([^"]*)"\)/gu)) {
      const literal = match[1]!;
      const id = idByLabel.get(literal);
      expect(id, `setState was handed the unknown state "${literal}"`).toBeTypeOf('string');
      rendered.add(id!);
    }
    expect([...rendered].sort()).toEqual(Object.keys(labels).sort());
    expect(qml).toContain('if (busy) return');
    expect(qml).toContain('connectionProcess.command = arguments');
    expect(qml).toContain('envelope.schemaVersion !== 1');
    expect(qml).toContain('case "ownedCurrent"');
    expect(qml).toContain('Array.isArray(data.connectors)');
    // The forwarded code is rendered like the other services' actionable errors: bounded, filtered
    // and mapped to a distinct sentence for a stopped daemon and a missing agent CLI.
    expect(qml).toContain('function actionableProcessError(envelope, fallback)');
    expect(qml).toContain('/^[a-z_]{1,40}$/.test(value)');
    expect(qml).toContain('value.length > 200');
    expect(qml).toContain('if (cliCode === "unavailable")');
    // The failure path picks its state from the same generated table, so an `unavailable` daemon
    // still lands on a shared state instead of a sentence written here.
    expect(qml).toContain('=== "unavailable") failedState = labels.unavailable');
    for (const [, source] of qml.matchAll(/failedState\s*=\s*(\S+)/gu)) {
      expect(source).toMatch(/^labels\./u);
    }
    expect(qml).toContain('/not installed/i.test(message)');
    expect(qml).toContain('else if (envelope.code === "command_failed")');
    expect(`${shell}\n${shared}\n${qml}`).not.toMatch(
      /eval\s|sh\s+-c|bash\s+-c|bearer|token|mcpServers|\.claude\.json|config\.toml|systemctl/iu,
    );
    expect(shell).toContain('/bin/kill -0 "$owner_pid"');
  });
});
