import { describe, expect, it } from 'vitest';
import type { BootstrapDTO } from '@shared/types';
import { stillInBootstrap } from './leaveSave';

const boot = {
  projects: [{ id: 1 }, { id: 2 }],
  milestones: [{ id: 10 }],
  epics: [{ id: 20 }, { id: 21 }],
} as unknown as BootstrapDTO;

describe('stillInBootstrap (leave-save guard)', () => {
  it('is true for entities that are still listed', () => {
    expect(stillInBootstrap(boot, 'projects', 2)).toBe(true);
    expect(stillInBootstrap(boot, 'milestones', 10)).toBe(true);
    expect(stillInBootstrap(boot, 'epics', 21)).toBe(true);
  });

  it('is false once the entity was deleted (gone from the refetched bootstrap)', () => {
    expect(stillInBootstrap(boot, 'projects', 3)).toBe(false);
    expect(stillInBootstrap(boot, 'milestones', 11)).toBe(false);
    expect(stillInBootstrap(boot, 'epics', 22)).toBe(false);
  });

  it('is false when the cached data was dropped (signed out)', () => {
    expect(stillInBootstrap(undefined, 'projects', 1)).toBe(false);
  });
});
