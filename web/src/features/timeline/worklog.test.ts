import { describe, expect, it } from 'vitest';
import { LIMITS } from '@shared/constants';
import type { WorklogReportDTO } from '@shared/types';
import {
  durationText,
  parseDurationInput,
  TIME_OR_NOTE,
  validateWorklogForm,
  worklogApiErrors,
} from './worklogForm';
import { formatRange, presetRange, reportDays, reportProjects, resolveRange } from './worklogReport';

describe('parseDurationInput', () => {
  it.each([
    ['1h 30m', 90],
    ['90', 90],
    ['1.5h', 90],
    ['1:30', 90],
    ['2h', 120],
    ['45m', 45],
    ['1h30', 90],
    [' 15 ', 15],
    ['0', 0],
  ])('%s → %i minutes', (text, minutes) => {
    expect(parseDurationInput(text)).toEqual({ state: 'valid', minutes });
  });

  it('treats blank input as empty', () => {
    expect(parseDurationInput('')).toEqual({ state: 'empty' });
    expect(parseDurationInput('   ')).toEqual({ state: 'empty' });
  });

  it('rejects unreadable and too-long durations', () => {
    expect(parseDurationInput('soon').state).toBe('invalid');
    expect(parseDurationInput('1:75').state).toBe('invalid');
    expect(parseDurationInput(String(LIMITS.worklogMinutesMax + 1)).state).toBe('invalid');
    expect(parseDurationInput(String(LIMITS.worklogMinutesMax))).toEqual({ state: 'valid', minutes: LIMITS.worklogMinutesMax });
  });
});

describe('validateWorklogForm', () => {
  it('builds the API input', () => {
    expect(validateWorklogForm({ date: '2026-10-13', duration: '1h 30m', note: '  Pairing  ' })).toEqual({
      ok: true,
      input: { date: '2026-10-13', minutes: 90, note: 'Pairing' },
    });
    expect(validateWorklogForm({ date: '2026-10-13', duration: '', note: 'Only a note' })).toEqual({
      ok: true,
      input: { date: '2026-10-13', minutes: null, note: 'Only a note' },
    });
  });

  it('requires time or a note (reported on the duration field)', () => {
    expect(validateWorklogForm({ date: '2026-10-13', duration: '', note: ' ' })).toEqual({ ok: false, errors: { duration: TIME_OR_NOTE } });
    expect(validateWorklogForm({ date: '2026-10-13', duration: '0', note: '' })).toEqual({ ok: false, errors: { duration: TIME_OR_NOTE } });
  });

  it('reports date, duration and note problems', () => {
    const r = validateWorklogForm({ date: null, duration: 'later', note: 'x'.repeat(LIMITS.worklogNoteMax + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.date).toBe('Pick a date');
      expect(r.errors.duration).toMatch(/Couldn’t read that/);
      expect(r.errors.note).toMatch(/under/);
    }
    const bad = validateWorklogForm({ date: '2026-02-30', duration: '1h', note: '' });
    expect(bad).toEqual({ ok: false, errors: { date: 'Enter a valid date' } });
  });

  it('maps API errors onto form fields', () => {
    expect(
      worklogApiErrors([
        { path: 'note', message: TIME_OR_NOTE },
        { path: 'date', message: 'Bad date' },
      ]),
    ).toEqual({ duration: TIME_OR_NOTE, date: 'Bad date' });
    expect(worklogApiErrors([{ path: 'minutes', message: 'Too big' }, { path: 'note', message: 'Too long' }])).toEqual({
      duration: 'Too big',
      note: 'Too long',
    });
    expect(worklogApiErrors([{ path: 'other', message: 'x' }])).toEqual({});
  });

  it('durationText', () => {
    expect(durationText(90)).toBe('1h 30m');
    expect(durationText(0)).toBe('');
    expect(durationText(null)).toBe('');
  });
});

describe('presetRange', () => {
  // 2026-10-13 is a Tuesday.
  const today = '2026-10-13';
  it('this week / last week honour the week start', () => {
    expect(presetRange('this_week', today, 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(presetRange('this_week', today, 0)).toEqual({ from: '2026-10-11', to: '2026-10-17' });
    expect(presetRange('last_week', today, 1)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(presetRange('last_week', today, 0)).toEqual({ from: '2026-10-04', to: '2026-10-10' });
  });

  it('this month covers the whole calendar month', () => {
    expect(presetRange('this_month', today, 1)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('this_month', '2028-02-29', 1)).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(presetRange('this_month', '2026-02-01', 1)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(presetRange('this_month', '2026-12-31', 1)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('last 30 days ends today', () => {
    expect(presetRange('last_30', today, 1)).toEqual({ from: '2026-09-14', to: '2026-10-13' });
  });
});

describe('resolveRange', () => {
  const today = '2026-10-13';
  it('defaults to this week', () => {
    expect(resolveRange({}, today, 1)).toEqual({ preset: 'this_week', range: { from: '2026-10-12', to: '2026-10-18' } });
    expect(resolveRange({ range: 'bogus' }, today, 1).preset).toBe('this_week');
  });

  it('reads custom ranges (swapping reversed ones) and rejects invalid ones', () => {
    expect(resolveRange({ range: 'custom', from: '2026-09-01', to: '2026-09-30' }, today, 1)).toEqual({
      preset: 'custom',
      range: { from: '2026-09-01', to: '2026-09-30' },
    });
    expect(resolveRange({ range: 'custom', from: '2026-09-30', to: '2026-09-01' }, today, 1).range).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(resolveRange({ range: 'custom', from: '2026-09-31', to: '2026-10-01' }, today, 1).preset).toBe('this_week');
    expect(resolveRange({ range: 'custom' }, today, 1).preset).toBe('this_week');
  });

  it('formats ranges', () => {
    expect(formatRange({ from: '2026-10-13', to: '2026-10-13' }, today)).not.toContain('–');
    expect(formatRange({ from: '2026-10-12', to: '2026-10-18' }, today)).toContain(' – ');
  });
});

describe('report totals', () => {
  const item = (id: number, date: string, minutes: number | null, projectId: number): WorklogReportDTO['items'][number] => ({
    id,
    taskId: id,
    date,
    minutes,
    note: '',
    author: null,
    createdAt: `${date}T10:00:00.000Z`,
    updatedAt: `${date}T10:00:00.000Z`,
    task: { id, ref: `P-${id}`, title: `Task ${id}`, projectId },
  });
  const items = [item(1, '2026-10-13', 30, 1), item(2, '2026-10-13', null, 2), item(3, '2026-10-12', 90, 2), item(4, '2026-10-10', 15, 1)];

  it('groups by day with daily totals', () => {
    expect(reportDays(items).map((d) => [d.date, d.minutes, d.items.map((i) => i.id)])).toEqual([
      ['2026-10-13', 30, [1, 2]],
      ['2026-10-12', 90, [3]],
      ['2026-10-10', 15, [4]],
    ]);
  });

  it('totals per project, most time first', () => {
    expect(reportProjects(items)).toEqual([
      { projectId: 2, minutes: 90, entries: 2 },
      { projectId: 1, minutes: 45, entries: 2 },
    ]);
    expect(reportProjects([])).toEqual([]);
  });
});
