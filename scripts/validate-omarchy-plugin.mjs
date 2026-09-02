#!/usr/bin/env node

// Validates an Omarchy Quattro plugin candidate: file inventory, manifest, the fixed compact mark,
// the QML safety and copy contract, the shell helpers, the lifecycle wrappers and the frozen
// fixtures. Every check names one condition, and a group of source fragments is checked one
// fragment at a time, so a failure says which line of the contract went missing and in which file.
//
//   validate-omarchy-plugin.mjs [pluginRoot]

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executableHelpers } from './check-omarchy-delivery.mjs';
import { check, isRecord } from './lib/checks.mjs';
import { walkTree } from './lib/hashTree.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryPluginRoot = join(repositoryRoot, 'integrations/omarchy/pimpampum-status');
const pluginRoot = realpathSync(resolve(process.argv[2] ?? repositoryPluginRoot));
const sharedFixtureRoot = join(repositoryRoot, 'test/fixtures/overview');
const pluginFixtureRoot = join(pluginRoot, 'fixtures');

// ---------------------------------------------------------------------------------------------
// Sources and named checks
// ---------------------------------------------------------------------------------------------

function read(path) {
  return readFileSync(path, 'utf8');
}

/** A plugin file as `{ name, text }`, so a failing check can name the file it read. */
function source(name) {
  return { name, text: read(join(pluginRoot, name)) };
}

function combined(name, ...sources) {
  return { name, text: sources.map((entry) => entry.text).join('\n') };
}

/** One check per fragment: the failure names the file and the fragment it lacks. */
function requireFragments(name, target, fragments, message) {
  for (const fragment of fragments) {
    check(
      name,
      target.text.includes(fragment),
      `${message} (${target.name} lacks ${JSON.stringify(fragment)})`,
    );
  }
}

/** One check per fragment: the failure names the file and the fragment it must not contain. */
function forbidFragments(name, target, fragments, message) {
  for (const fragment of fragments) {
    check(
      name,
      !target.text.includes(fragment),
      `${message} (${target.name} contains ${JSON.stringify(fragment)})`,
    );
  }
}

function requirePattern(name, target, pattern, message) {
  check(
    name,
    pattern.test(target.text),
    `${message} (${target.name} does not match ${String(pattern)})`,
  );
}

function forbidPattern(name, target, pattern, message) {
  check(name, !pattern.test(target.text), `${message} (${target.name} matches ${String(pattern)})`);
}

/** Only the double-quoted literals of a target: the copy a user reads, without the comments. */
function quotedCopy(target) {
  return {
    name: `the copy of ${target.name}`,
    text: (target.text.match(/"(?:[^"\\\n]|\\.)*"/gu) ?? []).join('\n'),
  };
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

function pluginFiles() {
  const files = [];
  walkTree(
    pluginRoot,
    { file: (path) => files.push(path) },
    {
      skipNames: ['.git'],
      unsafeEntry: (path, kind) =>
        new Error(
          kind === 'symlink'
            ? `symlink is not allowed: ${relative(pluginRoot, path)}`
            : `non-regular file is not allowed: ${relative(pluginRoot, path)}`,
        ),
    },
  );
  return files;
}

/**
 * Every QML component of the reviewed plugin and every executable helper of the delivery checker
 * must ship; a hand-kept list silently skipped four QML files and the shared shell library.
 */
function validateInventory(relativeFiles) {
  const qmlNames = readdirSync(repositoryPluginRoot)
    .filter((name) => name.endsWith('.qml'))
    .sort();
  check('qml-component-count', qmlNames.length >= 13, 'reviewed plugin lost QML components');
  for (const expected of [
    '.pimpampum-plugin-owner.json',
    'README.md',
    'assets/pimpampum-compact.svg',
    'manifest.json',
    'runtime-manifest.json',
    ...executableHelpers,
    ...qmlNames,
  ]) {
    check('plugin-file-present', relativeFiles.has(expected), `missing plugin file: ${expected}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Compact mark
// ---------------------------------------------------------------------------------------------

function validateCompactSVG(svg, label) {
  const mark = { name: label, text: svg };
  check(
    'compact-mark-size',
    svg.length >= 256 && svg.length <= 4096,
    `${label} has an invalid file size`,
  );
  requirePattern(
    'compact-mark-header',
    mark,
    /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg\b/u,
    `${label} is not a bounded standalone SVG`,
  );
  check(
    'compact-mark-footer',
    svg.trimEnd().endsWith('</svg>'),
    `${label} is not a bounded standalone SVG`,
  );
  requirePattern(
    'compact-mark-canvas',
    mark,
    /\bwidth="16"\s+height="16"\s+viewBox="0 0 16 16"/u,
    `${label} must use the canonical 16 by 16 canvas`,
  );
  requireFragments(
    'compact-mark-geometry',
    mark,
    [
      'fill="#000000" fill-rule="evenodd"',
      'd="M8 .5a7.5 7.5 0 1 1 0 15',
      'M4.8 3.9h1.4v.7',
      'M6.3 7.2c0-1.3',
    ],
    `${label} does not contain the canonical circle and lowercase-p outlines`,
  );
  forbidPattern(
    'compact-mark-local-geometry',
    mark,
    /(?:<script\b|<image\b|<text\b|<style\b|\bhref\s*=|\burl\s*\()/iu,
    `${label} must contain local outlined vector geometry only`,
  );
  const colors = [...svg.matchAll(/\bfill="([^"]+)"/gu)].map((match) => match[1]);
  check(
    'compact-mark-single-fill',
    colors.length === 1,
    `${label} must remain monochrome and theme-tintable`,
  );
  check(
    'compact-mark-black-fill',
    colors[0] === '#000000',
    `${label} must remain monochrome and theme-tintable`,
  );
}

/** Returns the canonical master SVG after proving the plugin ships an identical copy. */
function validateCompactMark() {
  const canonicalCompactMarkPath = join(
    repositoryRoot,
    'branding/assets/pimpampum-compact-master.svg',
  );
  check(
    'canonical-mark-present',
    existsSync(canonicalCompactMarkPath),
    'canonical compact-mark SVG is missing',
  );
  check(
    'canonical-mark-regular-file',
    lstatSync(canonicalCompactMarkPath).isFile(),
    'canonical compact-mark SVG must be a regular file',
  );
  const canonicalCompactMark = read(canonicalCompactMarkPath);
  const pluginCompactMark = read(join(pluginRoot, 'assets/pimpampum-compact.svg'));
  validateCompactSVG(canonicalCompactMark, 'canonical compact-mark SVG');
  validateCompactSVG(pluginCompactMark, 'plugin compact-mark SVG');
  check(
    'plugin-mark-matches-canonical',
    pluginCompactMark === canonicalCompactMark,
    'plugin compact-mark SVG differs from the reviewed canonical master',
  );
  return canonicalCompactMark;
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

function validateEntryPoint(entryPoint, relativeFiles) {
  check('entry-point-string', typeof entryPoint === 'string', 'entry point must be a string');
  check('entry-point-non-empty', entryPoint.length > 0, 'entry point must be a string');
  check('entry-point-relative', !isAbsolute(entryPoint), 'entry point is unsafe');
  check(
    'entry-point-no-parent-segment',
    !entryPoint.split(/[\\/]/u).includes('..'),
    'entry point is unsafe',
  );
  const resolved = resolve(pluginRoot, entryPoint);
  check(
    'entry-point-inside-plugin',
    resolved.startsWith(`${pluginRoot}${sep}`),
    'entry point escapes the plugin',
  );
  check(
    'entry-point-present',
    relativeFiles.has(relative(pluginRoot, resolved)),
    `missing entry point: ${entryPoint}`,
  );
}

function validateManifest(relativeFiles) {
  const manifest = JSON.parse(read(join(pluginRoot, 'manifest.json')));
  check('manifest-schema', manifest.schemaVersion === 1, 'manifest schemaVersion must be 1');
  check('manifest-id', manifest.id === 'dev.pimpampum.status', 'manifest id is incorrect');
  check('manifest-kinds-array', Array.isArray(manifest.kinds), 'manifest kinds must be bounded');
  check('manifest-kinds-count', manifest.kinds.length === 1, 'manifest kinds must be bounded');
  check('manifest-kind', manifest.kinds[0] === 'bar-widget', 'manifest must declare bar-widget');
  check(
    'manifest-bar-widget-entry',
    manifest.entryPoints?.barWidget === 'BarWidget.qml',
    'bar-widget entry point is incorrect',
  );
  check(
    'manifest-single-instance',
    manifest.barWidget?.allowMultiple === false,
    'allowMultiple must be false',
  );
  check(
    'manifest-default-section',
    manifest.barWidget?.defaultSection === 'right',
    'default section must be right',
  );
  for (const entryPoint of Object.values(manifest.entryPoints)) {
    validateEntryPoint(entryPoint, relativeFiles);
  }
}

// ---------------------------------------------------------------------------------------------
// QML: bar contract, popout copy and safety
// ---------------------------------------------------------------------------------------------

/**
 * A surface is the component that roots one screen plus every sibling component it instantiates,
 * transitively. A row names the surface it is about instead of a file, so the QML can be split or
 * merged inside a surface without editing this file, while moving a fragment to a different
 * surface still fails, which is what the row was written to catch. `root` is the rooting
 * component on its own, for the rows that are about that component's own layout rather than
 * about the content of the screen.
 */
function surfaceLoader(texts) {
  const componentNames = new Set(texts.keys());
  const referencedBy = (text) => {
    const found = new Set();
    for (const match of text.matchAll(/(?:^|[^.\w])([A-Z]\w*)\s*\{/gmu)) {
      if (componentNames.has(match[1])) found.add(match[1]);
    }
    return found;
  };
  return (rootName) => {
    const visited = [];
    const visit = (component) => {
      if (visited.includes(component)) return;
      visited.push(component);
      for (const reference of referencedBy(texts.get(component))) visit(reference);
    };
    visit(rootName);
    return {
      name: `the ${rootName} surface (${visited.join(', ')})`,
      root: { name: `${rootName}.qml`, text: texts.get(rootName) },
      text: visited.map((component) => texts.get(component)).join('\n'),
    };
  };
}

/**
 * Every `.qml` file of the candidate takes part in the safety sweeps; a fixed list once left four
 * components outside the bar-member, shell-interpolation, credential and read-only checks.
 */
function loadQml() {
  const names = readdirSync(pluginRoot)
    .filter((name) => name.endsWith('.qml'))
    .sort();
  const texts = new Map(
    names.map((name) => [name.slice(0, -'.qml'.length), read(join(pluginRoot, name))]),
  );
  const surface = surfaceLoader(texts);
  return {
    qml: { name: 'the plugin QML', text: [...texts.values()].join('\n') },
    popout: surface('StatusPopout'),
    portfolio: surface('PortfolioPage'),
    settings: surface('SettingsPage'),
    help: surface('HelpPage'),
    barWidget: source('BarWidget.qml'),
    updateService: source('UpdateService.qml'),
    agentConnectionService: source('AgentConnectionService.qml'),
    pimpampumActionArea: source('PimpampumActionArea.qml'),
    pimpampumMark: source('PimpampumMark.qml'),
    settingsButton: source('PimpampumSettingsButton.qml'),
    managedFolderCard: source('ManagedFolderCard.qml'),
    overviewService: source('OverviewService.qml'),
    serviceControl: source('ServiceControl.qml'),
    backupService: source('BackupService.qml'),
  };
}

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

function validateBarContract({ qml }) {
  for (const match of qml.text.matchAll(/(?:^|[^.\w])bar\.([A-Za-z_]\w*)/gmu)) {
    check(
      'documented-bar-member',
      documentedBarMembers.has(match[1]),
      `undocumented injected bar member: ${match[1]}`,
    );
  }
  requireFragments(
    'popout-request',
    qml,
    ['bar.requestPopout'],
    'native popout request is missing',
  );
  requireFragments(
    'popout-release',
    qml,
    ['bar.releasePopout'],
    'native popout release is missing',
  );
  for (const member of [
    'barForeground',
    'urgent',
    'fontFamily',
    'position',
    'vertical',
    'barSize',
  ]) {
    requireFragments(
      'inherited-bar-member',
      qml,
      [`bar.${member}`],
      `theme/bar member is not inherited: ${member}`,
    );
  }
}

function validatePopoutCopy({ popout, portfolio, overviewService }) {
  requireFragments(
    'popout-card-tokens',
    popout,
    ['Color.popups.text', 'Color.popups.background'],
    'popout content must use the popup card tokens, not the bar foreground resolved against the wallpaper',
  );
  const emptyStates =
    'empty states must teach: headline, explanation, and the absolute launcher command on its own surface';
  requireFragments(
    'empty-state-copy',
    portfolio,
    [
      '"Register a folder as a workspace to start tracking projects."',
      '"Projects appear here as your agents create them."',
    ],
    emptyStates,
  );
  // The command is composed from the launcher path the popout resolves and rendered as its own
  // Text; a literal `pimpampum` would name a command a native install does not have.
  requirePattern(
    'empty-state-copy',
    portfolio,
    /text: \w+\.controlLauncherPath \+ " workspace:add <id> <name> \/absolute\/folder"/u,
    emptyStates,
  );
  requireFragments(
    'empty-state-copy',
    popout,
    ['"/.local/share/pimpampum/bin/pimpampum-control"'],
    emptyStates,
  );
  forbidFragments('empty-state-copy', portfolio, ['text: "pimpampum workspace:add"'], emptyStates);
  // D-01: the first workspace is registered from the popout itself, through the same isolated
  // folder picker and the bounded route, so a native install never needs a terminal for it.
  requireFragments(
    'workspace-registration',
    popout,
    [
      'id: addWorkspaceAction',
      '? "Adding workspace…" : "Add a workspace"',
      'chooseDirectory("workspace")',
      'var arguments = [controlRoutePath, "workspace", "add"]',
      'arguments.push(path)',
      'Qt.resolvedUrl("pimpampum-control-route")',
      'Qt.callLater(function() { root.acceptWorkspaceRegistration(exitCode) })',
      'workspaceRegistrationError !== ""',
      'workspaceRegistrationNotice !== ""',
    ],
    'the empty popout must register a workspace through the folder picker and the bounded route',
  );
  const credentials =
    'rejected credentials must explain the mismatch and present the repair command separately';
  requireFragments(
    'credential-copy',
    portfolio,
    ['text: "Authentication required"', 'text: "pimpampum install"'],
    credentials,
  );
  requireFragments(
    'credential-copy',
    overviewService,
    ['"The saved credentials no longer match the local daemon."'],
    credentials,
  );
}

function validateHelperLaunch({ qml, backupService, popout, settings }) {
  requireFragments(
    'overview-helper-command',
    qml,
    ['command: [root.helperPath]'],
    'overview helper must be launched as one absolute command',
  );
  requireFragments(
    'polling-intervals',
    qml,
    ['interval: root.popoutOpen ? 5000 : 10000'],
    'polling intervals are incorrect',
  );
  requireFragments(
    'xdg-open-argument',
    qml,
    ['var arguments = ["xdg-open", path]'],
    'xdg-open must receive one path argument',
  );
  const picker = 'isolated folder picker is missing or unsafe in-process dialog is present';
  requireFragments('folder-picker', qml, ['pimpampum-folder-picker'], picker);
  forbidFragments('folder-picker', qml, ['QtQuick.Dialogs'], picker);
  const pickerFailure =
    'folder picker failure must direct users to the bounded CLI without a duplicate path form';
  requireFragments(
    'folder-picker-failure',
    qml,
    ['Folder picker unavailable. Configure'],
    pickerFailure,
  );
  forbidFragments('folder-picker-failure', qml, ['Enter path manually'], pickerFailure);
  requireFragments(
    'backup-helper-command',
    qml,
    ['command: [root.helperPath, "status"]'],
    'backup helper command is missing',
  );
  requireFragments(
    'backup-helper-arguments',
    qml,
    ['var arguments = [helperPath, operation]', 'arguments.push(path)'],
    'backup helper must receive the directory as a separate process argument',
  );
  // M-C6: a corrupt settings file makes the daemon answer `enabled: false, state: "error"` with a
  // message and no destination. The reader accepts exactly that third shape and the card renders
  // the message under "Backup needs attention".
  const unreadableSettings =
    'the backup reader must accept the unreadable-settings shape and the card must show its message';
  requireFragments(
    'backup-unreadable-settings',
    backupService,
    [
      'if (value.state === "disabled") return value.error === null',
      'return value.state === "error" && value.error !== null',
      'if (value.snapshotPath !== null) return false',
      'value.error.length > 500',
    ],
    unreadableSettings,
  );
  forbidFragments(
    'backup-unreadable-settings',
    backupService,
    ['value.state !== "disabled" || value.snapshotPath !== null'],
    unreadableSettings,
  );
  requireFragments(
    'backup-unreadable-settings',
    popout,
    [
      'vocabulary.backupStateLabels[backupService.backupState]',
      '"error": "Backup needs attention"',
    ],
    unreadableSettings,
  );
  requireFragments(
    'backup-unreadable-settings',
    settings,
    [
      'root.backupService.operationError !== "" ? root.backupService.operationError : root.backupService.statusError',
      'text: root.errorText',
    ],
    unreadableSettings,
  );
}

function validateQmlSafety({ qml }) {
  forbidPattern(
    'no-shell-interpolation',
    qml,
    /(?:sh\s+-c|bash\s+-c|shellQuote|\+\s*(?:directory|path))/u,
    'QML must not interpolate paths into shell commands',
  );
  requireFragments(
    'completed-disclosure',
    qml,
    ['Completed'],
    'completed-project disclosure is missing',
  );
  forbidPattern(
    'no-credentials',
    qml,
    /(?:PIMPAMPUM_TOKEN|Authorization\s*:|Bearer\s+[A-Za-z0-9._~-]{8,})/u,
    'QML must not contain credential values',
  );
  requireFragments(
    'credential-rejection',
    qml,
    ['fail("credentials"', 'text: "pimpampum install"'],
    'credential rejection must remain distinct and actionable',
  );
  forbidPattern(
    'read-only-boundary',
    qml,
    /(?:work_complete|work:start|work:release|project_update|task_update|\bPOST\b|\bPATCH\b|\bDELETE\b)/u,
    'QML crosses the project-domain read-only boundary',
  );
}

// ---------------------------------------------------------------------------------------------
// QML: the fixed mark
// ---------------------------------------------------------------------------------------------

function validateMark({ qml, barWidget, pimpampumMark }, canonicalCompactMark) {
  const green = 'completed status must have a distinct green treatment';
  requireFragments('completed-green', qml, ['completedGreen'], green);
  requireFragments(
    'completed-green',
    pimpampumMark,
    ['status === "complete" ? completeColor'],
    green,
  );
  const fixedMark =
    'bar widget must use the fixed Pimpampum mark instead of status identity glyphs';
  requireFragments('fixed-mark', barWidget, ['PimpampumMark {'], fixedMark);
  forbidFragments('fixed-mark', barWidget, ['statusIcon'], fixedMark);
  const fill =
    'fixed mark must fill from the bar foreground, never picked from the theme background ' +
    'and never tinted through a layer, whose cached texture keeps the first color';
  requireFragments(
    'mark-fill',
    pimpampumMark,
    ['fillColor: root.foreground', 'fillRule: ShapePath.OddEvenFill'],
    fill,
  );
  forbidFragments('mark-fill', pimpampumMark, ['contrastBackground', 'MultiEffect {'], fill);
  // The mark is drawn from the reviewed master's own path data, so the identity cannot drift
  // between the canonical SVG and what the bar actually paints.
  const canonicalMarkPath = /\sd="([^"]+)"/u.exec(canonicalCompactMark)?.[1];
  check(
    'canonical-mark-path-data',
    typeof canonicalMarkPath === 'string' && canonicalMarkPath.length > 0,
    'canonical compact-mark SVG has no path data',
  );
  requireFragments(
    'mark-path-matches-master',
    pimpampumMark,
    [`path: "${canonicalMarkPath}"`],
    'fixed mark path must match the canonical master SVG exactly',
  );
  const badge = 'status must use an external badge without replacing product identity';
  requireFragments('external-badge', pimpampumMark, ['id: badge', 'badgeKind'], badge);
  forbidPattern(
    'external-badge',
    combined('BarWidget.qml + PimpampumMark.qml', barWidget, pimpampumMark),
    /["'](?:×|!|✓|wifi\.slash)["']/u,
    badge,
  );
  requireFragments(
    'active-count',
    pimpampumMark,
    [
      'Math.max(0, activeClaims)',
      'safeActiveClaims >= 100 ? "99+" : String(safeActiveClaims)',
      'visible: root.showActiveCount && root.safeActiveClaims > 0',
      'visible: !root.showActiveCount || root.safeActiveClaims === 0',
    ],
    'active-claim count must clamp negatives, hide zero, and cap three digits at 99+',
  );
  const accents = 'indicator must use semantic accents and distinct external status shapes';
  requireFragments(
    'semantic-accents',
    barWidget,
    ['activeBlue: "#3b82f6"', 'availableAmber: "#f59e0b"', 'completedGreen: "#22c55e"'],
    accents,
  );
  requireFragments(
    'semantic-accents',
    pimpampumMark,
    [
      'status === "active" ? activeColor',
      'status === "available" ? availableColor',
      'status === "complete" ? completeColor',
      '"active": "dot"',
      '"available": "bar"',
      '"complete": "square"',
      '"cancelled": "ring"',
      '"offline": "diamond"',
    ],
    accents,
  );
  requireFragments(
    'mark-layouts',
    pimpampumMark,
    ['columns: root.vertical ? 1 : 2', 'rows: root.vertical ? 2 : 1'],
    'mark and count must switch between horizontal and vertical bar layouts',
  );
  const accessible = 'mark and count must expose one combined accessible label';
  requireFragments(
    'accessible-label',
    pimpampumMark,
    ['statusLabel + " · " + claimLabel'],
    accessible,
  );
  requireFragments(
    'accessible-label',
    barWidget,
    ['Accessible.name: indicator.accessibleLabel', 'Accessible.onPressAction: root.togglePanel()'],
    accessible,
  );
}

// ---------------------------------------------------------------------------------------------
// QML: popout layout, navigation and controls
// ---------------------------------------------------------------------------------------------

/**
 * The portfolio sections are one column, so their order is a property of the component that lays
 * them out and the check reads that component's own body. Settings now live on a separate page,
 * so instead of following the settings controls down the same column, the check proves they are
 * absent from the portfolio surface.
 */
function validatePopoutOrder(portfolio) {
  const message =
    'the portfolio must keep its section order and leave the dedicated settings controls out';
  const fragments = [
    '&& root.service.connectionState !== "credentials"',
    '? "No workspaces" : "No projects"',
    'text: "Active work ("',
    'text: "Specs in progress ("',
    'text: "Projects ("',
    'title: "Completed specs ("',
    'title: "Cancelled ("',
  ];
  requireFragments('popout-order', portfolio.root, fragments, message);
  const positions = fragments.map((fragment) => portfolio.root.text.indexOf(fragment));
  for (let index = 1; index < fragments.length; index += 1) {
    check(
      'popout-order',
      positions[index] > positions[index - 1],
      `${message} (${JSON.stringify(fragments[index])} appears before ${JSON.stringify(fragments[index - 1])})`,
    );
  }
  forbidFragments(
    'popout-order',
    portfolio,
    ['title: "Synchronization"', 'title: "Backup"'],
    message,
  );
}

/** The popup card, the header that navigates it, and the footer that ends it. */
function validatePopoutChrome({ popout, settings, help }) {
  requireFragments(
    'popout-bounded',
    popout.root,
    [
      'PopupCard {',
      'contentWidth: fittedContentWidth(Style.space(380))',
      'contentHeight: fittedContentHeight(Math.min(content.implicitHeight + Style.space(53), Style.space(520)))',
      'clip: true',
      'boundsBehavior: Flickable.StopAtBounds',
    ],
    'popout must remain native, bounded, clipped, and scrollable',
  );
  const settingsView = 'synchronization and backup must live in one navigable settings view';
  requireFragments(
    'settings-view',
    popout,
    [
      'PimpampumHeaderIcon {',
      'back: root.settingsView',
      'width: Style.space(44)',
      'property bool helpView: false',
      'id: footerHelpAction',
      'Accessible.name: "Open help"',
      'Accessible.name: root.helpView ? "Back to portfolio"',
      'id: helpPage',
    ],
    settingsView,
  );
  requireFragments(
    'settings-view',
    settings,
    ['title: "Synchronization"', 'title: "Backup"'],
    settingsView,
  );
  requireFragments('settings-view', help, ['pimpampum sync conflicts'], settingsView);
  forbidFragments(
    'settings-view',
    popout,
    ['id: helpAction', 'syncExpanded', 'backupExpanded'],
    settingsView,
  );
  const footer = 'popover footer must expose accessible Help and Quit/Start actions';
  requireFragments(
    'popover-footer',
    popout,
    [
      'id: footer',
      'text: root.serviceControl.running ? "Quit" : "Start"',
      'Accessible.name: root.serviceControl.running ? "Quit Pimpampum" : "Start Pimpampum"',
      'anchors.bottom: footerSeparator.top',
      'anchors.bottom: parent.bottom',
      'height: Style.space(52)',
      'height: Style.space(44)',
    ],
    footer,
  );
  // The side each footer action takes is bound to its own id: a bare `anchors.left: parent.left`
  // is satisfied by any component of the surface, and every row of the popout has one.
  requirePattern(
    'popover-footer',
    popout,
    /id: footerHelpAction[\s\S]{0,300}?anchors\.left: parent\.left/u,
    footer,
  );
  requirePattern(
    'popover-footer',
    popout,
    /id: quitAction[\s\S]{0,300}?anchors\.right: parent\.right/u,
    footer,
  );
  forbidFragments('popover-footer', popout, ['id: footerSettingsAction'], footer);
}

/** What the pages say, and how they behave when a name or a path is longer than its row. */
function validatePopoutContent({ portfolio, help, managedFolderCard }) {
  requireFragments(
    'help-copy',
    help,
    [
      'Active work names the task being claimed now',
      'Specs in progress remain visible even when no task is claimed',
      'Completed Specs stay collapsed',
      'registered project and workspace names',
    ],
    'help must explain work names and the in-progress/completed Spec hierarchy',
  );
  const elision =
    'popout must elide long content while preserving workspace and slug disambiguation';
  requireFragments(
    'long-content-elision',
    portfolio,
    ['elide: Text.ElideRight', 'modelData.workspace.name + " / " + modelData.slug'],
    elision,
  );
  // The configured folder elides in the middle, so its first and last segments both stay legible.
  requirePattern(
    'long-content-elision',
    managedFolderCard,
    /elide: Text\.ElideMiddle[\s\S]{0,200}?text: root\.directory/u,
    elision,
  );
}

/** Every row, disclosure and action a user can reach with the mouse, the keyboard or a reader. */
function validateInteractiveControls({ popout, portfolio, settings, pimpampumActionArea }) {
  // The rows, disclosures and settings actions are components now, so the check names the action
  // area each component carries and the page bindings that put it where an inline id used to be.
  for (const [surface, control] of [
    [portfolio, 'id: rowAction'],
    [portfolio, 'id: disclosureAction'],
    [portfolio, 'delegate: PortfolioRow {'],
    [portfolio, 'expanded: controller.completedExpanded'],
    [portfolio, 'onToggled: controller.toggleCompleted()'],
    [portfolio, 'expanded: controller.cancelledExpanded'],
    [portfolio, 'onToggled: controller.toggleCancelled()'],
    [settings, 'id: primaryAction'],
    [settings, 'id: secondaryAction'],
    [settings, 'id: servicePrimaryAction'],
    [settings, 'id: serviceSecondaryAction'],
    [popout.root, 'id: headerActionArea'],
  ]) {
    requireFragments('interactive-control', surface, [control], 'missing interactive control');
  }
  const interaction =
    'interactive rows, disclosures, and actions need hover, focus, keyboard, and accessibility';
  check(
    'action-area-count',
    (popout.text.match(/PimpampumActionArea\s*\{/gu) ?? []).length >= 6,
    `${interaction} (the StatusPopout surface declares fewer than 6 PimpampumActionArea instances)`,
  );
  requireFragments(
    'action-area-behaviour',
    pimpampumActionArea,
    [
      'hoverEnabled: true',
      'activeFocusOnTab: focusOnTab',
      'Keys.onPressed:',
      'Accessible.onPressAction: root.triggered()',
      'if (root.triggerOnClick) root.triggered()',
    ],
    interaction,
  );
  requireFragments(
    'action-area-behaviour',
    popout,
    ['containsMouse ? 0.07 : 0', 'Accessible.name:'],
    interaction,
  );
}

/** What the popout remembers between page switches, and what it refuses while an action runs. */
function validateDisclosureState({ popout, settings, settingsButton }) {
  const disclosures =
    'project disclosures must start collapsed and settings controls must serialize while busy';
  requireFragments(
    'disclosures-and-settings-controls',
    popout,
    [
      'property bool completedExpanded: false',
      'property bool cancelledExpanded: false',
      'sourceComponent: !root.settingsView ? portfolioPage',
      'readonly property color accent: Color.accent',
    ],
    disclosures,
  );
  requireFragments(
    'disclosures-and-settings-controls',
    settings,
    [
      'busy: root.syncService.busy',
      'busy: root.backupService.busy',
      'actionEnabled: !root.busy',
      'parent.width - secondaryAction.width',
      'parent.width - serviceSecondaryAction.width',
    ],
    disclosures,
  );
  requireFragments(
    'disclosures-and-settings-controls',
    settingsButton,
    [
      'implicitHeight: Style.space(44)',
      'Style.selectedFillFor(root.foreground, root.accent, root.urgent)',
      'Accessible.name: root.label',
      'property color accent: Color.accent',
    ],
    disclosures,
  );
}

function validatePopoutLayout(qml) {
  validatePopoutChrome(qml);
  validatePopoutOrder(qml.portfolio);
  validatePopoutContent(qml);
  validateInteractiveControls(qml);
  validateDisclosureState(qml);
}

function validateServiceControls(
  { barWidget, portfolio, settings, serviceControl },
  serviceHelper,
) {
  requireFragments(
    'bar-widget-keyboard',
    barWidget,
    [
      'activeFocusOnTab: true',
      'Keys.onReturnPressed: root.togglePanel()',
      'Keys.onSpacePressed: root.togglePanel()',
    ],
    'the compact bar widget must be keyboard focusable and activatable',
  );
  const services =
    'service controls must remain bounded, recoverable, and independent from the daemon';
  requireFragments('service-controls', barWidget, ['ServiceControl {'], services);
  requireFragments(
    'service-controls',
    settings,
    ['text: "Pimpampum service"', '"Stop Pimpampum…"', '"Start Pimpampum"'],
    services,
  );
  requireFragments(
    'service-controls',
    serviceControl,
    ['serviceProcess.command = [helperPath, operation]'],
    services,
  );
  requireFragments(
    'service-controls',
    serviceHelper,
    ['/usr/bin/systemctl --user "$1" pimpampum.service'],
    services,
  );
  forbidPattern(
    'service-controls',
    serviceHelper,
    /(?:eval\b|sh\s+-c|bash\s+-c|bearer|token)/iu,
    services,
  );
  const cancelled = 'cancelled projects must remain distinct from successful completion';
  requireFragments(
    'cancelled-distinct',
    barWidget,
    [
      'displayStatus: service.effectiveStatus === "complete" && hasCancellations',
      '"cancelled": "Finished with cancellations"',
    ],
    cancelled,
  );
  requireFragments(
    'cancelled-distinct',
    portfolio,
    ['return project.lifecycleState === "done"', 'return project.lifecycleState === "cancelled"'],
    cancelled,
  );
}

function validateServices({
  agentConnectionService,
  updateService,
  serviceControl,
  popout,
  settings,
}) {
  requireFragments(
    'connection-service-errors',
    agentConnectionService,
    [
      '/^[a-z_]{1,40}$/.test(value)',
      'value.length > 200',
      'if (cliCode === "unavailable")',
      '/not installed/i.test(message)',
      'envelope.code === "command_failed"',
    ],
    'the connection service must render the forwarded CLI code like the other actionable errors',
  );
  requireFragments(
    'update-reader-envelope',
    updateService,
    ['isObject(envelope) && isObject(envelope.data) ? envelope.data : envelope'],
    'the update reader must accept both the bare payload and the {data} envelope',
  );
  // The Linux `update` verb refuses with a typed `unavailable` whose `details.remedy` names the
  // bootstrap helper of this plugin. The panel renders the message and that remedy as a command
  // resolved against the plugin directory, instead of a generic failure.
  const remedy =
    'the Updates card must render the typed remedy of a refused Linux update as a command';
  requireFragments(
    'update-remedy',
    updateService,
    [
      'property string remedy: ""',
      'function actionableRemedy(stream)',
      'envelope.error.code !== "unavailable"',
      '/^pimpampum-[a-z]{1,40}$/.test(remedy)',
      'root.remedy = root.actionableRemedy(root.processError)',
    ],
    remedy,
  );
  requireFragments(
    'update-remedy',
    settings,
    [
      'visible: root.updateService.remedy !== ""',
      'pluginDirectory + "/" + root.updateService.remedy',
    ],
    remedy,
  );
  requireFragments(
    'service-control-deferred-read',
    serviceControl,
    ['Qt.callLater(function() { root.accept(exitCode) })'],
    'service control must read collected stdout on a deferred turn like the sibling services',
  );
  // Only the quoted literals: a generated component carries `npm run generate:…` in a comment,
  // and no reader of the popout ever sees it.
  forbidPattern(
    'popout-no-npm',
    quotedCopy(popout),
    /\bnpm\b/u,
    'popout copy must not name npm; Omarchy uses the packaged provider',
  );
}

// ---------------------------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------------------------

function validateOverviewHelper(helper, controlRoute) {
  const route = 'overview helper does not call the bounded overview route';
  requireFragments('overview-route', helper, ['pimpampum-control-route'], route);
  requireFragments('overview-route', controlRoute, ['set -- overview'], route);
  const both = combined('pimpampum-overview + pimpampum-control-route', helper, controlRoute);
  forbidPattern(
    'overview-read-only',
    both,
    /(?:health|uninstall|work:|project:|task:)/u,
    'overview helper is not read-only',
  );
  forbidPattern(
    'overview-no-credentials',
    both,
    /(?:bearer|token)/iu,
    'overview helper contains authentication material',
  );
}

function validateBackupHelper(backupHelper, controlRoute) {
  for (const action of ['status', 'configure', 'retry', 'disable']) {
    requireFragments('backup-action', controlRoute, [action], `backup helper omits ${action}`);
  }
  // `workspace add DIRECTORY [NAME]` is the one project-domain write the popout may route, and it
  // is closed: the directory must be absolute and free of control characters, the name bounded,
  // and the id derived by the CLI's slug rule before `workspace:add ID NAME DIRECTORY` runs.
  requireFragments(
    'workspace-route',
    controlRoute,
    [
      '  workspace)',
      '[ "$action" = add ] || fail 69 \'invalid workspace action\'',
      "*) fail 69 'workspace directory must be an absolute path' ;;",
      "*[[:cntrl:]]*) fail 69 'workspace directory contains control characters' ;;",
      '[ "${#workspace_root}" -le 4096 ]',
      '[ "${#workspace_name}" -le 120 ]',
      "/usr/bin/sed -E 's/[^a-z0-9]+/-/g; s/^-+//'",
      '/usr/bin/cut -c1-80',
      'set -- workspace:add "$workspace_id" "$workspace_name" "$workspace_root"',
    ],
    'the control route must expose exactly one bounded workspace registration verb',
  );
  const boundary = 'backup helper must preserve every caller argument boundary';
  requireFragments('backup-route', backupHelper, ['pimpampum-control-route'], boundary);
  requireFragments('backup-route', controlRoute, ['set -- backup "$@"'], boundary);
  forbidPattern(
    'backup-no-shell-evaluation',
    combined('pimpampum-backup + pimpampum-control-route', backupHelper, controlRoute),
    /(?:bearer|token|eval\b|\bsh\s+-c|\bbash\s+-c)/iu,
    'backup helper contains credentials or shell evaluation',
  );
}

function validateSharedLibrary(common, controlRoute) {
  const launcher = 'surface helpers must use only the receipt-owned hash-verified control launcher';
  requireFragments(
    'control-launcher',
    common,
    [
      'runtime-install-receipt.json',
      'controlLauncherSha256',
      'verify_control_launcher()',
      'validate_home()',
    ],
    launcher,
  );
  requireFragments(
    'control-launcher',
    controlRoute,
    ['verify_control_launcher 69', 'exec "$control_launcher" "$@"'],
    launcher,
  );
  forbidPattern(
    'control-launcher',
    combined('pimpampum-control-route + pimpampum-common.sh', controlRoute, common),
    /(?:command\s+-v|\/\.local\/bin\/pimpampum|\bnpm\b|\bnpx\b)/u,
    launcher,
  );
  const home =
    'the shared helper library must reject quotes, backslashes and control characters in HOME';
  forbidPattern(
    'shared-library-home',
    common,
    /(?:bearer|token|eval\b|\bsh\s+-c|\bbash\s+-c|\bhostname\b)/iu,
    home,
  );
  requireFragments(
    'shared-library-home',
    common,
    ['*"\'"* | *\'"\'* | *\\\\*)', '*[[:cntrl:]]*)'],
    home,
  );
  for (const sourcingHelper of [
    'pimpampum-bootstrap',
    'pimpampum-connections',
    'pimpampum-control-route',
    'pimpampum-plugin-lifecycle',
  ]) {
    requireFragments(
      'helper-sources-library',
      source(sourcingHelper),
      ['. "$plugin_root/pimpampum-common.sh"', 'validate_home '],
      `${sourcingHelper} must source the shared library by absolute path and validate HOME through it`,
    );
  }
}

function validateConnectionsHelper(connectionsHelper) {
  const message =
    'the connections helper must not cap file sizes and must forward the bounded CLI error code and message';
  forbidPattern('connections-helper', connectionsHelper, /\bulimit\b/u, message);
  requireFragments(
    'connections-helper',
    connectionsHelper,
    ['-le 65536', '"cliCode":%s,"message":%s', "'^[a-z_]{1,40}$'", '/usr/bin/cut -c1-200'],
    message,
  );
}

function validateHelpers() {
  const controlRoute = source('pimpampum-control-route');
  validateOverviewHelper(source('pimpampum-overview'), controlRoute);
  validateBackupHelper(source('pimpampum-backup'), controlRoute);
  validateSharedLibrary(source('pimpampum-common.sh'), controlRoute);
  validateConnectionsHelper(source('pimpampum-connections'));
}

// ---------------------------------------------------------------------------------------------
// Lifecycle wrappers and fixtures
// ---------------------------------------------------------------------------------------------

function validateLifecycleWrappers() {
  for (const scriptName of ['install.sh', 'uninstall.sh']) {
    const script = source(scriptName);
    forbidFragments(
      'wrapper-no-shell-json',
      script,
      ['shell.json'],
      `${scriptName} must not access shell.json`,
    );
    forbidPattern(
      'wrapper-no-symlinks',
      script,
      /\bln\b/u,
      `${scriptName} must not create symlinks`,
    );
    forbidPattern(
      'wrapper-no-omarchy-lifecycle',
      script,
      /(?:omarchy\s+plugin|omarchy-shell\s+shell)/u,
      `${scriptName} must not own Omarchy lifecycle`,
    );
    forbidPattern(
      'wrapper-no-file-mutation',
      script,
      /\b(?:cp|mv|rm|mkdir|mktemp)\b/u,
      `${scriptName} must not mutate plugin files directly`,
    );
  }
  requireFragments(
    'install-wrapper-delegates',
    source('install.sh'),
    ['exec "$pimpampum_cli" install'],
    'install wrapper must delegate to the Pimpampum lifecycle',
  );
  requireFragments(
    'uninstall-wrapper-delegates',
    source('uninstall.sh'),
    ['exec "$pimpampum_cli" uninstall'],
    'uninstall wrapper must delegate to the Pimpampum lifecycle',
  );
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** The overview envelope shape the plugin's fixtures must satisfy (and `invalid.json` must not). */
function validEnvelope(value) {
  if (!isRecord(value) || !isRecord(value.meta) || value.meta.schemaVersion !== 2) return false;
  if (!isRecord(value.data)) return false;
  const { data } = value;
  if (!['active', 'available', 'complete', 'draft', 'paused', 'empty'].includes(data.status)) {
    return false;
  }
  if (!isRecord(data.daemon) || typeof data.daemon.version !== 'string') return false;
  if (!Array.isArray(data.projects) || !Array.isArray(data.activeWork)) return false;
  if (data.projects.length > 500 || data.activeWork.length > 500) return false;
  if (!isRecord(data.counts)) return false;
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
  return data.projects.every(validProject) && data.activeWork.every(validWork);
}

function validProject(project) {
  return (
    isRecord(project) &&
    isRecord(project.workspace) &&
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
    ].every((field) => isCount(project[field]))
  );
}

function validWork(work) {
  return (
    isRecord(work) &&
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
      : typeof work.taskId === 'string' && typeof work.taskTitle === 'string')
  );
}

function validateFixtures() {
  for (const fixtureName of ['empty.json', 'mixed.json', 'complete.json', 'invalid.json']) {
    const shared = read(join(sharedFixtureRoot, fixtureName));
    const candidate = read(join(pluginFixtureRoot, fixtureName));
    check(
      'fixture-frozen',
      candidate === shared,
      `plugin fixture differs from frozen shared fixture: ${fixtureName}`,
    );
    check(
      'fixture-validity',
      validEnvelope(JSON.parse(candidate)) === (fixtureName !== 'invalid.json'),
      `fixture validity expectation failed: ${fixtureName}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

function main() {
  const relativeFiles = new Set(pluginFiles().map((path) => relative(pluginRoot, path)));
  validateInventory(relativeFiles);
  const canonicalCompactMark = validateCompactMark();
  validateManifest(relativeFiles);

  const qml = loadQml();
  validateBarContract(qml);
  validatePopoutCopy(qml);
  validateHelperLaunch(qml);
  validateQmlSafety(qml);
  validateMark(qml, canonicalCompactMark);
  validatePopoutLayout(qml);
  validateServiceControls(qml, source('pimpampum-service'));
  validateServices(qml);

  validateHelpers();
  validateLifecycleWrappers();
  validateFixtures();

  process.stdout.write(`Validated Omarchy plugin: ${pluginRoot}\n`);
}

main();
