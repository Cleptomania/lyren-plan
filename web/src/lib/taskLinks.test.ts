import { describe, expect, it } from 'vitest';
import { pageInSpace, taskPageUrl } from './taskLinks';

const A = '7k2m9q4w8x1c3v5b';
const B = '0123456789abcdef';

describe('the task helpers of a space', () => {
  it('act in place only while the page is still in their space (a toast outlives a switch)', () => {
    expect(pageInSpace(A, `/s/${A}/dashboard`)).toBe(true);
    expect(pageInSpace(A, `/s/${A}`)).toBe(true);
    expect(pageInSpace(A, `/s/${A}/projects/3/board`)).toBe(true);
    // Switched to another space, or left for a page outside any space.
    expect(pageInSpace(A, `/s/${B}/dashboard`)).toBe(false);
    expect(pageInSpace(A, '/spaces')).toBe(false);
    expect(pageInSpace(A, '/settings/security')).toBe(false);
  });

  it('elsewhere, "Open" goes to the task’s full page in its own space', () => {
    expect(taskPageUrl(A, { id: 25 })).toBe(`/s/${A}/tasks/25`);
    expect(taskPageUrl(A, { id: 25, ref: 'WEB-21' })).toBe(`/s/${A}/tasks/WEB-21`);
  });
});
