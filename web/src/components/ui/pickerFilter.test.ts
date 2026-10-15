import { describe, expect, it } from 'vitest';
import { canCreateOption, filterPickerOptions, toggleValue } from './pickerFilter';

const options = [
  { label: 'In Progress', keywords: 'started' },
  { label: 'Done', hint: 'WEB' },
  { label: 'Backlog' },
];

describe('filterPickerOptions', () => {
  it('matches every token in label, keywords or hint (case-insensitive)', () => {
    expect(filterPickerOptions(options, 'prog in').map((o) => o.label)).toEqual(['In Progress']);
    expect(filterPickerOptions(options, 'STARTED').map((o) => o.label)).toEqual(['In Progress']);
    expect(filterPickerOptions(options, 'web').map((o) => o.label)).toEqual(['Done']);
  });
  it('returns everything for a blank query', () => {
    expect(filterPickerOptions(options, '  ')).toHaveLength(3);
  });
});

describe('canCreateOption', () => {
  it('requires a non-empty query without an exact (case-insensitive) label match', () => {
    expect(canCreateOption(options, '')).toBe(false);
    expect(canCreateOption(options, ' done ')).toBe(false);
    expect(canCreateOption(options, 'Do')).toBe(true);
  });
});

describe('toggleValue', () => {
  it('adds and removes values', () => {
    expect(toggleValue([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleValue([1, 2], 1)).toEqual([2]);
    expect(toggleValue<number | null>([null], null)).toEqual([]);
  });
});
