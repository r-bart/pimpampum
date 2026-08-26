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
    '50040208e18e5e99d0247b40a20aedbd42d9cf62fe2fd6f808ef74fcbf80735a',
  ],
  [
    'test/quattro-live-evidence.acceptance.test.ts',
    'd72acd89f9699621ccc788bdfee11f4cc03b7473f4c1858fc921bc37ba7b3bcc',
  ],
  [
    'test/fixtures/overview/complete.json',
    'f4769337822cbee1f80f332e6fd27911822d68f6cd829dbacb429eb1d2ce47c1',
  ],
  [
    'test/fixtures/overview/empty.json',
    'b4d8d773ad7c3ffedb6807b2cae888b0e8d25f2eeca06dbcb2c75cca8115d66c',
  ],
  [
    'test/fixtures/overview/invalid.json',
    '1dfd2aa7a4db5cffcdd9f07a8df477f6b7c35345eff4b8d94beef25850b6e00f',
  ],
  [
    'test/fixtures/overview/mixed.json',
    '62ce2eaf98cd34ced77cda10a45f68375fd0a2ca9d00c6b62bd3f742c277a9cb',
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
