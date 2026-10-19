// What Administration → Spaces shows of a space (design §5.8.16, §5.8.18, Appendix D 20).
import { describe, expect, it } from 'vitest';
import type { AdminSpaceDTO } from '@shared/types';
import { formatBytes, ownersText, spaceActions, spaceState, spaceStateText } from './spaces';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const space = (o: Partial<AdminSpaceDTO> = {}): AdminSpaceDTO => ({
  id: '7k2m9q4w8x1c3v5b',
  name: 'Team',
  status: 'active',
  owners: [{ id: 1, displayName: 'Ann' }],
  memberCount: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
  deletedAt: null,
  purgeAfter: null,
  bytes: 4096,
  ...o,
});
const deleted = (purgeAfter: string, o: Partial<AdminSpaceDTO> = {}) => space({ deletedAt: '2026-10-17T12:00:00.000Z', purgeAfter, ...o });

describe('spaceState', () => {
  it('active, being imported or created; deleted and restorable until its purge; then being removed', () => {
    expect(spaceState(space(), NOW)).toEqual({ kind: 'active' });
    expect(spaceState(space({ status: 'importing' }), NOW)).toEqual({ kind: 'importing' });
    expect(spaceState(space({ status: 'provisioning' }), NOW)).toEqual({ kind: 'provisioning' });
    expect(spaceState(deleted('2026-10-24T12:00:00.000Z'), NOW)).toEqual({ kind: 'deleted', until: '2026-10-24T12:00:00.000Z', restorable: true });
    expect(spaceState(deleted('2026-10-24T12:00:00.000Z', { memberCount: 0 }), NOW)).toEqual({ kind: 'deleted', until: '2026-10-24T12:00:00.000Z', restorable: false });
    // The purge may run from purge_after on (Appendix D 20).
    expect(spaceState(deleted('2026-10-18T12:00:00.000Z'), NOW)).toEqual({ kind: 'removing' });
    expect(spaceStateText({ kind: 'active' }, '2026-10-18')).toBe('Active');
    expect(spaceStateText({ kind: 'importing' }, '2026-10-18')).toBe('Being imported');
    expect(spaceStateText({ kind: 'provisioning' }, '2026-10-18')).toBe('Being created');
    expect(spaceStateText({ kind: 'deleted', until: '2026-10-24T12:00:00.000Z', restorable: true }, '2026-10-18')).toMatch(/^Deleted · can be restored until .*24/);
    expect(spaceStateText({ kind: 'deleted', until: '2026-10-24T12:00:00.000Z', restorable: false }, '2026-10-18')).toMatch(/^Deleted · removed for good on .*24/);
    expect(spaceStateText({ kind: 'removing' }, '2026-10-18')).toBe('Deleted · being removed');
  });
});

describe('spaceActions', () => {
  it('delete while active or a stalled import; restore while restorable and someone is left to open it', () => {
    expect(spaceActions(space(), NOW)).toEqual({ delete: true, restore: false });
    expect(spaceActions(space({ status: 'importing' }), NOW)).toEqual({ delete: true, restore: false });
    expect(spaceActions(space({ status: 'provisioning' }), NOW)).toEqual({ delete: false, restore: false });
    expect(spaceActions(deleted('2026-10-24T12:00:00.000Z'), NOW)).toEqual({ delete: false, restore: true });
    expect(spaceActions(deleted('2026-10-24T12:00:00.000Z', { memberCount: 0 }), NOW)).toEqual({ delete: false, restore: false });
    expect(spaceActions(deleted('2026-10-18T11:00:00.000Z'), NOW)).toEqual({ delete: false, restore: false });
  });
});

describe('texts', () => {
  it('owners and sizes (as the CLI’s spaces prints them)', () => {
    expect(ownersText([])).toBe('No owner');
    expect(ownersText([{ id: 1, displayName: 'Ann' }])).toBe('Owner: Ann');
    expect(ownersText([{ id: 1, displayName: 'Ann' }, { id: 2, displayName: 'Bob' }])).toBe('Owners: Ann, Bob');
    expect([0, 1023, 1536, 4096, 10 * 1024 ** 2, 3 * 1024 ** 3].map(formatBytes)).toEqual(['0 B', '1023 B', '1.5 KB', '4.0 KB', '10 MB', '3.0 GB']);
    expect(formatBytes(null)).toBeNull();
  });
});
