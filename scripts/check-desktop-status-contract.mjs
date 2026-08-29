import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Digests freeze the generated desktop-status acceptance artifacts. Update one only alongside
// its spec: the 2026-08-29 CLI envelope amendment in
// thoughts/specs/2026-08-25_desktop-status-integrations.md moved desktop-status.acceptance.test.ts
// and quattro-live-evidence.acceptance.test.ts.
const frozen = new Map([
  [
    'test/desktop-status.acceptance.test.ts',
    '79bca7ec61cd008763c3f574d1af35a7e4f48d946555814e6fa5cafd62305f5d',
  ],
  [
    'test/desktop-status.safety.acceptance.test.ts',
    'f7546615d8ffbb9f4911621f95ebb5e7433d52b71e291ef50a1dec7a88d08f91',
  ],
  [
    'test/desktop-status.lifecycle.acceptance.test.ts',
    '3fd3289e06b2651d9d0902a026900657c461db0ba780e6d566e21be5a785564d',
  ],
  [
    'test/quattro-live-evidence.acceptance.test.ts',
    '394382d4f5d75ad7744da1ca43ceb9981959200d537be5be119ffe7eaac134bf',
  ],
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
