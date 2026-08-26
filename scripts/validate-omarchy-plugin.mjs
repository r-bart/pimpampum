#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
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
  if (!isObject(value) || !isObject(value.meta) || value.meta.schemaVersion !== 1) return false;
  if (!isObject(value.data)) return false;
  const { data } = value;
  if (!['active', 'available', 'complete', 'draft', 'empty'].includes(data.status)) return false;
  if (!isObject(data.daemon) || typeof data.daemon.version !== 'string') return false;
  if (!Array.isArray(data.projects) || !Array.isArray(data.activeWork)) return false;
  if (data.projects.length > 500 || data.activeWork.length > 500) return false;
  if (!isObject(data.counts)) return false;
  const countFields = [
    'workspaces',
    'projects',
    'draftProjects',
    'readyProjects',
    'completedProjects',
    'openTasks',
    'completedTasks',
    'activeClaims',
    'availableWork',
  ];
  if (!countFields.every((field) => isCount(data.counts[field]))) return false;
  if (typeof data.projectsTruncated !== 'boolean') return false;
  if (typeof data.activeWorkTruncated !== 'boolean') return false;
  return data.projects.every(
    (project) =>
      isObject(project) &&
      isObject(project.workspace) &&
      typeof project.id === 'string' &&
      typeof project.title === 'string' &&
      typeof project.workspace.rootPath === 'string' &&
      isAbsolute(project.workspace.rootPath) &&
      ['active', 'available', 'draft', 'complete'].includes(project.status),
  );
}

const files = walk(pluginRoot);
const relativeFiles = new Set(files.map((path) => relative(pluginRoot, path)));
for (const expected of [
  '.pimpampum-plugin-owner.json',
  'BarWidget.qml',
  'OverviewService.qml',
  'StatusPopout.qml',
  'README.md',
  'install.sh',
  'manifest.json',
  'pimpampum-overview',
  'uninstall.sh',
]) {
  invariant(relativeFiles.has(expected), `missing plugin file: ${expected}`);
}

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

const qml = ['BarWidget.qml', 'OverviewService.qml', 'StatusPopout.qml']
  .map((name) => read(join(pluginRoot, name)))
  .join('\n');
const documentedBarMembers = new Set([
  'background',
  'barSize',
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
  'foreground',
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
  qml.includes('completedGreen') && qml.includes('effectiveStatus === "complete"'),
  'completed status must have a distinct green treatment',
);
invariant(
  !/(?:work_complete|work:start|work:release|project_update|task_update|\bPOST\b|\bPATCH\b|\bDELETE\b)/u.test(
    qml,
  ),
  'QML crosses the read-only boundary',
);

const helper = read(join(pluginRoot, 'pimpampum-overview'));
invariant(helper.includes('overview'), 'overview helper does not call the overview command');
invariant(
  !/(?:health|install|uninstall|work:|project:|task:)/u.test(helper),
  'overview helper is not read-only',
);
invariant(!/(?:bearer|token)/iu.test(helper), 'overview helper contains authentication material');

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
