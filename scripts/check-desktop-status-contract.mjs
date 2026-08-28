import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const frozen = new Map([
  [
    'test/desktop-status.acceptance.test.ts',
    '328f53c2f0d20afdb62c355047ac0f529206057984ff810ceb961b9779257fba',
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
    '7050c4388a4c5fe7e931e9ac0caf5697501ef1d4558f84c53998b982d355a0dc',
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
