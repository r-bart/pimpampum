import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const frozen = new Map([
  [
    'test/desktop-status.acceptance.test.ts',
    '8a9ee548f504bd9c9f7857716efd7a6b734a8fe08b5e081bd8a30577457a0f14',
  ],
  [
    'test/desktop-status.safety.acceptance.test.ts',
    '1e1f711b2e38a07f731a880affb15d537eb7047598eaa9a7bee9f550a57644c7',
  ],
  [
    'test/desktop-status.lifecycle.acceptance.test.ts',
    '50040208e18e5e99d0247b40a20aedbd42d9cf62fe2fd6f808ef74fcbf80735a',
  ],
  [
    'test/fixtures/overview/complete.json',
    '559fd9930739dc13858312d7e63f2b0b8bd408337ef738db582a2aee3a03c188',
  ],
  [
    'test/fixtures/overview/empty.json',
    '0fe194508bc2249166acb088330491a0c9984308fb204e783883afbd1ef9e9e7',
  ],
  [
    'test/fixtures/overview/invalid.json',
    '87641df18c8f1bf5547ced2b9e78a03a9b11ba36165d8a759bb89fb4f3e0e438',
  ],
  [
    'test/fixtures/overview/mixed.json',
    '67600a36f2a12be056a4109d677d7a9c042988cc814a9bc28f048b6a21b413eb',
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
