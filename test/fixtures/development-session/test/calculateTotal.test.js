import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTotal } from '../src/calculateTotal.js';

test('synthetic baseline: an empty list totals zero', () => {
  assert.equal(calculateTotal([]), 0);
});

test('synthetic work: adds positive line-item values', () => {
  assert.equal(calculateTotal([12.5, 7.25, 0.25]), 20);
});

test('synthetic work: includes negative adjustments', () => {
  assert.equal(calculateTotal([15, -2.5, 1]), 13.5);
});
