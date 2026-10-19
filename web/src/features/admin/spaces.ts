// What Administration → Spaces shows of a space (design §5.8.16, §5.8.18, §13.11, Appendix D 20): its state
// (active, being imported or created, deleted and restorable until its purge unless nobody is left to open it,
// being removed), its owners,
// its size, and whether it can be deleted or restored now. Pure, so they are unit-tested (spaces.test.ts).

import type { AdminSpaceDTO, UserRef } from '@shared/types';
import { formatDate, isoToLocalDate } from '../../lib/format';

export type AdminSpaceState =
  | { kind: 'active' }
  | { kind: 'importing' }
  | { kind: 'provisioning' }
  /** Deleted, purged from `until` (purge_after) on; restorable until then when someone could open it again. */
  | { kind: 'deleted'; until: string; restorable: boolean }
  /** Deleted, and its grace period is over: the purge may be under way. */
  | { kind: 'removing' };

export function spaceState(space: Pick<AdminSpaceDTO, 'status' | 'deletedAt' | 'purgeAfter' | 'memberCount'>, nowMs: number): AdminSpaceState {
  if (space.deletedAt !== null) {
    return space.purgeAfter !== null && Date.parse(space.purgeAfter) > nowMs
      ? { kind: 'deleted', until: space.purgeAfter, restorable: space.memberCount > 0 }
      : { kind: 'removing' };
  }
  return { kind: space.status };
}

/** The state as the list says it; `today` for the date (the viewer's 'YYYY-MM-DD'). */
export function spaceStateText(state: AdminSpaceState, today: string): string {
  switch (state.kind) {
    case 'active':
      return 'Active';
    case 'importing':
      return 'Being imported';
    case 'provisioning':
      return 'Being created';
    case 'deleted': {
      const date = formatDate(isoToLocalDate(state.until), today);
      return state.restorable ? `Deleted · can be restored until ${date}` : `Deleted · removed for good on ${date}`;
    }
    case 'removing':
      return 'Deleted · being removed';
  }
}

/** Delete while it is active or a stalled import; restore while restorable and someone could open it again. */
export function spaceActions(space: Pick<AdminSpaceDTO, 'status' | 'deletedAt' | 'purgeAfter' | 'memberCount'>, nowMs: number): { delete: boolean; restore: boolean } {
  const state = spaceState(space, nowMs);
  return {
    delete: state.kind === 'active' || state.kind === 'importing',
    restore: state.kind === 'deleted' && state.restorable,
  };
}

export function ownersText(owners: readonly UserRef[]): string {
  if (owners.length === 0) return 'No owner';
  return `${owners.length === 1 ? 'Owner' : 'Owners'}: ${owners.map((o) => o.displayName).join(', ')}`;
}

/** A size in the units of the CLI's `spaces` (1024-based, cli.ts#formatSize); null when unknown (Cloudflare). */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
