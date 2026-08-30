import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
    // The mark is drawn from the reviewed master's own path data, so the painted identity
    // cannot drift from the canonical SVG.
    const masterPath = /\sd="([^"]+)"/u.exec(
      readFileSync(join(repositoryRoot, 'branding/assets/pimpampum-compact-master.svg'), 'utf8'),
    )?.[1];
    expect(masterPath).toBeTruthy();
    expect(mark).toContain(`path: "${masterPath}"`);
    // The bar resolves its own foreground against whatever is behind a transparent bar, so
    // the mark fills from it. It must not go back to a layer-tinted image: that texture kept
    // its first color and left the mark dark after the wallpaper changed.
    expect(mark).toContain('fillColor: root.foreground');
    expect(mark).toContain('fillRule: ShapePath.OddEvenFill');
    expect(mark).not.toContain('contrastBackground');
    expect(mark).not.toContain('MultiEffect {');
    expect(mark).toContain('id: badge');
    expect(mark).toContain('Math.max(0, activeClaims)');
    expect(mark).toContain('safeActiveClaims >= 100 ? "99+" : String(safeActiveClaims)');
    expect(mark).toContain('visible: root.showActiveCount && root.safeActiveClaims > 0');
    expect(mark).toContain('visible: !root.showActiveCount || root.safeActiveClaims === 0');
    expect(widget).toContain('activeBlue: "#3b82f6"');
    expect(widget).toContain('availableAmber: "#f59e0b"');
    expect(mark).toContain('status === "active" ? activeColor');
    expect(mark).toContain('status === "available" ? availableColor');
    expect(mark).toContain('"complete": "square"');
    expect(mark).toContain('"cancelled": "ring"');
    expect(widget).toContain('"cancelled": "Finished with cancellations"');
    expect(widget).toContain(
      'displayStatus: service.effectiveStatus === "complete" && hasCancellations',
    );
    expect(mark).toContain('columns: root.vertical ? 1 : 2');
    expect(mark).toContain('rows: root.vertical ? 2 : 1');
    expect(widget).toContain('Accessible.onPressAction: root.togglePanel()');
    expect(`${widget}\n${mark}`).not.toMatch(/["'](?:×|!|✓|wifi\.slash)["']/u);
    expect(service).toContain('fail("credentials"');
    expect(service).toContain('The saved credentials no longer match the local daemon.');
    expect(service).not.toMatch(/errorMessage\s*=\s*processError/u);
  });

  it('keeps the popout bounded, ordered, readable, and keyboard accessible', () => {
    const popout = readFileSync(join(pluginSource, 'StatusPopout.qml'), 'utf8');
    // The popout is drawn on Omarchy's popup card, so it must read the popup tokens. Using
    // bar.barForeground here painted every label in the card's own background colour on a
    // light wallpaper over a dark theme, leaving the popout blank.
    expect(popout).toContain('Color.popups.text');
    expect(popout).toContain('Color.popups.background');
    expect(popout).not.toContain('bar.background');
    // The empty popout is a first-run screen: headline, explanation, and the command that
    // resolves it on its own surface, never one sentence with the shell verb buried in prose.
    expect(popout).toContain('"Register a folder as a workspace to start tracking projects."');
    expect(popout).toContain('"Projects appear here as your agents create them."');
    expect(popout).toContain('text: "pimpampum workspace:add"');
    expect(popout).not.toContain('No workspaces. Run:');
    expect(popout).toContain('text: "Authentication required"');
    expect(popout).toContain('text: "pimpampum install"');
    expect(popout).toContain('root.service.connectionState !== "credentials"');
    expect(popout).not.toContain('Local credentials were rejected. Run');
    const actionArea = readFileSync(join(pluginSource, 'PimpampumActionArea.qml'), 'utf8');
    const settingsButton = readFileSync(join(pluginSource, 'PimpampumSettingsButton.qml'), 'utf8');

    expect(popout).toContain('contentWidth: fittedContentWidth(Style.space(380))');
    expect(popout).toContain(
      'contentHeight: fittedContentHeight(Math.min(content.implicitHeight + Style.space(53), Style.space(520)))',
    );
    expect(popout).toContain('boundsBehavior: Flickable.StopAtBounds');
    expect(popout).toContain('clip: true');

    const ordered = [
      'text: root.helpView ? "Help" : root.settingsView ? "Settings" : "Pimpampum"',
      '&& root.service.connectionState !== "credentials"',
      '? "No workspaces" : "No projects"',
      'text: "Active work ("',
      'text: "Specs in progress ("',
      'text: "Projects ("',
      '+ "Completed specs ("',
      '+ "Cancelled ("',
      'text: "Synchronization"',
      'text: "Backup"',
    ].map((fragment) => popout.indexOf(fragment));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));

    expect(popout).toContain('elide: Text.ElideRight');
    expect(popout).toContain('elide: Text.ElideMiddle');
    expect(popout).toContain('modelData.workspace.name + " / " + modelData.slug');
    expect(popout).toContain('modelData.taskTitle ? modelData.taskTitle : modelData.specTitle');
    expect(popout).toContain('if (seconds < 60) return "<1m"');
    expect(popout).not.toContain('return seconds + "s"');
    for (const control of [
      'projectAction',
      'completedAction',
      'completedRowAction',
      'cancelledAction',
      'cancelledRowAction',
      'headerActionArea',
      'syncPrimaryAction',
      'backupPrimaryAction',
    ]) {
      expect(popout).toContain(`id: ${control}`);
    }
    expect(popout.match(/PimpampumActionArea\s*\{/gu)?.length).toBeGreaterThanOrEqual(6);
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
    expect(popout).toContain('property bool cancelledExpanded: false');
    expect(popout).toContain('return project.lifecycleState === "done"');
    expect(popout).toContain('return project.lifecycleState === "cancelled"');
    expect(popout).toContain('modelData.title + " · Cancelled · "');
    expect(popout).toContain('property bool settingsView: false');
    expect(popout).toContain('PimpampumHeaderIcon {');
    expect(popout).toContain('back: root.settingsView');
    expect(popout).toContain('id: headerAction');
    expect(popout).toContain('width: Style.space(44)');
    expect(popout).toContain('property bool helpView: false');
    expect(popout).not.toContain('id: helpAction');
    expect(popout).toContain('id: footerHelpAction');
    expect(popout).toContain('id: footer');
    expect(popout).toContain('height: Style.space(52)');
    expect(popout).toContain('anchors.bottom: footerSeparator.top');
    expect(popout).toContain('anchors.bottom: parent.bottom');
    expect(popout).toContain('Accessible.name: "Open help"');
    expect(popout).toContain('Accessible.name: root.helpView ? "Back to portfolio"');
    expect(popout).toContain('id: helpPage');
    expect(popout).toContain('visible: root.settingsView && root.helpView');
    expect(popout).toContain('pimpampum sync conflicts');
    expect(popout).toContain('text: "Synchronization"');
    expect(popout).toContain('text: "Backup"');
    expect(popout).not.toContain('syncExpanded');
    expect(popout).not.toContain('backupExpanded');
    expect(popout).toContain('model: root.settingsView ? [] : root.activeWork');
    expect(popout).toContain('text: "Specs in progress ("');
    expect(popout).toContain('spec.lifecycleState === "ready"');
    expect(popout).toContain('spec.projectLifecycleState === "open"');
    expect(popout).toContain('+ "/" + modelData.taskCount + " tasks"');
    expect(popout).toContain('+ "Completed specs ("');
    expect(popout).toContain(
      'model: !root.settingsView && root.completedExpanded ? root.completedSpecs : []',
    );
    expect(popout).toContain('showSettings(false)');
    expect(popout).toContain('id: footer');
    expect(popout).toContain('text: root.serviceControl.running ? "Quit" : "Start"');
    expect(popout).toContain(
      'Accessible.name: root.serviceControl.running ? "Quit Pimpampum" : "Start Pimpampum"',
    );
    expect(popout).toContain('id: quitAction');
    expect(popout).toContain('id: footerHelpAction');
    expect(popout).not.toContain('id: footerSettingsAction');
    expect(popout).toContain('actionEnabled: !root.backupService.busy');
    expect(settingsButton).toContain('implicitHeight: Style.space(44)');
    expect(settingsButton).toContain('minimumWidth: compact ? Style.space(44)');
    expect(settingsButton).toContain('Accessible.name: root.label');
    expect(settingsButton).toContain('property color accent: Color.accent');
    expect(settingsButton).toContain(
      'Style.selectedFillFor(root.foreground, root.accent, root.urgent)',
    );
    expect(popout).toContain('!root.syncService.paused');
    expect(popout).toContain('text: "How Pimpampum works"');
    expect(popout).toContain('Active work names the task being claimed now');
    expect(popout).toContain('Specs in progress remain visible even when no task is claimed');
    expect(popout).toContain('Completed Specs stay collapsed');
    expect(popout).toContain('registered project and workspace names');
    expect(popout).toContain('readonly property color accent: Color.accent');
    expect(popout).toContain('parent.width - syncSecondaryAction.width');
    expect(popout).toContain('parent.width - backupSecondaryAction.width');
    expect(popout).toContain('var arguments = ["xdg-open", path]');
    expect(popout).not.toMatch(/sh\s+-c|bash\s+-c|xdg-open.*\+/u);
  });

  it('accepts only overview v2 with Spec or Task active work', () => {
    const service = readFileSync(join(pluginSource, 'OverviewService.qml'), 'utf8');

    expect(service).toContain('envelope.meta.schemaVersion !== 2');
    expect(service).toContain('["spec", "task"].indexOf(work.targetType)');
    expect(service).toContain('isString(work.specId)');
    expect(service).toContain('isString(work.specTitle)');
    expect(service).toContain('function validSpec(spec)');
    expect(service).toContain('Array.isArray(data.specs)');
    expect(service).toContain('typeof data.specsTruncated !== "boolean"');
    expect(service).toContain(
      'work.targetType === "spec" && (work.taskId !== null || work.taskTitle !== null)',
    );
  });

  it('collects service output without mutating the read-only collector text', () => {
    const control = readFileSync(join(pluginSource, 'ServiceControl.qml'), 'utf8');

    expect(control).toContain('property string processOutput: ""');
    expect(control).toContain('onStreamFinished: root.processOutput = text');
    expect(control).toContain('JSON.parse(processOutput.trim())');
    expect(control).not.toContain('output.text = ""');
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
    expect(popout).toContain('pimpampum-folder-picker');
    expect(popout).not.toContain('QtQuick.Dialogs');
    expect(popout).toContain('triggerMode: root.folderDialogOpen ? "hover" : "click"');
    expect(popout).toContain('readonly property bool folderDialogOpen: folderPicker.running');
    expect(popout).toContain('if (workspaceOpener.running) return');
    expect(popout).not.toContain('already opening a workspace');
    expect(popout).toContain('Folder picker unavailable. Configure');
    expect(popout).not.toContain('Enter path manually');
    expect(statSync(join(pluginSource, 'pimpampum-folder-picker')).mode & 0o111).not.toBe(0);
    expect(helper).toContain('backup "$@"');
    expect(helper).not.toMatch(/eval\b|bearer|token/iu);
  });

  it('exposes automatic shared-folder synchronization without shell interpolation', () => {
    const widget = readFileSync(join(pluginSource, 'BarWidget.qml'), 'utf8');
    const service = readFileSync(join(pluginSource, 'SyncService.qml'), 'utf8');
    const popout = readFileSync(join(pluginSource, 'StatusPopout.qml'), 'utf8');
    const helper = readFileSync(join(pluginSource, 'pimpampum-sync'), 'utf8');
    expect(widget).toContain('SyncService {');
    expect(popout).toContain('Synchronization');
    expect(popout).toContain('Sync now');
    expect(popout).toContain('root.syncService.paused ? "Resume" : "Pause"');
    expect(popout).toContain('visible: root.syncService.enabled && !root.confirmingSyncForget');
    expect(popout).toContain('visible: root.confirmingSyncForget');
    expect(popout).toContain('id: settingsSummary');
    expect(popout).toContain('id: syncManageButton');
    expect(popout).toContain('label: root.syncManageOpen ? "Close" : "Manage"');
    expect(popout).toContain('label: "Change location"');
    expect(popout).toContain('id: syncPrimaryAction');
    expect(popout).toContain('id: backupPrimaryAction');
    expect(popout).not.toContain('opacity: modelData.enabled && !root.backupService.busy');
    expect(popout).toContain('local changes are safe');
    expect(popout).toContain('Synchronization shares work between computers.');
    expect(popout).toContain('root.effectiveSyncDirectory(root.manualSyncDirectory)');
    expect(popout).toContain('Existing snapshots may be imported before');
    expect(popout).toContain('"Enable sync"');
    expect(popout).toContain('visible: root.confirmingSyncEnable');
    expect(popout).toContain('root.folderDialogAvailable');
    expect(popout).toContain('text: root.syncService.deviceId');
    expect(popout).toContain('root.syncService.pendingCount');
    expect(popout).toContain('syncService.lastImportAt');
    expect(popout).toContain('syncService.lastExportAt');
    expect(popout).toContain('onTriggered: root.runSyncAction("open")');
    expect(popout).toContain('pimpampum sync conflicts');
    expect(popout).toContain('Shared snapshots and local portfolio data will not be deleted.');
    expect(popout).toContain('"Enable backup"');
    expect(popout).toContain('Backup keeps a separate recovery copy.');
    expect(popout).toContain('"Confirm disable"');
    expect(popout).not.toContain('TextInput {');
    const pickerAcceptance = popout.slice(
      popout.indexOf('function acceptFolderPicker'),
      popout.indexOf('function syncStatusText'),
    );
    expect(pickerAcceptance).not.toContain('syncService.configure');
    expect(pickerAcceptance).not.toContain('backupService.configure');
    expect(service).toContain('deviceId = parsed.deviceId || ""');
    expect(service).toContain('directoryOpener.command = ["xdg-open", directory]');
    expect(service).toContain('actionableProcessError("Synchronization operation failed")');
    expect(service).toContain('processError.length > 4096');
    expect(service).toContain('message.length > 500');
    expect(service).toContain('var arguments = [helperPath, operation]');
    expect(service).toContain('arguments.push(path)');
    expect(service).not.toMatch(/sh\s+-c|bash\s+-c|shellQuote|\+\s*(?:directory|path)/u);
    expect(helper).toContain('sync configure "$2" --device "$device_id" --json');
    expect(helper).not.toMatch(/eval\b|bearer|token/iu);
  });

  it('keeps daemon lifecycle recovery inside a bounded installed helper', () => {
    const widget = readFileSync(join(pluginSource, 'BarWidget.qml'), 'utf8');
    const popout = readFileSync(join(pluginSource, 'StatusPopout.qml'), 'utf8');
    const control = readFileSync(join(pluginSource, 'ServiceControl.qml'), 'utf8');
    const helper = readFileSync(join(pluginSource, 'pimpampum-service'), 'utf8');

    expect(widget).toContain('ServiceControl {');
    expect(widget).toContain('serviceControl: serviceControl');
    expect(popout).toContain('text: "Pimpampum service"');
    expect(popout).toContain('"Restart service"');
    expect(popout).toContain('"Stop Pimpampum…"');
    expect(popout).toContain('"Start Pimpampum"');
    expect(popout).toContain('visible: root.confirmingServiceStop');
    expect(control).toContain('serviceProcess.command = [helperPath, operation]');
    expect(control).toContain('typeof parsed.running !== "boolean"');
    expect(helper).toContain('/usr/bin/systemctl --user "$1" pimpampum.service');
    expect(helper).toContain('/usr/bin/systemctl --user is-active --quiet pimpampum.service');
    expect(helper).not.toMatch(/eval\b|sh\s+-c|bash\s+-c|bearer|token/iu);
  });

  it('checks and installs updates only after an explicit accessible action', () => {
    const widget = readFileSync(join(pluginSource, 'BarWidget.qml'), 'utf8');
    const popout = readFileSync(join(pluginSource, 'StatusPopout.qml'), 'utf8');
    const service = readFileSync(join(pluginSource, 'UpdateService.qml'), 'utf8');
    const helper = readFileSync(join(pluginSource, 'pimpampum-update'), 'utf8');
    expect(widget).toContain('UpdateService {');
    expect(popout).toContain('"Check for updates"');
    expect(popout).toContain('"Install update"');
    expect(popout).toContain('actionEnabled: !root.updateService.busy');
    // The service owns exactly one Timer, and it is a deadline for a check the user started.
    // A repeating timer here would turn the popout into a background updater, which is the
    // behaviour this test exists to forbid.
    expect(service.match(/Timer \{/gu)).toHaveLength(1);
    expect(service).toContain('id: checkDeadline');
    expect(service).toContain('repeat: false');
    expect(service).not.toMatch(/repeat:\s*true/u);
    expect(service).toContain('command = [helperPath, operation]');
    expect(service).toContain('Qt.callLater(function() { root.handleExit(exitCode) })');
    expect(service).toContain('helperPath.charAt(0) !== "/"');
    expect(service).toContain('stderr: StdioCollector');
    // The CLI writes its typed envelope to stderr and leaves stdout empty on a failure. Parsing
    // only stdout reported an npm refusal as "Could not install the update".
    expect(service).toContain('root.actionableFailure(');
    expect(service).toContain('root.processError, root.actionableFailure(root.processOutput');
    expect(service).toContain('stream.length > 4096');
    expect(service).toContain('message.length > 500');
    expect(service).toContain('"Could not install the update" : "Could not check for updates"');
    expect(service).not.toMatch(/errorMessage\s*=\s*(?:root\.)?processError\b/u);
    expect(helper).toContain('command_name=update:check');
    expect(helper).toContain('command_name=update');
    expect(helper).not.toMatch(/eval\b|bearer|token/iu);
  });

  // A hung `npm view` used to leave the popout on "Checking…" until the shell restarted. Only the
  // read-only check is bounded: killing a half-finished install is worse than waiting for it.
  it('bounds a running update check and leaves an install unbounded', () => {
    const service = readFileSync(join(pluginSource, 'UpdateService.qml'), 'utf8');

    expect(service).toContain('readonly property int checkTimeoutMs: 90000');
    expect(service).toContain('if (operation !== "install") checkDeadline.restart()');
    expect(service).toContain('checkDeadline.stop()');
    // The deadline settles the state itself, so a terminated child that never reports an exit
    // cannot strand the popout.
    expect(service).toContain(
      'root.errorMessage = "The update check took too long. Retry when the network responds."',
    );
    expect(service).toContain('if (root.timedOut) return');
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
