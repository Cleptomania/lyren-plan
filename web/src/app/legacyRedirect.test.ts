import { describe, expect, it } from 'vitest';
import type { SpaceSummaryDTO } from '@shared/types';
import { homePath, homeSpace, legacyRedirectPath, legacySpace } from './legacyRedirect';

const ORIGIN = 'https://plan.example.com';
const A = '7k2m9q4w8x1c3v5b';
const B = '0123456789abcdef';
const C = 'zzzzzzzzzzzzzzzz';

const summary = (id: string): SpaceSummaryDTO => ({ id, name: id, role: 'owner', status: 'active', memberCount: 1, createdAt: '2026-10-01T00:00:00.000Z' });
const status = (ids: string[], legacySpaceId: string | null = null) => ({ spaces: ids.map(summary), legacySpaceId });
const at = (path: string) => {
  const url = new URL(path, ORIGIN);
  return { pathname: url.pathname, search: url.search, hash: url.hash };
};
const redirect = (path: string, target: string | null = A) => legacyRedirectPath(at(path), target, ORIGIN);

describe('where / goes', () => {
  it('to the last space used while the account has it, else its first space, else /spaces', () => {
    expect(homeSpace(status([A, B]), B)).toBe(B);
    expect(homeSpace(status([A, B]), C)).toBe(A);
    expect(homeSpace(status([A, B]), null)).toBe(A);
    expect(homePath(status([A, B]), B)).toBe(`/s/${B}/`);
    expect(homePath(status([]), A)).toBe('/spaces');
  });

  it('never to a space still being imported (it opens once the import is done)', () => {
    const importing = (ids: string[], last: string | null) => ({ spaces: ids.map((id) => ({ ...summary(id), status: id === A ? ('importing' as const) : ('active' as const) })), legacySpaceId: last });
    expect(homeSpace(importing([A, B], null), A)).toBe(B);
    expect(homePath(importing([A], null), A)).toBe('/spaces');
    expect(legacySpace(importing([A, B], A), null)).toBe(B);
  });
});

describe('the space old links go to', () => {
  it('prefers the upgraded install’s space, then the last used, then the first', () => {
    expect(legacySpace(status([A, B], B), A)).toBe(B);
    expect(legacySpace(status([A, B], null), B)).toBe(B);
    expect(legacySpace(status([A, B], null), null)).toBe(A);
    expect(legacySpace(status([], null), A)).toBeNull();
  });
  it('never takes a space the account is not a member of', () => {
    expect(legacySpace(status([A], C), C)).toBe(A);
    expect(legacySpace(status([], C), C)).toBeNull();
  });
});

describe('legacyRedirectPath', () => {
  it('keeps the path, search and hash under the space', () => {
    expect(redirect('/tasks/WEB-12')).toBe(`/s/${A}/tasks/WEB-12`);
    expect(redirect('/projects/3/board?task=17')).toBe(`/s/${A}/projects/3/board?task=17`);
    expect(redirect('/boards/2?q=a%20b#x')).toBe(`/s/${A}/boards/2?q=a%20b#x`);
    expect(redirect('/projects')).toBe(`/s/${A}/projects`);
    for (const page of ['/dashboard', '/activity', '/worklog']) expect(redirect(page)).toBe(`/s/${A}${page}`);
  });
  it('sends the old space settings to the space’s settings', () => {
    for (const section of ['statuses', 'tags', 'data']) expect(redirect(`/settings/${section}`)).toBe(`/s/${A}/settings/${section}`);
  });
  it('goes to /spaces without a space', () => {
    expect(redirect('/tasks/WEB-12', null)).toBe('/spaces');
    expect(redirect('/tasks/WEB-12', '../../evil')).toBe('/spaces');
  });
  it('goes to the space’s home for a path that was no space route', () => {
    for (const path of ['/settings', '/settings/preferences', '/spaces', '/admin', '/', '/dashboardx', '/settings/tags/x']) {
      expect(redirect(path), path).toBe(`/s/${A}/`);
    }
  });

  it('never leaves the space, whatever the path (open-redirect cases)', () => {
    const crafted = [
      '//evil.example/x',
      '/\\evil.example/x',
      '/tasks//evil.example/x',
      '/tasks/%2F%2Fevil.example',
      '/tasks/%2e%2e/%2e%2e/%2e%2e//evil.example/x',
      '/tasks/..%2f..%2f..%2f%2fevil.example',
      '/projects/../../..//evil.example',
      '/tasks/x?next=https://evil.example#//evil.example',
      '/tasks/\t//evil.example',
    ];
    for (const path of crafted) {
      // Both as a URL parser left the location, and as the raw string a router could hand over.
      for (const location of [at(path), { pathname: path.split(/[?#]/)[0]!, search: '', hash: '' }]) {
        const out = legacyRedirectPath(location, A, ORIGIN);
        const url = new URL(out, ORIGIN);
        expect(url.origin, path).toBe(ORIGIN);
        expect(out.startsWith(`/s/${A}/`), `${path} → ${out}`).toBe(true);
        expect(url.pathname.startsWith(`/s/${A}/`), `${path} → ${out}`).toBe(true);
      }
    }
  });
});
