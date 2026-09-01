#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableHelpers } from './check-omarchy-delivery.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryPluginRoot = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
const pluginRoot = realpathSync(resolve(process.argv[2] ?? repositoryPluginRoot));
const sharedFixtureRoot = join(repositoryRoot, 'test/fixtures/overview');
const pluginFixtureRoot = join(pluginRoot, 'fixtures');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function validateCompactSVG(svg, label) {
  invariant(svg.length >= 256 && svg.length <= 4096, `${label} has an invalid file size`);
  invariant(
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg\b/u.test(svg) &&
      svg.trimEnd().endsWith('</svg>'),
    `${label} is not a bounded standalone SVG`,
  );
  invariant(
    /\bwidth="16"\s+height="16"\s+viewBox="0 0 16 16"/u.test(svg),
    `${label} must use the canonical 16 by 16 canvas`,
  );
  invariant(
    svg.includes('fill="#000000" fill-rule="evenodd"') &&
      svg.includes('d="M8 .5a7.5 7.5 0 1 1 0 15') &&
      svg.includes('M4.8 3.9h1.4v.7') &&
      svg.includes('M6.3 7.2c0-1.3'),
    `${label} does not contain the canonical circle and lowercase-p outlines`,
  );
  invariant(
    !/(?:<script\b|<image\b|<text\b|<style\b|\bhref\s*=|\burl\s*\()/iu.test(svg),
    `${label} must contain local outlined vector geometry only`,
  );
  const colors = [...svg.matchAll(/\bfill="([^"]+)"/gu)].map((match) => match[1]);
  invariant(
    colors.length === 1 && colors[0] === '#000000',
    `${label} must remain monochrome and theme-tintable`,
  );
}

function walk(path) {
  const entries = [];
  for (const name of readdirSync(path).sort()) {
    if (name === '.git') continue;
    const child = join(path, name);
    const stat = lstatSync(child);
    invariant(!stat.isSymbolicLink(), `symlink is not allowed: ${relative(pluginRoot, child)}`);
    if (stat.isDirectory()) entries.push(...walk(child));
    else entries.push(child);
  }
  return entries;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validEnvelope(value) {
  if (!isObject(value) || !isObject(value.meta) || value.meta.schemaVersion !== 2) return false;
  if (!isObject(value.data)) return false;
  const { data } = value;
  if (!['active', 'available', 'complete', 'draft', 'paused', 'empty'].includes(data.status)) {
    return false;
  }
  if (!isObject(data.daemon) || typeof data.daemon.version !== 'string') return false;
  if (!Array.isArray(data.projects) || !Array.isArray(data.activeWork)) return false;
  if (data.projects.length > 500 || data.activeWork.length > 500) return false;
  if (!isObject(data.counts)) return false;
  const countFields = [
    'workspaces',
    'projects',
    'specs',
    'draftProjects',
    'openProjects',
    'pausedProjects',
    'completedProjects',
    'cancelledProjects',
    'openTasks',
    'completedTasks',
    'cancelledTasks',
    'activeClaims',
    'availableWork',
  ];
  if (!countFields.every((field) => isCount(data.counts[field]))) return false;
  if (typeof data.projectsTruncated !== 'boolean') return false;
  if (typeof data.activeWorkTruncated !== 'boolean') return false;
  const validProjects = data.projects.every(
    (project) =>
      isObject(project) &&
      isObject(project.workspace) &&
      typeof project.id === 'string' &&
      typeof project.title === 'string' &&
      typeof project.workspace.rootPath === 'string' &&
      isAbsolute(project.workspace.rootPath) &&
      ['draft', 'open', 'paused', 'done', 'cancelled'].includes(project.lifecycleState) &&
      ['active', 'available', 'draft', 'paused', 'complete'].includes(project.status) &&
      [
        'specCount',
        'openTaskCount',
        'completedTaskCount',
        'activeClaimCount',
        'availableWorkCount',
      ].every((field) => isCount(project[field])),
  );
  const validWork = data.activeWork.every(
    (work) =>
      isObject(work) &&
      ['spec', 'task'].includes(work.targetType) &&
      [
        'targetId',
        'workspaceId',
        'projectId',
        'projectTitle',
        'specId',
        'specTitle',
        'agentId',
      ].every((field) => typeof work[field] === 'string' && work[field].length > 0) &&
      (work.targetType === 'spec'
        ? work.taskId === null && work.taskTitle === null
        : typeof work.taskId === 'string' && typeof work.taskTitle === 'string'),
  );
  return validProjects && validWork;
}

const files = walk(pluginRoot);
const relativeFiles = new Set(files.map((path) => relative(pluginRoot, path)));
// Every QML component of the reviewed plugin and every executable helper of the delivery checker
// must ship; a hand-kept list silently skipped four QML files and the shared shell library.
const qmlNames = readdirSync(repositoryPluginRoot)
  .filter((name) => name.endsWith('.qml'))
  .sort();
invariant(qmlNames.length >= 13, 'reviewed plugin lost QML components');
for (const expected of [
  '.pimpampum-plugin-owner.json',
  'README.md',
  'assets/pimpampum-compact.svg',
  'manifest.json',
  'runtime-manifest.json',
  ...executableHelpers,
  ...qmlNames,
]) {
  invariant(relativeFiles.has(expected), `missing plugin file: ${expected}`);
}

const canonicalCompactMarkPath = join(
  repositoryRoot,
  'branding/assets/pimpampum-compact-master.svg',
);
invariant(
  existsSync(canonicalCompactMarkPath) && lstatSync(canonicalCompactMarkPath).isFile(),
  'canonical compact-mark SVG is missing',
);
const canonicalCompactMark = read(canonicalCompactMarkPath);
const pluginCompactMark = read(join(pluginRoot, 'assets/pimpampum-compact.svg'));
validateCompactSVG(canonicalCompactMark, 'canonical compact-mark SVG');
validateCompactSVG(pluginCompactMark, 'plugin compact-mark SVG');
invariant(
  pluginCompactMark === canonicalCompactMark,
  'plugin compact-mark SVG differs from the reviewed canonical master',
);

const manifest = JSON.parse(read(join(pluginRoot, 'manifest.json')));
invariant(manifest.schemaVersion === 1, 'manifest schemaVersion must be 1');
invariant(manifest.id === 'dev.pimpampum.status', 'manifest id is incorrect');
invariant(
  Array.isArray(manifest.kinds) && manifest.kinds.length === 1,
  'manifest kinds must be bounded',
);
invariant(manifest.kinds[0] === 'bar-widget', 'manifest must declare bar-widget');
invariant(
  manifest.entryPoints?.barWidget === 'BarWidget.qml',
  'bar-widget entry point is incorrect',
);
invariant(manifest.barWidget?.allowMultiple === false, 'allowMultiple must be false');
invariant(manifest.barWidget?.defaultSection === 'right', 'default section must be right');

for (const entryPoint of Object.values(manifest.entryPoints)) {
  invariant(
    typeof entryPoint === 'string' && entryPoint.length > 0,
    'entry point must be a string',
  );
  invariant(
    !isAbsolute(entryPoint) && !entryPoint.split(/[\\/]/u).includes('..'),
    'entry point is unsafe',
  );
  const resolved = resolve(pluginRoot, entryPoint);
  invariant(resolved.startsWith(`${pluginRoot}${sep}`), 'entry point escapes the plugin');
  invariant(
    relativeFiles.has(relative(pluginRoot, resolved)),
    `missing entry point: ${entryPoint}`,
  );
}

// Every `.qml` file of the candidate takes part in the safety sweeps below; a fixed list once left
// four components outside the bar-member, shell-interpolation, credential and read-only checks.
const qml = readdirSync(pluginRoot)
  .filter((name) => name.endsWith('.qml'))
  .sort()
  .map((name) => read(join(pluginRoot, name)))
  .join('\n');
const barWidget = read(join(pluginRoot, 'BarWidget.qml'));
const updateService = read(join(pluginRoot, 'UpdateService.qml'));
const agentConnectionService = read(join(pluginRoot, 'AgentConnectionService.qml'));
const pimpampumActionArea = read(join(pluginRoot, 'PimpampumActionArea.qml'));
const pimpampumMark = read(join(pluginRoot, 'PimpampumMark.qml'));
const settingsButton = read(join(pluginRoot, 'PimpampumSettingsButton.qml'));
const statusPopout = read(join(pluginRoot, 'StatusPopout.qml'));
const overviewService = read(join(pluginRoot, 'OverviewService.qml'));
const serviceControl = read(join(pluginRoot, 'ServiceControl.qml'));
const serviceHelper = read(join(pluginRoot, 'pimpampum-service'));
// `background` is deliberately absent: on a transparent bar Omarchy resolves it to the
// foreground, so reading it as a background inverts every contrast decision. Any use now
// fails as an undocumented member.
const documentedBarMembers = new Set([
  'barSize',
  'barForeground',
  'fontFamily',
  'foreground',
  'hideTooltip',
  'position',
  'releasePopout',
  'requestPopout',
  'showTooltip',
  'urgent',
  'vertical',
]);
for (const match of qml.matchAll(/(?:^|[^.\w])bar\.([A-Za-z_]\w*)/gmu)) {
  invariant(documentedBarMembers.has(match[1]), `undocumented injected bar member: ${match[1]}`);
}
invariant(
  statusPopout.includes('Color.popups.text') && statusPopout.includes('Color.popups.background'),
  'popout content must use the popup card tokens, not the bar foreground resolved against the wallpaper',
);
invariant(
  statusPopout.includes('"Register a folder as a workspace to start tracking projects."') &&
    statusPopout.includes('"Projects appear here as your agents create them."') &&
    statusPopout.includes(
      'text: root.controlLauncherPath + " workspace:add <id> <name> /absolute/folder"',
    ) &&
    statusPopout.includes('"/.local/share/pimpampum/bin/pimpampum-control"') &&
    !statusPopout.includes('text: "pimpampum workspace:add"'),
  'empty states must teach: headline, explanation, and the absolute launcher command on its own surface',
);
// D-01: the first workspace is registered from the popout itself, through the same isolated
// folder picker and the bounded route, so a native install never needs a terminal for it.
invariant(
  statusPopout.includes('id: addWorkspaceAction') &&
    statusPopout.includes(
      'label: workspaceRegistrar.running ? "Adding workspace…" : "Add a workspace"',
    ) &&
    statusPopout.includes('onTriggered: root.chooseDirectory("workspace")') &&
    statusPopout.includes('var arguments = [controlRoutePath, "workspace", "add"]') &&
    statusPopout.includes('arguments.push(path)') &&
    statusPopout.includes('Qt.resolvedUrl("pimpampum-control-route")') &&
    statusPopout.includes(
      'Qt.callLater(function() { root.acceptWorkspaceRegistration(exitCode) })',
    ) &&
    statusPopout.includes('root.workspaceRegistrationError !== ""') &&
    statusPopout.includes('root.workspaceRegistrationNotice !== ""'),
  'the empty popout must register a workspace through the folder picker and the bounded route',
);
invariant(
  statusPopout.includes('text: "Authentication required"') &&
    statusPopout.includes('text: "pimpampum install"') &&
    overviewService.includes('"The saved credentials no longer match the local daemon."'),
  'rejected credentials must explain the mismatch and present the repair command separately',
);
invariant(qml.includes('bar.requestPopout'), 'native popout request is missing');
invariant(qml.includes('bar.releasePopout'), 'native popout release is missing');
for (const member of ['barForeground', 'urgent', 'fontFamily', 'position', 'vertical', 'barSize']) {
  invariant(qml.includes(`bar.${member}`), `theme/bar member is not inherited: ${member}`);
}
invariant(
  qml.includes('command: [root.helperPath]'),
  'overview helper must be launched as one absolute command',
);
invariant(
  qml.includes('interval: root.popoutOpen ? 5000 : 10000'),
  'polling intervals are incorrect',
);
invariant(
  qml.includes('var arguments = ["xdg-open", path]'),
  'xdg-open must receive one path argument',
);
invariant(
  qml.includes('pimpampum-folder-picker') && !qml.includes('QtQuick.Dialogs'),
  'isolated folder picker is missing or unsafe in-process dialog is present',
);
invariant(
  qml.includes('Folder picker unavailable. Configure') && !qml.includes('Enter path manually'),
  'folder picker failure must direct users to the bounded CLI without a duplicate path form',
);
invariant(qml.includes('command: [root.helperPath, "status"]'), 'backup helper command is missing');
invariant(
  qml.includes('var arguments = [helperPath, operation]') && qml.includes('arguments.push(path)'),
  'backup helper must receive the directory as a separate process argument',
);
// M-C6: a corrupt settings file makes the daemon answer `enabled: false, state: "error"` with a
// message and no destination. The reader accepts exactly that third shape and the card renders
// the message under "Backup needs attention".
const backupService = read(join(pluginRoot, 'BackupService.qml'));
invariant(
  backupService.includes('if (value.state === "disabled") return value.error === null') &&
    backupService.includes('return value.state === "error" && value.error !== null') &&
    backupService.includes('if (value.snapshotPath !== null) return false') &&
    backupService.includes('value.error.length > 500') &&
    !backupService.includes('value.state !== "disabled" || value.snapshotPath !== null') &&
    statusPopout.includes(
      'if (backupService.backupState === "error") return "Backup needs attention"',
    ) &&
    statusPopout.includes(
      'text: root.backupService.operationError !== "" ? root.backupService.operationError : root.backupService.statusError',
    ),
  'the backup reader must accept the unreadable-settings shape and the card must show its message',
);
invariant(
  !/(?:sh\s+-c|bash\s+-c|shellQuote|\+\s*(?:directory|path))/u.test(qml),
  'QML must not interpolate paths into shell commands',
);
invariant(qml.includes('Completed'), 'completed-project disclosure is missing');
invariant(
  !/(?:PIMPAMPUM_TOKEN|Authorization\s*:|Bearer\s+[A-Za-z0-9._~-]{8,})/u.test(qml),
  'QML must not contain credential values',
);
invariant(
  qml.includes('fail("credentials"') && qml.includes('text: "pimpampum install"'),
  'credential rejection must remain distinct and actionable',
);
invariant(
  qml.includes('completedGreen') && pimpampumMark.includes('status === "complete" ? completeColor'),
  'completed status must have a distinct green treatment',
);
invariant(
  barWidget.includes('PimpampumMark {') && !barWidget.includes('statusIcon'),
  'bar widget must use the fixed Pimpampum mark instead of status identity glyphs',
);
invariant(
  pimpampumMark.includes('fillColor: root.foreground') &&
    pimpampumMark.includes('fillRule: ShapePath.OddEvenFill') &&
    !pimpampumMark.includes('contrastBackground') &&
    !pimpampumMark.includes('MultiEffect {'),
  'fixed mark must fill from the bar foreground, never picked from the theme background ' +
    'and never tinted through a layer, whose cached texture keeps the first color',
);
// The mark is drawn from the reviewed master's own path data, so the identity cannot drift
// between the canonical SVG and what the bar actually paints.
const canonicalMarkPath = /\sd="([^"]+)"/u.exec(canonicalCompactMark)?.[1];
invariant(
  typeof canonicalMarkPath === 'string' && canonicalMarkPath.length > 0,
  'canonical compact-mark SVG has no path data',
);
invariant(
  pimpampumMark.includes(`path: "${canonicalMarkPath}"`),
  'fixed mark path must match the canonical master SVG exactly',
);
invariant(
  pimpampumMark.includes('id: badge') &&
    pimpampumMark.includes('badgeKind') &&
    !/["'](?:×|!|✓|wifi\.slash)["']/u.test(`${barWidget}\n${pimpampumMark}`),
  'status must use an external badge without replacing product identity',
);
invariant(
  pimpampumMark.includes('Math.max(0, activeClaims)') &&
    pimpampumMark.includes('safeActiveClaims >= 100 ? "99+" : String(safeActiveClaims)') &&
    pimpampumMark.includes('visible: root.showActiveCount && root.safeActiveClaims > 0') &&
    pimpampumMark.includes('visible: !root.showActiveCount || root.safeActiveClaims === 0'),
  'active-claim count must clamp negatives, hide zero, and cap three digits at 99+',
);
invariant(
  barWidget.includes('activeBlue: "#3b82f6"') &&
    barWidget.includes('availableAmber: "#f59e0b"') &&
    barWidget.includes('completedGreen: "#22c55e"') &&
    pimpampumMark.includes('status === "active" ? activeColor') &&
    pimpampumMark.includes('status === "available" ? availableColor') &&
    pimpampumMark.includes('status === "complete" ? completeColor') &&
    pimpampumMark.includes('"active": "dot"') &&
    pimpampumMark.includes('"available": "bar"') &&
    pimpampumMark.includes('"complete": "square"') &&
    pimpampumMark.includes('"cancelled": "ring"') &&
    pimpampumMark.includes('"offline": "diamond"'),
  'indicator must use semantic accents and distinct external status shapes',
);
invariant(
  pimpampumMark.includes('columns: root.vertical ? 1 : 2') &&
    pimpampumMark.includes('rows: root.vertical ? 2 : 1'),
  'mark and count must switch between horizontal and vertical bar layouts',
);
invariant(
  pimpampumMark.includes('statusLabel + " · " + claimLabel') &&
    barWidget.includes('Accessible.name: indicator.accessibleLabel') &&
    barWidget.includes('Accessible.onPressAction: root.togglePanel()'),
  'mark and count must expose one combined accessible label',
);
invariant(
  statusPopout.includes('PopupCard {') &&
    statusPopout.includes('contentWidth: fittedContentWidth(Style.space(380))') &&
    statusPopout.includes(
      'contentHeight: fittedContentHeight(Math.min(content.implicitHeight + Style.space(53), Style.space(520)))',
    ) &&
    statusPopout.includes('clip: true') &&
    statusPopout.includes('boundsBehavior: Flickable.StopAtBounds'),
  'popout must remain native, bounded, clipped, and scrollable',
);
const popoutOrder = [
  'text: root.helpView ? "Help" : root.settingsView ? "Settings" : "Pimpampum"',
  '&& root.service.connectionState !== "credentials"',
  '? "No workspaces" : "No projects"',
  'text: "Active work ("',
  'text: "Specs in progress ("',
  'text: "Projects ("',
  '+ "Completed specs ("',
  '+ "Cancelled ("',
  'text: "Backup"',
].map((fragment) => statusPopout.indexOf(fragment));
invariant(
  popoutOrder.every((index) => index >= 0) &&
    popoutOrder.every((index, position) => position === 0 || index > popoutOrder[position - 1]),
  'popout must preserve portfolio order before the dedicated settings controls',
);
invariant(
  statusPopout.includes('PimpampumHeaderIcon {') &&
    statusPopout.includes('back: root.settingsView') &&
    statusPopout.includes('width: Style.space(44)') &&
    statusPopout.includes('property bool helpView: false') &&
    !statusPopout.includes('id: helpAction') &&
    statusPopout.includes('id: footerHelpAction') &&
    statusPopout.includes('Accessible.name: "Open help"') &&
    statusPopout.includes('Accessible.name: root.helpView ? "Back to portfolio"') &&
    statusPopout.includes('id: helpPage') &&
    statusPopout.includes('pimpampum sync conflicts') &&
    statusPopout.includes('text: "Synchronization"') &&
    statusPopout.includes('text: "Backup"') &&
    !statusPopout.includes('syncExpanded') &&
    !statusPopout.includes('backupExpanded'),
  'synchronization and backup must live in one navigable settings view',
);
invariant(
  statusPopout.includes('id: footer') &&
    statusPopout.includes('text: root.serviceControl.running ? "Quit" : "Start"') &&
    statusPopout.includes(
      'Accessible.name: root.serviceControl.running ? "Quit Pimpampum" : "Start Pimpampum"',
    ) &&
    statusPopout.includes('id: quitAction') &&
    statusPopout.includes('anchors.right: parent.right') &&
    statusPopout.includes('id: footerHelpAction') &&
    statusPopout.includes('anchors.left: parent.left') &&
    statusPopout.includes('anchors.bottom: footerSeparator.top') &&
    statusPopout.includes('anchors.bottom: parent.bottom') &&
    statusPopout.includes('id: footer') &&
    statusPopout.includes('height: Style.space(52)') &&
    !statusPopout.includes('id: footerSettingsAction') &&
    statusPopout.includes('height: Style.space(44)'),
  'popover footer must expose accessible Help and Quit/Start actions',
);
invariant(
  statusPopout.includes('Active work names the task being claimed now') &&
    statusPopout.includes('Specs in progress remain visible even when no task is claimed') &&
    statusPopout.includes('Completed Specs stay collapsed') &&
    statusPopout.includes('registered project and workspace names'),
  'help must explain work names and the in-progress/completed Spec hierarchy',
);
invariant(
  statusPopout.includes('elide: Text.ElideRight') &&
    statusPopout.includes('elide: Text.ElideMiddle') &&
    statusPopout.includes('modelData.workspace.name + " / " + modelData.slug'),
  'popout must elide long content while preserving workspace and slug disambiguation',
);
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
  invariant(statusPopout.includes(`id: ${control}`), `missing interactive control: ${control}`);
}
invariant(
  (statusPopout.match(/PimpampumActionArea\s*\{/gu) ?? []).length >= 6 &&
    pimpampumActionArea.includes('hoverEnabled: true') &&
    pimpampumActionArea.includes('activeFocusOnTab: focusOnTab') &&
    pimpampumActionArea.includes('Keys.onPressed:') &&
    pimpampumActionArea.includes('Accessible.onPressAction: root.triggered()') &&
    pimpampumActionArea.includes('if (root.triggerOnClick) root.triggered()') &&
    statusPopout.includes('containsMouse ? 0.07 : 0') &&
    statusPopout.includes('Accessible.name:'),
  'interactive rows, disclosures, and actions need hover, focus, keyboard, and accessibility',
);
invariant(
  statusPopout.includes('property bool completedExpanded: false') &&
    statusPopout.includes('property bool cancelledExpanded: false') &&
    statusPopout.includes('visible: root.settingsView') &&
    statusPopout.includes('actionEnabled: !root.backupService.busy') &&
    settingsButton.includes('implicitHeight: Style.space(44)') &&
    settingsButton.includes('Style.selectedFillFor(root.foreground, root.accent, root.urgent)') &&
    settingsButton.includes('Accessible.name: root.label') &&
    settingsButton.includes('property color accent: Color.accent') &&
    statusPopout.includes('readonly property color accent: Color.accent') &&
    statusPopout.includes('parent.width - syncSecondaryAction.width') &&
    statusPopout.includes('parent.width - backupSecondaryAction.width'),
  'project disclosures must start collapsed and settings controls must serialize while busy',
);
invariant(
  barWidget.includes('activeFocusOnTab: true') &&
    barWidget.includes('Keys.onReturnPressed: root.togglePanel()') &&
    barWidget.includes('Keys.onSpacePressed: root.togglePanel()'),
  'the compact bar widget must be keyboard focusable and activatable',
);
invariant(
  barWidget.includes('ServiceControl {') &&
    statusPopout.includes('text: "Pimpampum service"') &&
    statusPopout.includes('"Stop Pimpampum…"') &&
    statusPopout.includes('"Start Pimpampum"') &&
    serviceControl.includes('serviceProcess.command = [helperPath, operation]') &&
    serviceHelper.includes('/usr/bin/systemctl --user "$1" pimpampum.service') &&
    !/(?:eval\b|sh\s+-c|bash\s+-c|bearer|token)/iu.test(serviceHelper),
  'service controls must remain bounded, recoverable, and independent from the daemon',
);
invariant(
  barWidget.includes('displayStatus: service.effectiveStatus === "complete" && hasCancellations') &&
    barWidget.includes('"cancelled": "Finished with cancellations"') &&
    statusPopout.includes('return project.lifecycleState === "done"') &&
    statusPopout.includes('return project.lifecycleState === "cancelled"'),
  'cancelled projects must remain distinct from successful completion',
);
invariant(
  !/(?:work_complete|work:start|work:release|project_update|task_update|\bPOST\b|\bPATCH\b|\bDELETE\b)/u.test(
    qml,
  ),
  'QML crosses the project-domain read-only boundary',
);

const helper = read(join(pluginRoot, 'pimpampum-overview'));
const controlRoute = read(join(pluginRoot, 'pimpampum-control-route'));
invariant(
  helper.includes('pimpampum-control-route') && controlRoute.includes('set -- overview'),
  'overview helper does not call the bounded overview route',
);
invariant(
  !/(?:health|uninstall|work:|project:|task:)/u.test(`${helper}\n${controlRoute}`),
  'overview helper is not read-only',
);
invariant(
  !/(?:bearer|token)/iu.test(`${helper}\n${controlRoute}`),
  'overview helper contains authentication material',
);

const backupHelper = read(join(pluginRoot, 'pimpampum-backup'));
for (const action of ['status', 'configure', 'retry', 'disable']) {
  invariant(controlRoute.includes(action), `backup helper omits ${action}`);
}
// `workspace add DIRECTORY [NAME]` is the one project-domain write the popout may route, and it
// is closed: the directory must be absolute and free of control characters, the name bounded, and
// the id derived by the CLI's slug rule before `workspace:add ID NAME DIRECTORY` runs.
invariant(
  controlRoute.includes('  workspace)') &&
    controlRoute.includes('[ "$action" = add ] || fail 69 \'invalid workspace action\'') &&
    controlRoute.includes("*) fail 69 'workspace directory must be an absolute path' ;;") &&
    controlRoute.includes(
      "*[[:cntrl:]]*) fail 69 'workspace directory contains control characters' ;;",
    ) &&
    controlRoute.includes('[ "${#workspace_root}" -le 4096 ]') &&
    controlRoute.includes('[ "${#workspace_name}" -le 120 ]') &&
    controlRoute.includes("/usr/bin/sed -E 's/[^a-z0-9]+/-/g; s/^-+//'") &&
    controlRoute.includes('/usr/bin/cut -c1-80') &&
    controlRoute.includes(
      'set -- workspace:add "$workspace_id" "$workspace_name" "$workspace_root"',
    ),
  'the control route must expose exactly one bounded workspace registration verb',
);
invariant(
  backupHelper.includes('pimpampum-control-route') && controlRoute.includes('set -- backup "$@"'),
  'backup helper must preserve every caller argument boundary',
);
invariant(
  !/(?:bearer|token|eval\b|\bsh\s+-c|\bbash\s+-c)/iu.test(`${backupHelper}\n${controlRoute}`),
  'backup helper contains credentials or shell evaluation',
);
const common = read(join(pluginRoot, 'pimpampum-common.sh'));
invariant(
  common.includes('runtime-install-receipt.json') &&
    common.includes('controlLauncherSha256') &&
    common.includes('verify_control_launcher()') &&
    common.includes('validate_home()') &&
    controlRoute.includes('verify_control_launcher 69') &&
    controlRoute.includes('exec "$control_launcher" "$@"') &&
    !/(?:command\s+-v|\/\.local\/bin\/pimpampum|\bnpm\b|\bnpx\b)/u.test(
      `${controlRoute}\n${common}`,
    ),
  'surface helpers must use only the receipt-owned hash-verified control launcher',
);
invariant(
  !/(?:bearer|token|eval\b|\bsh\s+-c|\bbash\s+-c|\bhostname\b)/iu.test(common) &&
    common.includes('*"\'"* | *\'"\'* | *\\\\*)') &&
    common.includes('*[[:cntrl:]]*)'),
  'the shared helper library must reject quotes, backslashes and control characters in HOME',
);
for (const sourcingHelper of [
  'pimpampum-bootstrap',
  'pimpampum-connections',
  'pimpampum-control-route',
  'pimpampum-plugin-lifecycle',
]) {
  const source = read(join(pluginRoot, sourcingHelper));
  invariant(
    source.includes('. "$plugin_root/pimpampum-common.sh"') && source.includes('validate_home '),
    `${sourcingHelper} must source the shared library by absolute path and validate HOME through it`,
  );
}
const connectionsHelper = read(join(pluginRoot, 'pimpampum-connections'));
invariant(
  !/\bulimit\b/u.test(connectionsHelper) &&
    connectionsHelper.includes('-le 65536') &&
    connectionsHelper.includes('"cliCode":%s,"message":%s') &&
    connectionsHelper.includes("'^[a-z_]{1,40}$'") &&
    connectionsHelper.includes('/usr/bin/cut -c1-200'),
  'the connections helper must not cap file sizes and must forward the bounded CLI error code and message',
);
invariant(
  agentConnectionService.includes('/^[a-z_]{1,40}$/.test(value)') &&
    agentConnectionService.includes('value.length > 200') &&
    agentConnectionService.includes('if (cliCode === "unavailable")') &&
    agentConnectionService.includes('/not installed/i.test(message)') &&
    agentConnectionService.includes('envelope.code === "command_failed"'),
  'the connection service must render the forwarded CLI code like the other actionable errors',
);
invariant(
  updateService.includes(
    'isObject(envelope) && isObject(envelope.data) ? envelope.data : envelope',
  ),
  'the update reader must accept both the bare payload and the {data} envelope',
);
// The Linux `update` verb refuses with a typed `unavailable` whose `details.remedy` names the
// bootstrap helper of this plugin. The panel renders the message and that remedy as a command
// resolved against the plugin directory, instead of a generic failure.
invariant(
  updateService.includes('property string remedy: ""') &&
    updateService.includes('function actionableRemedy(stream)') &&
    updateService.includes('envelope.error.code !== "unavailable"') &&
    updateService.includes('/^pimpampum-[a-z]{1,40}$/.test(remedy)') &&
    updateService.includes('root.remedy = root.actionableRemedy(root.processError)') &&
    statusPopout.includes('visible: root.updateService.remedy !== ""') &&
    statusPopout.includes('text: root.pluginDirectory + "/" + root.updateService.remedy'),
  'the Updates card must render the typed remedy of a refused Linux update as a command',
);
invariant(
  serviceControl.includes('Qt.callLater(function() { root.accept(exitCode) })'),
  'service control must read collected stdout on a deferred turn like the sibling services',
);
invariant(
  !/\bnpm\b/u.test(statusPopout),
  'popout copy must not name npm; Omarchy uses the packaged provider',
);

for (const scriptName of ['install.sh', 'uninstall.sh']) {
  const script = read(join(pluginRoot, scriptName));
  invariant(!script.includes('shell.json'), `${scriptName} must not access shell.json`);
  invariant(!/\bln\b/u.test(script), `${scriptName} must not create symlinks`);
  invariant(
    !/(?:omarchy\s+plugin|omarchy-shell\s+shell)/u.test(script),
    `${scriptName} must not own Omarchy lifecycle`,
  );
  invariant(
    !/\b(?:cp|mv|rm|mkdir|mktemp)\b/u.test(script),
    `${scriptName} must not mutate plugin files directly`,
  );
}
const installScript = read(join(pluginRoot, 'install.sh'));
invariant(
  installScript.includes('exec "$pimpampum_cli" install'),
  'install wrapper must delegate to the Pimpampum lifecycle',
);
const uninstallScript = read(join(pluginRoot, 'uninstall.sh'));
invariant(
  uninstallScript.includes('exec "$pimpampum_cli" uninstall'),
  'uninstall wrapper must delegate to the Pimpampum lifecycle',
);

for (const fixtureName of ['empty.json', 'mixed.json', 'complete.json', 'invalid.json']) {
  const shared = read(join(sharedFixtureRoot, fixtureName));
  const candidate = read(join(pluginFixtureRoot, fixtureName));
  invariant(
    candidate === shared,
    `plugin fixture differs from frozen shared fixture: ${fixtureName}`,
  );
  const parsed = JSON.parse(candidate);
  invariant(
    validEnvelope(parsed) === (fixtureName !== 'invalid.json'),
    `fixture validity expectation failed: ${fixtureName}`,
  );
}

process.stdout.write(`Validated Omarchy plugin: ${pluginRoot}\n`);
