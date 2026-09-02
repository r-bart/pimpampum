/**
 * Source contract: negative checks over shipped sources that no behaviour test can observe from the
 * outside — a credential that never appears in a helper, a shell that is never invoked from QML, a
 * write verb absent from a read-only surface. Every assertion here is a "must not contain"; the
 * layout, copy and symbol greps that used to sit beside them were retired on 2026-09-02
 * (thoughts/reviews/2026-09-01_deep-review.md, H-13). The DoD manifests list this file as
 * "source contract", never as acceptance coverage.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const pluginRoot = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
const macSourceRoot = join(repositoryRoot, 'platforms/macos/Sources/PimpampumMenuBar');

const plugin = (name: string): string => readFileSync(join(pluginRoot, name), 'utf8');
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

  it.each([
    [
      'OverviewService.qml',
      /else if \(isObject\(envelope\.data\)\) \{[\s\S]{0,200}?data = envelope\.data/u,
    ],
    ['StatusPopout.qml', /isObject\(envelope\.data\)\s*\?\s*envelope\.data\s*:\s*envelope/u],
    ['UpdateService.qml', /isObject\(envelope\.data\)\s*\?\s*envelope\.data\s*:\s*envelope/u],
  ])('%s reads both the bare payload and the {data} envelope', (name, unwrap) => {
    // An installed plugin must survive a CLI upgrade in either direction. The validator pins the
    // same unwrap for UpdateService; this keeps the other two readers honest.
    expect(plugin(name)).toMatch(unwrap);
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
    const entrypoints = `${source('src/cliMain.ts')}\n${source('src/mcpStdio.ts')}`;
    expect(entrypoints).not.toMatch(/\bsudo\b|setuid|telemetry|analytics/iu);
    expect(entrypoints).not.toMatch(/SELECT\s+\*\s+FROM|better-sqlite3/iu);
  });
});
