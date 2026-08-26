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

  it('uses one theme-tinted product mark, external status badge, and bounded count', () => {
    const widget = readFileSync(join(pluginSource, 'BarWidget.qml'), 'utf8');
    const mark = readFileSync(join(pluginSource, 'PimpampumMark.qml'), 'utf8');
    const service = readFileSync(join(pluginSource, 'OverviewService.qml'), 'utf8');

    expect(widget).toContain('PimpampumMark {');
    expect(widget).not.toContain('statusIcon');
    expect(widget).toContain('completedGreen');
    expect(widget).toContain('root.themeForeground');
    expect(widget).toContain('Accessible.name: indicator.accessibleLabel');
    expect(mark.match(/assets\/pimpampum-compact\.svg/gu)).toHaveLength(1);
    expect(mark).toContain('import QtQuick.Effects');
    expect(mark).toContain('MultiEffect {');
    expect(mark).toContain('colorizationColor: root.foreground');
    expect(mark).toMatch(/id:\s*markSource[\s\S]*?visible:\s*false/u);
    expect(mark).not.toContain('#000000');
    expect(mark).toContain('id: badge');
    expect(mark).toContain('Math.max(0, activeClaims)');
    expect(mark).toContain('safeActiveClaims >= 100 ? "99+" : String(safeActiveClaims)');
    expect(mark).toContain('visible: root.safeActiveClaims > 0');
    expect(widget).toContain('activeBlue: "#3b82f6"');
    expect(widget).toContain('availableAmber: "#f59e0b"');
    expect(mark).toContain('status === "active" ? activeColor');
    expect(mark).toContain('status === "available" ? availableColor');
    expect(mark).toContain('"complete": "square"');
    expect(mark).toContain('columns: root.vertical ? 1 : 2');
    expect(mark).toContain('rows: root.vertical ? 2 : 1');
    expect(widget).toContain('Accessible.onPressAction: root.togglePanel()');
    expect(`${widget}\n${mark}`).not.toMatch(/["'](?:×|!|✓|wifi\.slash)["']/u);
    expect(service).toContain('fail("credentials"');
    expect(service).toContain('Run pimpampum install');
    expect(service).not.toMatch(/errorMessage\s*=\s*processError/u);
  });

  it('keeps the popout bounded, ordered, readable, and keyboard accessible', () => {
    const popout = readFileSync(join(pluginSource, 'StatusPopout.qml'), 'utf8');
    const actionArea = readFileSync(join(pluginSource, 'PimpampumActionArea.qml'), 'utf8');

    expect(popout).toContain('contentWidth: fittedContentWidth(Style.space(380))');
    expect(popout).toContain(
      'contentHeight: fittedContentHeight(Math.min(content.implicitHeight, Style.space(520)))',
    );
    expect(popout).toContain('boundsBehavior: Flickable.StopAtBounds');
    expect(popout).toContain('clip: true');

    const ordered = [
      'text: "Pimpampum"',
      'visible: root.service.connectionState !== "online"',
      'No workspaces. Run: pimpampum workspace:add',
      'text: "Active work ("',
      'text: "Projects ("',
      '+ "Completed ("',
      '+ "Backup"',
    ].map((fragment) => popout.indexOf(fragment));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));

    expect(popout).toContain('elide: Text.ElideRight');
    expect(popout).toContain('elide: Text.ElideMiddle');
    expect(popout).toContain('modelData.workspace.name + " / " + modelData.slug');
    for (const control of [
      'projectAction',
      'completedAction',
      'completedRowAction',
      'backupAction',
      'actionArea',
    ]) {
      expect(popout).toContain(`id: ${control}`);
    }
    expect(popout.match(/PimpampumActionArea\s*\{/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(actionArea).toContain('hoverEnabled: true');
    expect(actionArea).toContain('activeFocusOnTab: focusOnTab');
    expect(actionArea).toContain('cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor');
    expect(actionArea).toContain('Keys.onPressed: function(event)');
    expect(actionArea).toContain('Qt.Key_Return || event.key === Qt.Key_Enter');
    expect(actionArea).toContain('event.key === Qt.Key_Space');
    expect(actionArea).toContain('Accessible.onPressAction: root.triggered()');
    expect(actionArea).toContain('onPressed: forceActiveFocus()');
    expect(actionArea).toContain('if (root.triggerOnClick) root.triggered()');
    expect(popout).toContain('triggerOnClick: false');
    expect(popout).toContain('onClicked: openWorkspace(modelData.workspace.rootPath)');
    expect(popout).toContain('Accessible.name:');
    expect(popout).toContain('property bool completedExpanded: false');
    expect(popout).toContain('property bool backupExpanded: false');
    expect(popout).toContain('enabled: modelData.enabled && !root.backupService.busy');
    expect(popout).toContain('var arguments = ["xdg-open", path]');
    expect(popout).not.toMatch(/sh\s+-c|bash\s+-c|xdg-open.*\+/u);
  });

  it('keeps backup configuration bounded and passes paths as process arguments', () => {
    const service = readFileSync(join(pluginSource, 'BackupService.qml'), 'utf8');
    const popout = readFileSync(join(pluginSource, 'StatusPopout.qml'), 'utf8');
    const helper = readFileSync(join(pluginSource, 'pimpampum-backup'), 'utf8');

    expect(service).toContain('command: [root.helperPath, "status"]');
    expect(service).toContain('arguments.push(path)');
    expect(service).toContain('var arguments = ["xdg-open", directory]');
    expect(service).toContain('JSON.parse(processError)');
    expect(service).toContain('processError.length > 4096');
    expect(service).toContain('message.length > 500');
    expect(service).not.toMatch(/sh\s+-c|bash\s+-c|shellQuote|\+\s*(?:directory|path)/u);
    expect(popout).toContain('FolderDialog');
    expect(popout).toContain('absolute path');
    expect(helper).toContain('backup "$@"');
    expect(helper).not.toMatch(/eval\b|bearer|token/iu);
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
