import { describe, expect, it } from 'vitest';
import { deletesOpenTask } from './bulkDelete';

describe('deletesOpenTask', () => {
  it('is true only when the open task is among the deleted ids', () => {
    expect(deletesOpenTask(39, [38, 39])).toBe(true);
    expect(deletesOpenTask(40, [38, 39])).toBe(false);
  });

  it('is false when no task is open', () => {
    expect(deletesOpenTask(null, [1, 2])).toBe(false);
    expect(deletesOpenTask(null, [])).toBe(false);
  });
});
