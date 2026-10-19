import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../lib/storage.test-utils';
import { LAST_SPACE_KEY, readLastSpace, rememberLastSpace, spaceContextValue, spaceLink, spaceOfPath } from './space';

const SPACE = '7k2m9q4w8x1c3v5b';

describe('spaceLink', () => {
  it('puts an in-app path under the space', () => {
    expect(spaceLink(SPACE, '/projects/3?task=1#c')).toBe(`/s/${SPACE}/projects/3?task=1#c`);
    expect(spaceLink(SPACE, '/')).toBe(`/s/${SPACE}/`);
  });
});

describe('spaceOfPath', () => {
  it('splits a space pathname into the space and the path inside it', () => {
    expect(spaceOfPath(`/s/${SPACE}/tasks/WEB-1`)).toEqual({ spaceId: SPACE, path: '/tasks/WEB-1' });
    expect(spaceOfPath(`/s/${SPACE}/`)).toEqual({ spaceId: SPACE, path: '/' });
    expect(spaceOfPath(`/s/${SPACE}`)).toEqual({ spaceId: SPACE, path: '/' });
  });
  it('is null outside a space and for what is no space id', () => {
    for (const path of ['/', '/spaces', '/settings', '/tasks/1', '/s/', `/s/${SPACE.toUpperCase()}/x`, '/s/not-a-space/x', `/x/s/${SPACE}/`]) {
      expect(spaceOfPath(path), path).toBeNull();
    }
  });
});

describe('spaceContextValue', () => {
  it('derives the permissions from the role (shared/src/roles.ts)', () => {
    expect(spaceContextValue({ id: SPACE, role: 'viewer', name: 'S' }).permissions).toMatchObject({ write: false, manageStructure: false, export: false });
    expect(spaceContextValue({ id: SPACE, role: 'member', name: 'S' }).permissions).toMatchObject({ write: true, deleteProjects: false });
    expect(spaceContextValue({ id: SPACE, role: 'owner', name: 'S' }).permissions).toMatchObject({ write: true, export: true, deleteSpace: true });
  });
});

describe('the last space used', () => {
  it('is remembered and read back', () => {
    const storage = memoryStorage();
    expect(readLastSpace(storage)).toBeNull();
    rememberLastSpace(SPACE, storage);
    expect(storage.map.get(LAST_SPACE_KEY)).toBe(SPACE);
    expect(readLastSpace(storage)).toBe(SPACE);
  });
  it('ignores a stored value that is no space id', () => {
    for (const value of ['', '../evil', '//evil.example', 'i'.repeat(16), `${SPACE}/x`]) {
      expect(readLastSpace(memoryStorage({ [LAST_SPACE_KEY]: value })), value).toBeNull();
    }
  });
  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readLastSpace(broken)).toBeNull();
    expect(() => rememberLastSpace(SPACE, broken)).not.toThrow();
  });
});
