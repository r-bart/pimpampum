#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = realpathSync(
  resolve(process.argv[2] ?? join(repositoryRoot, 'integrations/omarchy/pimpampum-status')),
);
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
for (const expected of [
  '.pimpampum-plugin-owner.json',
  'BackupService.qml',
  'BarWidget.qml',
  'OverviewService.qml',
  'PimpampumActionArea.qml',
  'PimpampumMark.qml',
  'PimpampumSettingsButton.qml',
  'StatusPopout.qml',
  'SyncService.qml',
  'assets/pimpampum-compact.svg',
  'assets/pimpampum-compact-white.svg',
  'README.md',
  'install.sh',
  'manifest.json',
  'pimpampum-backup',
  'pimpampum-overview',
  'pimpampum-sync',
  'uninstall.sh',
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
const pluginCompactMarkWhite = read(join(pluginRoot, 'assets/pimpampum-compact-white.svg'));
validateCompactSVG(canonicalCompactMark, 'canonical compact-mark SVG');
validateCompactSVG(pluginCompactMark, 'plugin compact-mark SVG');
invariant(
  pluginCompactMark === canonicalCompactMark,
  'plugin compact-mark SVG differs from the reviewed canonical master',
);
invariant(
  pluginCompactMarkWhite === canonicalCompactMark.replace('#000000', '#ffffff'),
  'white compact-mark SVG must differ from the canonical master only by fill color',
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

const qml = [
  'BackupService.qml',
  'BarWidget.qml',
  'OverviewService.qml',
  'PimpampumActionArea.qml',
  'PimpampumMark.qml',
  'PimpampumSettingsButton.qml',
  'StatusPopout.qml',
  'SyncService.qml',
]
  .map((name) => read(join(pluginRoot, name)))
  .join('\n');
const barWidget = read(join(pluginRoot, 'BarWidget.qml'));
const pimpampumActionArea = read(join(pluginRoot, 'PimpampumActionArea.qml'));
const pimpampumMark = read(join(pluginRoot, 'PimpampumMark.qml'));
const settingsButton = read(join(pluginRoot, 'PimpampumSettingsButton.qml'));
const statusPopout = read(join(pluginRoot, 'StatusPopout.qml'));
const documentedBarMembers = new Set([
  'background',
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
invariant(qml.includes('bar.requestPopout'), 'native popout request is missing');
invariant(qml.includes('bar.releasePopout'), 'native popout release is missing');
for (const member of [
  'barForeground',
  'background',
  'urgent',
  'fontFamily',
  'position',
  'vertical',
  'barSize',
]) {
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
  qml.includes('fail("credentials"') && qml.includes('Run pimpampum install'),
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
  pimpampumMark.includes('assets/pimpampum-compact-white.svg') &&
    pimpampumMark.includes('assets/pimpampum-compact.svg') &&
    pimpampumMark.includes('root.useLightAsset') &&
    pimpampumMark.includes('contrastBackground.r'),
  'fixed mark must select an explicit high-contrast light or dark asset',
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
      'contentHeight: fittedContentHeight(Math.min(content.implicitHeight, Style.space(520)))',
    ) &&
    statusPopout.includes('clip: true') &&
    statusPopout.includes('boundsBehavior: Flickable.StopAtBounds'),
  'popout must remain native, bounded, clipped, and scrollable',
);
const popoutOrder = [
  'text: root.helpView ? "Help" : root.settingsView ? "Settings" : "Pimpampum"',
  'visible: !root.settingsView && root.service.connectionState !== "online"',
  'No workspaces. Run: pimpampum workspace:add',
  'text: "Active work ("',
  'text: "Projects ("',
  '+ "Completed ("',
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
    statusPopout.includes('id: helpAction') &&
    statusPopout.includes('Accessible.name: "Open synchronization and backup help"') &&
    statusPopout.includes('Accessible.name: root.helpView ? "Back to settings"') &&
    statusPopout.includes('id: helpPage') &&
    statusPopout.includes('pimpampum sync conflicts') &&
    statusPopout.includes('text: "Synchronization"') &&
    statusPopout.includes('text: "Backup"') &&
    !statusPopout.includes('syncExpanded') &&
    !statusPopout.includes('backupExpanded'),
  'synchronization and backup must live in one navigable settings view',
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
invariant(helper.includes('overview'), 'overview helper does not call the overview command');
invariant(
  !/(?:health|install|uninstall|work:|project:|task:)/u.test(helper),
  'overview helper is not read-only',
);
invariant(!/(?:bearer|token)/iu.test(helper), 'overview helper contains authentication material');

const backupHelper = read(join(pluginRoot, 'pimpampum-backup'));
for (const action of ['status', 'configure', 'retry', 'disable']) {
  invariant(backupHelper.includes(action), `backup helper omits ${action}`);
}
invariant(
  backupHelper.includes('backup "$@"'),
  'backup helper must preserve every caller argument boundary',
);
invariant(
  !/(?:bearer|token|eval\b|\bsh\s+-c|\bbash\s+-c)/iu.test(backupHelper),
  'backup helper contains credentials or shell evaluation',
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
