/**
 * Source contract: negative checks over shipped sources that no behaviour test can observe from the
 * outside — a credential that never appears in a helper, a shell that is never invoked from QML, a
 * write verb absent from a read-only surface. The layout and copy greps that used to sit beside
 * them were retired on 2026-09-02 (thoughts/reviews/2026-09-01_deep-review.md, H-13). The DoD
 * manifests list this file as "source contract", never as acceptance coverage.
 *
 * Most assertions here are "must not contain". A few are wiring contracts: a property that binds a
 * shipped source to a generated table or to a set of files, which no behaviour test can observe
 * from outside. They live here because this is the one file that reads repository sources; a
 * source-text assertion anywhere else is a defect in itself.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const pluginRoot = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
const macSourceRoot = join(repositoryRoot, 'platforms/macos/Sources/PimpampumMenuBar');

const helper = join(pluginRoot, 'pimpampum-connections');
const common = join(pluginRoot, 'pimpampum-common.sh');
const service = join(pluginRoot, 'AgentConnectionService.qml');
const vocabulary = join(pluginRoot, 'StateVocabulary.qml');

const plugin = (name: string): string => readFileSync(join(pluginRoot, name), 'utf8');

/**
 * The `id -> label` table of `StateVocabulary.qml`, which `scripts/generate-state-vocabulary.mjs`
 * emits for the plugin and the macOS app from one source. Its body is a JSON object literal.
 */
function generatedAgentStateLabels(): Record<string, string> {
  const block = /agentStateLabels:\s*\(\{([\s\S]*?)\}\)/u.exec(readFileSync(vocabulary, 'utf8'));
  expect(block, 'StateVocabulary.qml must declare agentStateLabels').not.toBeNull();
  return JSON.parse(`{${block![1]}}`) as Record<string, string>;
}
const macSource = (name: string): string => readFileSync(join(macSourceRoot, name), 'utf8');
const source = (path: string): string => readFileSync(join(repositoryRoot, path), 'utf8');

const SHELL_INTERPOLATION = /\bsh\s+-c|\bbash\s+-c|shellQuote/u;
const CREDENTIALS = /bearer|token/iu;

describe('Omarchy plugin sources', () => {
  it.each([
    'AgentConnectionService.qml',
    'BackupService.qml',
    'OverviewService.qml',
    'ServiceControl.qml',
    'StatusPopout.qml',
    'SyncService.qml',
    'UpdateService.qml',
  ])('%s launches helpers as argument arrays, never through a shell', (name) => {
    expect(plugin(name)).not.toMatch(SHELL_INTERPOLATION);
  });

  it.each(['BackupService.qml', 'SyncService.qml'])(
    '%s passes the chosen directory as a separate process argument',
    (name) => {
      expect(plugin(name)).not.toMatch(/\+\s*(?:directory|path)\b/u);
    },
  );

  it('the popout opens folders with xdg-open and one path argument', () => {
    expect(plugin('StatusPopout.qml')).not.toMatch(/xdg-open.*\+/u);
  });

  it.each([
    'pimpampum-backup',
    'pimpampum-bootstrap',
    'pimpampum-common.sh',
    'pimpampum-connections',
    'pimpampum-control-route',
    'pimpampum-folder-picker',
    'pimpampum-overview',
    'pimpampum-plugin-lifecycle',
    'pimpampum-service',
    'pimpampum-sync',
    'pimpampum-update',
    'install.sh',
    'uninstall.sh',
  ])('%s never evaluates text as code and never carries a credential', (name) => {
    const helper = plugin(name);
    expect(helper).not.toMatch(/\beval\b/u);
    expect(helper).not.toMatch(SHELL_INTERPOLATION);
    expect(helper).not.toMatch(CREDENTIALS);
  });

  it('the connections helper does not cap the CLI file size (H-03)', () => {
    // `ulimit -f 128` under /bin/sh gave the CLI a 64 KiB limit; rewriting a 234 KiB ~/.claude.json
    // died with EFBIG and the popout said "Needs repair" for a command that worked from a terminal.
    expect(plugin('pimpampum-connections')).not.toMatch(/\bulimit\b/u);
  });

  it('the bootstrap helper is rootless, pins a version and never reaches for npm', () => {
    // Spec: SEC-1, SEC-7 (source contract)
    expect(plugin('pimpampum-bootstrap')).not.toMatch(/\bsudo\b|curl.+latest|\bnpm\s/iu);
  });

  it('the bounded control route carries no project-domain verb beyond workspace registration', () => {
    expect(plugin('pimpampum-control-route')).not.toMatch(
      /(?:health|uninstall|work:|project:|task:)/u,
    );
  });

  it('the status popout never names a write tool', () => {
    // Spec: FR-5 (source contract)
    expect(plugin('StatusPopout.qml')).not.toMatch(/work_complete|project_update|task_update/u);
  });

  it('the agents card and service own neither host configuration nor the daemon lifecycle', () => {
    // Spec: FR-2.10, EC-14, PERF-6, SEC-4 (source contract)
    const service = plugin('AgentConnectionService.qml');
    const card = plugin('AgentsSettingsCard.qml');
    expect(service).not.toMatch(/systemctl.+(?:stop|start)|\bkill\s|terminate/iu);
    expect(`${service}\n${card}`).not.toMatch(
      /systemctl.+(?:stop|start)|mcpServers|\.claude\.json|config\.toml|bearer|token/iu,
    );
  });

  it('the update service owns no repeating timer, so the popout is never a background updater', () => {
    expect(plugin('UpdateService.qml')).not.toMatch(/repeat:\s*true/u);
  });

  /**
   * Every reader of a CLI payload, with the unwrap idiom it actually uses. The names differ by
   * file (`envelope`, `parsed`, `value`), so this list is the contract, not a grep for one word.
   * `ServiceControl.qml` is deliberately absent: `pimpampum-service` emits its own
   * `{"running":…}` and that reader rejects any other shape, envelope included.
   */
  const cliPayloadReaders: ReadonlyArray<readonly [string, RegExp]> = [
    [
      'OverviewService.qml',
      /else if \(isObject\(envelope\.data\)\) \{[\s\S]{0,200}?data = envelope\.data/u,
    ],
    // The popout's reader moved into PopoutController.qml when StatusPopout.qml was split
    // (wave 4, Task 9.6); the property is the reader's, not the file's.
    ['PopoutController.qml', /isObject\(envelope\.data\)\s*\?\s*envelope\.data\s*:\s*envelope/u],
    ['UpdateService.qml', /isObject\(envelope\.data\)\s*\?\s*envelope\.data\s*:\s*envelope/u],
    ['AgentConnectionService.qml', /if \(isObject\(value\.data\)\) return value\.data/u],
    [
      'ManagedFolderService.qml',
      /parsed\.data && typeof parsed\.data === "object"\) parsed = parsed\.data/u,
    ],
  ];

  it.each(cliPayloadReaders)(
    '%s reads both the bare payload and the {data} envelope',
    (name, unwrap) => {
      // An installed plugin must survive a CLI upgrade in either direction. The validator pins the
      // same unwrap for UpdateService; this keeps the other readers honest.
      expect(plugin(name)).toMatch(unwrap);
    },
  );

  it('parses helper output in the listed readers only', () => {
    // A new reader that forgets the {data} tolerance would otherwise ship unnoticed, because each
    // idiom names its own variable. Both sides are pinned: every QML file that parses helper
    // output either unwraps a payload (and is listed above) or is the one reader whose helper
    // emits its own shape. A `data` alias for child items is not a payload read, so the discriminator
    // is `JSON.parse`, never the word alone.
    const parsers = readdirSync(pluginRoot)
      .filter((entry) => entry.endsWith('.qml'))
      .map((entry) => [entry, readFileSync(join(pluginRoot, entry), 'utf8')] as const)
      .filter(([, text]) => text.includes('JSON.parse'));
    const unwrapping = parsers
      .filter(([, text]) => /\.data\b/u.test(text))
      .map(([name]) => name)
      .sort();
    const bare = parsers
      .filter(([, text]) => !/\.data\b/u.test(text))
      .map(([name]) => name)
      .sort();
    expect(unwrapping).toEqual(cliPayloadReaders.map(([name]) => name).sort());
    // `pimpampum-service` emits `{"running":…}` itself and this reader rejects every other shape,
    // envelope included, so unwrapping there would be wrong.
    expect(bare).toEqual(['ServiceControl.qml']);
  });
});

describe('macOS menu-bar sources', () => {
  it('the popover never names a write tool or a mutating HTTP method', () => {
    // Spec: US-3/AC-4, FR-5 (source contract)
    expect(macSource('StatusPopover.swift')).not.toMatch(
      /work_complete|project_update|task_update|DELETE|PATCH|POST/u,
    );
  });

  it('the workspace opener never spawns a shell', () => {
    // Spec: US-4/AC-1, US-4/AC-4 (source contract)
    expect(macSource('WorkspaceOpener.swift')).not.toContain('/bin/sh');
  });
});

describe('CLI bootstrap and stdio bridge', () => {
  it('never escalate, never phone home and never open the database themselves', () => {
    // Spec: SEC-1, SEC-11, SEC-12 (source contract)
    // The CLI composition modules carry the code that used to live in cliMain.ts (wave 4, Task 9.2).
    const compositionRoot = join(repositoryRoot, 'src/cliComposition');
    const composition = readdirSync(compositionRoot)
      .filter((name) => name.endsWith('.ts'))
      .sort()
      .map((name) => source(`src/cliComposition/${name}`));
    const entrypoints = [source('src/cliMain.ts'), ...composition, source('src/mcpStdio.ts')].join(
      '\n',
    );
    expect(entrypoints).not.toMatch(/\bsudo\b|setuid|telemetry|analytics/iu);
    expect(entrypoints).not.toMatch(/SELECT\s+\*\s+FROM|better-sqlite3/iu);
  });
});

describe('Omarchy connection surface wiring', () => {
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
