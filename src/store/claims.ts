import type { Claim, TargetType } from '../types.js';
import type { StoreContext } from './storeContext.js';
import { mapClaim, type ClaimRow } from './rows.js';

/** The active Claim on a target, or null once it expired. */
export function getClaim(
  ctx: StoreContext,
  type: TargetType,
  id: string,
  at = ctx.now(),
): Claim | null {
  const row = ctx.database
    .prepare('SELECT * FROM claims WHERE target_type=? AND target_id=? AND expires_at>?')
    .get(type, id, at) as ClaimRow | undefined;
  return row ? mapClaim(row) : null;
}
