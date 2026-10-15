import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './redirect';

const ORIGIN = 'https://plan.example.com';

describe('safeRedirectPath', () => {
  it('keeps same-origin app paths with their query and hash', () => {
    expect(safeRedirectPath('/projects/1/tasks', ORIGIN)).toBe('/projects/1/tasks');
    expect(safeRedirectPath('/boards/2?q=a%20b#x', ORIGIN)).toBe('/boards/2?q=a%20b#x');
    expect(safeRedirectPath('/', ORIGIN)).toBe('/');
  });

  it('rejects protocol-relative and backslash paths that point at another host', () => {
    expect(safeRedirectPath('//evil.example/x', ORIGIN)).toBe('/');
    expect(safeRedirectPath('///evil.example/x', ORIGIN)).toBe('/');
    expect(safeRedirectPath('/\\evil.example/x', ORIGIN)).toBe('/');
    expect(safeRedirectPath('/..//evil.example/x', ORIGIN)).toBe('/');
    expect(safeRedirectPath('/%2e%2e//evil.example/x', ORIGIN)).toBe('/');
  });

  it('rejects absolute URLs and non-strings', () => {
    expect(safeRedirectPath('https://evil.example/x', ORIGIN)).toBe('/');
    expect(safeRedirectPath('javascript:alert(1)', ORIGIN)).toBe('/');
    expect(safeRedirectPath('projects/1', ORIGIN)).toBe('/');
    expect(safeRedirectPath(undefined, ORIGIN)).toBe('/');
    expect(safeRedirectPath(null, ORIGIN)).toBe('/');
    expect(safeRedirectPath({ pathname: '/x' }, ORIGIN)).toBe('/');
  });
});
