#!/usr/bin/env node
// Regenerates every fixture that has a producer in the codebase, from that producer:
//
//   test/fixtures/setup/plan-envelope.json            <- `pimpampum setup plan` through runCli
//   test/fixtures/setup/empty-journal-envelope.json   <- `pimpampum setup status` through runCli
//   test/fixtures/overview/{empty,mixed,complete}.json <- real store served by createHttpApp
//   integrations/omarchy/pimpampum-status/fixtures/*  <- byte copies of the overview fixtures
//   scripts/check-desktop-status-contract.mjs         <- refreshed sha256 digests
//
// The producers import TypeScript sources, so run it through tsx:
//
//   npx tsx scripts/regenerate-fixtures.mjs
//
// `test/setup-envelope-shape.test.ts` and `test/overview-fixtures.test.ts` re-run the same
// producers and fail when a checked-in fixture differs, so a producer change must come with a
// regeneration and the corresponding spec amendment.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OVERVIEW_SCENARIOS, produceOverviewFixture } from '../test/fixtures/overview/produce.ts';
import {
  produceEmptyJournalEnvelope,
  producePlanEnvelope,
} from '../test/fixtures/setup/produce.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'pimpampum-regenerate-fixtures-'));
const written = [];

function write(relativePath, content) {
  const path = join(repositoryRoot, relativePath);
  const previous = (() => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  })();
  writeFileSync(path, content);
  written.push(`${previous === content ? 'unchanged' : 'updated  '} ${relativePath}`);
}

try {
  const plan = await producePlanEnvelope(join(scratch, 'plan'));
  write('test/fixtures/setup/plan-envelope.json', plan.normalized);
  const journal = await produceEmptyJournalEnvelope(join(scratch, 'status'));
  write('test/fixtures/setup/empty-journal-envelope.json', journal.normalized);

  const digests = new Map();
  for (const scenario of OVERVIEW_SCENARIOS) {
    const content = await produceOverviewFixture(scenario, join(scratch, scenario));
    write(`test/fixtures/overview/${scenario}.json`, content);
  }
  for (const name of ['complete', 'empty', 'invalid', 'mixed']) {
    const shared = join(repositoryRoot, 'test/fixtures/overview', `${name}.json`);
    copyFileSync(
      shared,
      join(repositoryRoot, 'integrations/omarchy/pimpampum-status/fixtures', `${name}.json`),
    );
    written.push(`copied    integrations/omarchy/pimpampum-status/fixtures/${name}.json`);
    digests.set(
      `test/fixtures/overview/${name}.json`,
      createHash('sha256').update(readFileSync(shared)).digest('hex'),
    );
  }

  const contractPath = 'scripts/check-desktop-status-contract.mjs';
  let contract = readFileSync(join(repositoryRoot, contractPath), 'utf8');
  for (const [file, digest] of digests) {
    const pattern = new RegExp(
      `(\\[\\s*'${file.replaceAll('/', '\\/').replaceAll('.', '\\.')}',\\s*')[0-9a-f]{64}(')`,
      'u',
    );
    if (!pattern.test(contract)) throw new Error(`No digest entry for ${file} in ${contractPath}`);
    contract = contract.replace(pattern, `$1${digest}$2`);
  }
  write(contractPath, contract);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`${written.join('\n')}\n`);
