/**
 * @generated-from thoughts/specs/2026-08-31_zero-friction-local-agent-setup.md
 * @immutable Do NOT modify these tests — implementation must make them pass as-is.
 *
 * These tests encode the spec's acceptance criteria as executable assertions.
 * If a test seems wrong, update the spec and regenerate — don't edit tests directly.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const macSource = join(repositoryRoot, 'platforms/macos/Sources/PimpampumMenuBar');
const pluginSource = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');

function requiredSource(path: string): string {
  expect(existsSync(path), `Expected generated contract artifact ${path}`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('Native zero-friction distribution surfaces', () => {
  it('FR-1.1: macOS build embeds one reviewed private runtime and verifies nested code', () => {
    // Spec: US-1/AC-1, FR-1.1, FR-1.2, SEC-5, SEC-6
    const build = requiredSource(join(repositoryRoot, 'scripts/build-macos-app.sh'));
    const checker = requiredSource(join(repositoryRoot, 'scripts/check-macos-artifact.mjs'));

    expect(build).toMatch(/build-runtime-bundle|runtime-manifest/iu);
    expect(build).toMatch(/Contents\/Resources|Resources/iu);
    expect(checker).toMatch(/bin\/node|better_sqlite3\.node/u);
    expect(checker).toMatch(/codesign|signature/iu);
    expect(`${build}\n${checker}`).not.toMatch(/npm\s+install\s+-g|curl.+latest/iu);
  });

  it('FR-8.1/FR-8.2: macOS updates use packaged releases while preserving a legacy npm path', () => {
    // Spec: FR-8.1, FR-8.2, EC-16
    const store = requiredSource(join(macSource, 'UpdateSettingsStore.swift'));
    const update = requiredSource(join(repositoryRoot, 'src/update.ts'));

    expect(update).toMatch(/packaged|release manifest/iu);
    expect(update).toMatch(/legacy|npm/iu);
    expect(update).toMatch(/sha256|signature/iu);
    expect(store).toMatch(/packaged|native/iu);
    expect(store).not.toMatch(/npm\s+install\s+-g/iu);
  });

  it('SEC-7: Omarchy pins an exact target asset and checksum instead of latest', () => {
    // Spec: FR-1.1, FR-1.4, SEC-6, SEC-7
    const manifestPath = join(pluginSource, 'runtime-manifest.json');
    const manifest = JSON.parse(requiredSource(manifestPath)) as {
      version: string;
      targets: Record<string, { url: string; sha256: string; maximumBytes: number }>;
    };

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u);
    expect(Object.keys(manifest.targets).sort()).toEqual(['linux-arm64', 'linux-x64']);
    for (const target of Object.values(manifest.targets)) {
      expect(target.url).not.toMatch(/\/latest\/|latest\.tar/iu);
      expect(target.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(target.maximumBytes).toBeGreaterThan(0);
    }
  });

  it('SEC-7/SEC-8: plugin bootstrap is bounded, rootless and rejects unsafe archives', () => {
    // Spec: FR-1.2, SEC-1, SEC-7, SEC-8, EC-8
    const bootstrapPath = join(pluginSource, 'pimpampum-bootstrap');
    const bootstrap = requiredSource(bootstrapPath);

    expect(statSync(bootstrapPath).mode & 0o111).not.toBe(0);
    expect(bootstrap).toMatch(/sha256sum|shasum/iu);
    expect(bootstrap).toMatch(/maximumBytes|content-length|max.*bytes/iu);
    expect(bootstrap).toMatch(/mktemp|staging/iu);
    expect(bootstrap).toMatch(/linux-(?:arm64|x64)|uname/iu);
    expect(bootstrap).not.toMatch(/sudo|eval\s|curl.+latest|npm\s/iu);
  });

  it('FR-9.1: Omarchy helper accepts only known actions and returns typed redacted JSON', () => {
    // Spec: FR-2.9, FR-9.1, SEC-4, SEC-8
    const helperPath = join(pluginSource, 'pimpampum-connections');
    const helper = requiredSource(helperPath);

    for (const action of ['list', 'plan', 'connect', 'test', 'repair', 'disconnect', 'resume']) {
      expect(helper).toContain(action);
    }
    expect(helper).toContain('codex');
    expect(helper).toContain('claude-code');
    expect(helper).toMatch(/schemaVersion|schema_version/u);
    expect(helper).not.toMatch(/eval\s|sh\s+-c|bearer|token/iu);
  });

  it('US-2/AC-2: Omarchy Agents card exposes shared states, partial failure and retry', () => {
    // Spec: US-2/AC-2, US-2/AC-4, FR-7.3, A11Y-4, A11Y-5
    const service = requiredSource(join(pluginSource, 'AgentConnectionService.qml'));
    const card = requiredSource(join(pluginSource, 'AgentsSettingsCard.qml'));
    const popout = requiredSource(join(pluginSource, 'StatusPopout.qml'));

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
      expect(`${service}\n${card}`).toContain(state);
    }
    expect(card).toContain('Try again');
    expect(card).toContain('Accessible.name');
    expect(card).toMatch(/activeFocusOnTab|Keys\.onPressed/u);
    expect(popout).toContain('AgentsSettingsCard');
    expect(popout).toMatch(/Flickable|ScrollView/u);
  });

  it('EC-14: Quickshell restart leaves the service and completed connectors out of QML ownership', () => {
    // Spec: FR-1.3, EC-14, PERF-6
    const service = requiredSource(join(pluginSource, 'AgentConnectionService.qml'));
    const helper = requiredSource(join(pluginSource, 'pimpampum-connections'));
    const unitRenderer = requiredSource(join(repositoryRoot, 'src/service/systemd.ts'));

    expect(service).not.toMatch(/systemctl.+stop|kill\s|terminate/iu);
    expect(service).not.toMatch(/mcpServers|\.claude\.json|config\.toml/u);
    expect(helper).toMatch(/install-receipt|receipt/iu);
    expect(unitRenderer).toContain('WantedBy=default.target');
    expect(unitRenderer).toContain('Restart=on-failure');
  });

  it('A11Y-1/A11Y-5: macOS and Omarchy share status language without relying on color', () => {
    // Spec: A11Y-1, A11Y-4, A11Y-5
    const models = requiredSource(join(macSource, 'SetupModels.swift'));
    const card = requiredSource(join(pluginSource, 'AgentsSettingsCard.qml'));
    const sharedStates = [
      'Not installed',
      'Not connected',
      'Connected',
      'New session required',
      'Needs repair',
      'Configuration conflict',
      'Unsupported version',
    ];

    for (const state of sharedStates) {
      expect(models).toContain(state);
      expect(card).toContain(state);
    }
    expect(models).toMatch(/label|accessibility/iu);
    expect(card).toContain('Accessible.name');
  });

  it.todo('SEC-7: proves a no-Node Omarchy bootstrap on every supported target architecture');
  // Spec: SEC-7, FR-1.2, Success metric: external Node/npm requirement

  it.todo('EC-14: proves completed connections survive a live Quickshell restart');
  // Spec: EC-14, PERF-6
});
