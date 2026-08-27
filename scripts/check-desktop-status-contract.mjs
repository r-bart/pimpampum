import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const frozen = new Map([
  [
    'test/desktop-status.acceptance.test.ts',
    '0ebbbde0d26e17951dedaea3345b55b7f2852250aac52223fbf93a7616b6b8a1',
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
    '1411ccc02c768ec0c67972d3d59d7750a79ed04470c39877643133c1d320e8e8',
  ],
  [
    'test/fixtures/overview/complete.json',
    'd577a304a26269eb7be4c480159a06290b4ba763befa04e8bb03761f45ebaade',
  ],
  [
    'test/fixtures/overview/empty.json',
    'ae6022769c756946be2304ddc678bedffc4ca1e657e7abec5abe07221b9f7d33',
  ],
  [
    'test/fixtures/overview/invalid.json',
    '1dfd2aa7a4db5cffcdd9f07a8df477f6b7c35345eff4b8d94beef25850b6e00f',
  ],
  [
    'test/fixtures/overview/mixed.json',
    'ad560079b063e78df957a28758a7b86f8c59fc0d7f331b6763283cd95c1a47c8',
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
