#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const ACTIONS = new Set([
  'checkpoint-partial',
  'attempt-claim',
  'release-handoff',
  'finish-and-complete',
  'claim-tested-checkpoint',
  'resume-and-complete',
]);
const INPUT_KEYS = new Set([
  'action',
  'agentId',
  'targetType',
  'targetId',
  'summary',
  'note',
  'cliPath',
  'repositoryPath',
]);
const GIT_ENVIRONMENT_KEYS = new Set([
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ATTR_NOSYSTEM',
  'GIT_CONFIG_GLOBAL',
  'GIT_TEMPLATE_DIR',
  'GIT_TERMINAL_PROMPT',
]);
const FINAL_IMPLEMENTATION = `export function calculateTotal(values) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array');
  return values.reduce((total, value) => total + value, 0);
}
`;
const PARTIAL_IMPLEMENTATION = `export function calculateTotal(values) {
  // synthetic checkpoint: intentionally incomplete
  return values.length === 0 ? 0 : values[0];
}
`;

function fail(message, cause) {
  const detail = cause instanceof Error ? `: ${cause.message}` : '';
  process.stderr.write(`${message}${detail}\n`);
  process.exit(1);
}

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value;
}

function parseScenario() {
  if (process.argv.length !== 3) fail('Expected exactly one JSON scenario argument');
  let decoded;
  try {
    decoded = JSON.parse(process.argv[2]);
  } catch (error) {
    fail('Scenario must be valid JSON', error);
  }
  const scenario = object(decoded, 'Scenario');
  for (const key of Object.keys(scenario)) {
    if (!INPUT_KEYS.has(key)) fail(`Unexpected scenario field: ${key}`);
  }
  const action = string(scenario.action, 'action');
  if (!ACTIONS.has(action)) fail(`Unsupported session action: ${action}`);
  const targetType = string(scenario.targetType, 'targetType');
  if (targetType !== 'spec' && targetType !== 'task') {
    fail('targetType must be spec or task');
  }
  const repositoryPath = string(scenario.repositoryPath, 'repositoryPath');
  const cliPath = string(scenario.cliPath, 'cliPath');
  if (!isAbsolute(repositoryPath) || !isAbsolute(cliPath)) {
    fail('repositoryPath and cliPath must be absolute');
  }
  if (!existsSync(repositoryPath) || !lstatSync(repositoryPath).isDirectory()) {
    fail('repositoryPath must be an existing directory');
  }
  if (!existsSync(cliPath) || !lstatSync(cliPath).isFile()) {
    fail('cliPath must be an existing file');
  }
  return {
    action,
    agentId: string(scenario.agentId, 'agentId'),
    targetType,
    targetId: string(scenario.targetId, 'targetId'),
    repositoryPath: realpathSync(repositoryPath),
    cliPath: realpathSync(cliPath),
    summary: typeof scenario.summary === 'string' ? scenario.summary : null,
    note: typeof scenario.note === 'string' ? scenario.note : null,
  };
}

function command(executable, arguments_, options = {}) {
  const result = spawnSync(executable, arguments_, {
    cwd: scenario.repositoryPath,
    env: process.env,
    encoding: 'utf8',
    input: options.input,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) fail(`${options.label ?? executable} could not run`, result.error);
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseJson(serialized, label) {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    fail(`${label} returned invalid JSON`, error);
  }
}

function callTool(name, input, expectedFailure = false) {
  const result = command(process.execPath, [scenario.cliPath, 'call', name, '--stdin'], {
    input: JSON.stringify(input),
    label: `Pimpampum tool ${name}`,
  });
  if (expectedFailure) {
    if (result.code === 0) fail(`Pimpampum tool ${name} unexpectedly succeeded`);
    const envelope = object(parseJson(result.stderr, `Pimpampum tool ${name}`), 'Error envelope');
    return { error: object(envelope.error, 'Error envelope.error') };
  }
  if (result.code !== 0) {
    fail(`Pimpampum tool ${name} failed (${String(result.code)}): ${result.stderr}`);
  }
  const envelope = object(parseJson(result.stdout, `Pimpampum tool ${name}`), 'Success envelope');
  return envelope.data;
}

function git(...arguments_) {
  const result = command('git', arguments_, { label: `git ${arguments_[0] ?? ''}` });
  if (result.code !== 0) {
    fail(`git ${arguments_.join(' ')} failed (${String(result.code)}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

function assertRepositoryBoundary() {
  const root = realpathSync(git('rev-parse', '--show-toplevel'));
  if (root !== scenario.repositoryPath) fail('Session repository does not match the Git root');
}

function assertContained(root, path, label) {
  const child = relative(root, path);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`)) {
    fail(`${label} must be a distinct child of the temporary session root`);
  }
  if (isAbsolute(child)) fail(`${label} escaped the temporary session root`);
}

function assertGitIsolation() {
  const inherited = Object.keys(process.env).filter(
    (name) => name.startsWith('GIT_') && !GIT_ENVIRONMENT_KEYS.has(name),
  );
  if (inherited.length > 0) fail(`Unexpected inherited Git environment: ${inherited.join(', ')}`);
  if (
    process.env.GIT_CONFIG_NOSYSTEM !== '1' ||
    process.env.GIT_ATTR_NOSYSTEM !== '1' ||
    process.env.GIT_TERMINAL_PROMPT !== '0'
  ) {
    fail('Git system configuration, attributes, and prompts must be disabled');
  }
  const temporaryRoot = dirname(scenario.repositoryPath);
  const globalConfig = realpathSync(string(process.env.GIT_CONFIG_GLOBAL, 'GIT_CONFIG_GLOBAL'));
  const templateDirectory = realpathSync(string(process.env.GIT_TEMPLATE_DIR, 'GIT_TEMPLATE_DIR'));
  if (!lstatSync(globalConfig).isFile()) fail('GIT_CONFIG_GLOBAL must be a regular file');
  if (!lstatSync(templateDirectory).isDirectory()) fail('GIT_TEMPLATE_DIR must be a directory');
  assertContained(temporaryRoot, globalConfig, 'GIT_CONFIG_GLOBAL');
  assertContained(temporaryRoot, templateDirectory, 'GIT_TEMPLATE_DIR');
}

function writeImplementation(contents) {
  writeFileSync(join(scenario.repositoryPath, 'src', 'calculateTotal.js'), contents, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function commit(message) {
  git('add', '--', 'src/calculateTotal.js');
  git('commit', '--quiet', '-m', message);
  const revision = git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/u.test(revision)) fail('Git returned an invalid commit hash');
  return revision;
}

function runTests() {
  const result = command(process.execPath, ['--test'], { label: 'synthetic repository tests' });
  if (result.code !== 0) {
    fail(`Synthetic repository tests failed (${String(result.code)}): ${result.stderr}`);
  }
  return { passed: true, output: `${result.stdout}${result.stderr}` };
}

function claim() {
  const bundle = object(
    callTool('work_start', {
      targetType: scenario.targetType,
      targetId: scenario.targetId,
      agentId: scenario.agentId,
      leaseSeconds: 1_800,
    }),
    'Work bundle',
  );
  const claimed = object(bundle.claim, 'Work bundle claim');
  if (
    claimed.targetType !== scenario.targetType ||
    claimed.targetId !== scenario.targetId ||
    claimed.agentId !== scenario.agentId
  ) {
    fail('Pimpampum returned a Claim for a different session or target');
  }
  return bundle;
}

function targetRevision(bundle) {
  const manifest = object(
    scenario.targetType === 'task' ? bundle.task : bundle.spec,
    `${scenario.targetType} manifest`,
  );
  if (!Number.isInteger(manifest.revision) || manifest.revision < 1) {
    fail('Claimed target returned an invalid revision');
  }
  return manifest.revision;
}

function complete(bundle, commitHash) {
  if (!scenario.summary) fail(`${scenario.action} requires a summary`);
  return object(
    callTool('work_complete', {
      targetType: scenario.targetType,
      targetId: scenario.targetId,
      agentId: scenario.agentId,
      expectedRevision: targetRevision(bundle),
      summary: scenario.summary,
      artifacts: [{ label: 'synthetic git commit', uri: `git:${commitHash}` }],
    }),
    'Completed target',
  );
}

const scenario = parseScenario();
assertGitIsolation();
assertRepositoryBoundary();

const evidence = {
  pid: process.pid,
  action: scenario.action,
  agentId: scenario.agentId,
  repositoryPath: scenario.repositoryPath,
};

if (scenario.action === 'attempt-claim') {
  const failure = callTool(
    'work_start',
    {
      targetType: scenario.targetType,
      targetId: scenario.targetId,
      agentId: scenario.agentId,
      leaseSeconds: 1_800,
    },
    true,
  );
  if (failure.error.code !== 'conflict') {
    fail(`Competing Claim returned ${String(failure.error.code)} instead of conflict`);
  }
  evidence.rejection = {
    code: failure.error.code,
    message: string(failure.error.message, 'Claim conflict message'),
  };
} else if (scenario.action === 'release-handoff') {
  if (!scenario.note) fail('release-handoff requires a note');
  const released = object(
    callTool('work_release', {
      targetType: scenario.targetType,
      targetId: scenario.targetId,
      agentId: scenario.agentId,
      note: scenario.note,
    }),
    'Release result',
  );
  if (released.released !== true) fail('Pimpampum did not acknowledge the Claim release');
  evidence.released = true;
} else if (scenario.action === 'checkpoint-partial') {
  const bundle = claim();
  writeImplementation(PARTIAL_IMPLEMENTATION);
  evidence.claim = bundle.claim;
  evidence.commit = commit('test: synthetic partial implementation checkpoint');
} else if (scenario.action === 'claim-tested-checkpoint') {
  const bundle = claim();
  writeImplementation(FINAL_IMPLEMENTATION);
  evidence.claim = bundle.claim;
  evidence.tests = runTests();
  evidence.commit = commit('test: synthetic tested implementation checkpoint');
} else if (scenario.action === 'finish-and-complete') {
  const bundle = claim();
  writeImplementation(FINAL_IMPLEMENTATION);
  evidence.claim = bundle.claim;
  evidence.tests = runTests();
  evidence.commit = commit('test: complete synthetic implementation');
  evidence.completion = complete(bundle, evidence.commit);
} else if (scenario.action === 'resume-and-complete') {
  const bundle = claim();
  evidence.claim = bundle.claim;
  evidence.tests = runTests();
  evidence.commit = git('rev-parse', 'HEAD');
  evidence.completion = complete(bundle, evidence.commit);
}

process.stdout.write(`${JSON.stringify(evidence)}\n`);
