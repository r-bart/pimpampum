import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Digests freeze the shared desktop-status overview fixtures. Update one only alongside its spec:
// the 2026-08-29 CLI envelope amendment in thoughts/specs/2026-08-25_desktop-status-integrations.md
// moved desktop-status.acceptance.test.ts and quattro-live-evidence.acceptance.test.ts.
//
// Amendment 2026-09-01 (thoughts/reviews/2026-09-01_deep-review.md, H-14): the hash pins stay on
// the four test/fixtures/overview/*.json files only. Those fixtures are a real three-consumer
// contract — scripts/validate-omarchy-plugin.mjs, the Swift tests through OverviewTestSupport.swift
// and the TypeScript acceptance tests all read the same bytes. The acceptance test files are no
// longer frozen: every one of the eight commits that touched this script re-pinned them, so the
// freeze recorded snapshots instead of a specification. Their spec-id comments remain the contract.
const frozen = new Map([
  [
    'test/fixtures/overview/complete.json',
    'a622e45665a33646afb10eeeea78b3f8ec7248cad176163d1c7f47870520ec5f',
  ],
  [
    'test/fixtures/overview/empty.json',
    'bbf834d7bd82369eb53ccebc3f90c0237342ebd2ab1f579a2047d25e343366eb',
  ],
  [
    'test/fixtures/overview/invalid.json',
    '1dfd2aa7a4db5cffcdd9f07a8df477f6b7c35345eff4b8d94beef25850b6e00f',
  ],
  [
    'test/fixtures/overview/mixed.json',
    '27fb33e9d3113c073d8e08aaa17b96d789d873d555630dfbcf6cfa99d3571453',
  ],
]);

const mismatches = [];
for (const [path, expected] of frozen) {
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== expected) mismatches.push(`${path}: expected ${expected}, received ${actual}`);
}

if (mismatches.length > 0) {
  throw new Error(`Frozen desktop-status contract changed:\n${mismatches.join('\n')}`);
}

console.log(`Verified ${frozen.size} frozen desktop-status contract artifacts.`);
