/**
 * Synthetic test-only code. The empty-list baseline works, while aggregation is
 * intentionally incomplete so a development session has deterministic work.
 */
export function calculateTotal(values) {
  if (values.length === 0) return 0;

  throw new Error('Synthetic calculateTotal aggregation is intentionally incomplete');
}
