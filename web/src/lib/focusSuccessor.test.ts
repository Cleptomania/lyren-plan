import { describe, expect, it } from 'vitest';
import { successorOrder } from './focusSuccessor';

describe('successorOrder', () => {
  it('prefers the following items, then the preceding ones nearest first', () => {
    expect(successorOrder(['a', 'b', 'c', 'd'], 'b')).toEqual(['c', 'd', 'a']);
  });
  it('falls back to the previous item when the last one is removed', () => {
    expect(successorOrder(['a', 'b', 'c'], 'c')).toEqual(['b', 'a']);
  });
  it('is empty for a lone or unknown item', () => {
    expect(successorOrder(['a'], 'a')).toEqual([]);
    expect(successorOrder(['a', 'b'], 'x')).toEqual([]);
  });
  it('skips duplicates of the removed key and repeated keys', () => {
    expect(successorOrder(['a', 'b', 'c', 'b', 'c'], 'b')).toEqual(['c', 'a']);
  });
});
