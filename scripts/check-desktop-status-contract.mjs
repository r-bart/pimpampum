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
    'c4adbf635a04bc125c7bb897c1e8aafd8bff4ef9149df20b0dbba75b903a6a21',
  ],
  [
    'test/fixtures/overview/empty.json',
    '378cecf4b52ea3e1627908e34b788c5c637479153aea1b60a608636f09ea886f',
  ],
  [
    'test/fixtures/overview/invalid.json',
    '1dfd2aa7a4db5cffcdd9f07a8df477f6b7c35345eff4b8d94beef25850b6e00f',
  ],
  [
    'test/fixtures/overview/mixed.json',
    '8ebf307074059edc00d66f61d596f8f7dc5b1bb9d7e9db9da641339700c42ff4',
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
