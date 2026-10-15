import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { apiFieldErrors, hasFieldErrors, zodFieldErrors } from './formErrors';
import { normalizeHex } from './hex';
import { formatShortcut, formatShortcutKeys } from './shortcuts';
import { initials } from './text';
import { loginInput } from '@shared/schemas';

describe('formatShortcut', () => {
  it('uses platform labels', () => {
    expect(formatShortcut('mod+k', true)).toBe('⌘K');
    expect(formatShortcut('mod+k', false)).toBe('Ctrl K');
    expect(formatShortcut('mod+enter', true)).toBe('⌘↵');
    expect(formatShortcutKeys('shift+?', false)).toEqual(['Shift', '?']);
    expect(formatShortcutKeys('c', false)).toEqual(['C']);
  });
});

describe('normalizeHex', () => {
  it('accepts 3/6 digit hex with or without #', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex(' 4f46e5 ')).toBe('#4f46e5');
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
  });
});

describe('initials', () => {
  it('takes first and last word initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Grace Brewster Hopper')).toBe('GH');
    expect(initials('darren')).toBe('DA');
    expect(initials('darren.eberly')).toBe('DE');
    expect(initials('  ')).toBe('?');
  });
});

describe('form errors', () => {
  it('maps zod issues to the first message per field', () => {
    const r = loginInput.safeParse({ username: '', password: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const fe = zodFieldErrors(r.error);
      expect(fe.username).toBe('Required');
      expect(fe.password).toBe('Required');
      expect(hasFieldErrors(fe)).toBe(true);
    }
  });
  it('maps ApiError details and ignores other errors', () => {
    const err = new ApiError(400, 'validation_error', 'bad', [
      { path: 'dueDate', message: 'Too early' },
      { path: 'dueDate', message: 'second' },
    ]);
    expect(apiFieldErrors(err)).toEqual({ dueDate: 'Too early' });
    expect(apiFieldErrors(new Error('x'))).toEqual({});
    expect(hasFieldErrors({ '': 'form level' })).toBe(false);
  });
});
