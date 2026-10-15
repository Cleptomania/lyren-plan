import { describe, expect, it } from 'vitest';
import { COLOR_PALETTE, PRIORITY_META } from '@shared/constants';
import { taskUpdateInput } from '@shared/schemas';
import { dueState, quickDates } from './dueDates';
import { epicGroupLabel, groupEpicsByMilestone, scopeProjectIds, statusFraction } from './entityGroups';
import { ESTIMATE_MAX, parseEstimateInput } from './estimateInput';
import { epic, lookups, milestone, project, status, task } from './fixtures.test-utils';
import { taskItemPropsEqual } from './memoCompare';
import { isCardKey, stopCardEvents } from './openClick';
import { progressSummary } from './progress';
import {
  DEFAULT_CARD_FIELDS,
  DEFAULT_ROW_FIELDS,
  markdownExcerpt,
  paletteColor,
  resolveFields,
  resolveRowFields,
  tagPatch,
  taskClosedKind,
  taskColor,
  taskIsClosed,
} from './taskDisplay';

describe('field sets', () => {
  it('card defaults follow the board schema defaults', () => {
    expect(DEFAULT_CARD_FIELDS).toMatchObject({ ref: true, project: true, epic: true, tags: true, priority: true, dueDate: true, status: false, description: false });
  });

  it('row defaults add status and estimate', () => {
    expect(DEFAULT_ROW_FIELDS.status).toBe(true);
    expect(DEFAULT_ROW_FIELDS.estimate).toBe(true);
  });

  it('resolveFields merges partial toggles without mutating defaults', () => {
    const f = resolveFields({ description: true, tags: false }, DEFAULT_CARD_FIELDS);
    expect(f.description).toBe(true);
    expect(f.tags).toBe(false);
    expect(f.ref).toBe(true);
    expect(DEFAULT_CARD_FIELDS.tags).toBe(true);
  });

  it('resolveRowFields applies hide and showRef on top of explicit fields', () => {
    const f = resolveRowFields({ milestone: true }, ['project', 'milestone'], false);
    expect(f.project).toBe(false);
    expect(f.milestone).toBe(false);
    expect(f.ref).toBe(false);
    expect(f.status).toBe(true);
  });
});

describe('closed state', () => {
  const statusById = new Map([
    [1, status(1, 'unstarted')],
    [2, status(2, 'completed')],
    [3, status(3, 'cancelled')],
  ]);

  it('derives the closed kind from the status category', () => {
    expect(taskClosedKind(task({ statusId: 1 }), statusById)).toBeNull();
    expect(taskClosedKind(task({ statusId: 2 }), statusById)).toBe('completed');
    expect(taskClosedKind(task({ statusId: 3 }), statusById)).toBe('cancelled');
    expect(taskIsClosed(task({ statusId: 3 }), statusById)).toBe(true);
  });

  it('treats an unknown status as open', () => {
    expect(taskClosedKind(task({ statusId: 99 }), statusById)).toBeNull();
  });
});

describe('taskColor', () => {
  const l = lookups({
    statuses: [status(1, 'started', 1, '#123456')],
    projects: [project(1, 'WEB', { color: '#abcdef' })],
    milestones: [milestone(5, 1)],
    epics: [epic(7, 1, 5, 1, { color: '#ff00ff' })],
  });
  const t = task({
    statusId: 1,
    priority: 3,
    epicId: 7,
    milestoneId: 5,
    tags: [
      { id: 1, name: 'a', color: '#111111' },
      { id: 2, name: 'b', color: '#222222' },
    ],
  });

  it('maps every colorBy option', () => {
    expect(taskColor(t, 'none', l)).toBeNull();
    expect(taskColor(t, 'project', l)).toBe('#abcdef');
    expect(taskColor(t, 'epic', l)).toBe('#ff00ff');
    expect(taskColor(t, 'status', l)).toBe('#123456');
    expect(taskColor(t, 'priority', l)).toBe(PRIORITY_META[3].color);
    expect(taskColor(t, 'tag', l)).toBe('#111111');
    expect(COLOR_PALETTE).toContain(taskColor(t, 'milestone', l));
  });

  it('returns null when the task has nothing to color by', () => {
    const bare = task({ priority: 0 });
    expect(taskColor(bare, 'epic', l)).toBeNull();
    expect(taskColor(bare, 'milestone', l)).toBeNull();
    expect(taskColor(bare, 'priority', l)).toBeNull();
    expect(taskColor(bare, 'tag', l)).toBeNull();
    expect(taskColor(task({ projectId: 42 }), 'project', l)).toBeNull();
  });
});

describe('paletteColor', () => {
  it('is stable, case-insensitive and from the palette', () => {
    expect(paletteColor('Bug')).toBe(paletteColor('bug'));
    expect(paletteColor(12)).toBe(paletteColor('12'));
    expect(COLOR_PALETTE).toContain(paletteColor('anything'));
  });
});

describe('stopCardEvents', () => {
  it('stops only the keys a card/row or the drag sensor act on', () => {
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowLeft']) expect(isCardKey(key)).toBe(true);
    for (const key of ['k', '/', 'c', '?', 'Escape', 'Tab', 'Control', 'Meta']) expect(isCardKey(key)).toBe(false);
    const stopped: string[] = [];
    for (const key of ['Enter', 'k', '/']) stopCardEvents.onKeyDown({ key, stopPropagation: () => stopped.push(key) });
    expect(stopped).toEqual(['Enter']);
  });
});

describe('markdownExcerpt', () => {
  it('strips markdown syntax and keeps the words', () => {
    const md = '# Heading\n\n- [ ] **Bold** item with [a link](https://x.test)\n> quote `code`\n\n```js\nconst x = 1;\n```\n![alt](img.png) _em_';
    expect(markdownExcerpt(md)).toBe('Heading Bold item with a link quote code alt em');
  });

  it('truncates at a word boundary with an ellipsis', () => {
    const out = markdownExcerpt('alpha beta gamma delta epsilon', 18);
    expect(out).toBe('alpha beta gamma…');
  });

  it('keeps snake_case identifiers and short text intact', () => {
    expect(markdownExcerpt('Use my_var here')).toBe('Use my_var here');
    expect(markdownExcerpt('')).toBe('');
  });

  it('keeps inline code verbatim, including < and >', () => {
    expect(markdownExcerpt('Found the cause: `microdata.js` assumes `itemprop=recipeIngredient` is on `<li>`.')).toBe(
      'Found the cause: microdata.js assumes itemprop=recipeIngredient is on <li>.',
    );
    expect(markdownExcerpt('Wrap the spoiler in `<details>` instead of `<div>`.')).toBe('Wrap the spoiler in <details> instead of <div>.');
    expect(markdownExcerpt('Compare `a < b` and `c > d` in the sort fn')).toBe('Compare a < b and c > d in the sort fn');
    expect(markdownExcerpt('Emphasis stays literal in code: `**not bold**` and `_x_`')).toBe('Emphasis stays literal in code: **not bold** and _x_');
    expect(markdownExcerpt('Double ticks: `` a ` b `` done')).toBe('Double ticks: a ` b done');
    expect(markdownExcerpt('A stray ` backtick')).toBe('A stray backtick');
  });

  it('keeps comparisons, generics and raw HTML as text (the renderer shows them literally)', () => {
    expect(markdownExcerpt('Use Map<string, number> for the cache')).toBe('Use Map<string, number> for the cache');
    expect(markdownExcerpt('if x < 3 and y > 5 then')).toBe('if x < 3 and y > 5 then');
    expect(markdownExcerpt('Line<br>break')).toBe('Line<br>break');
    expect(markdownExcerpt('See <https://x.test/a> now')).toBe('See https://x.test/a now');
  });

  it('flattens GFM tables', () => {
    const md = 'Status:\n\n| Site | Works |\n|---|:---:|\n| allrecipes | yes |\n| bbc | no \\| partly |\n\nAfter the table.';
    expect(markdownExcerpt(md)).toBe('Status: Site · Works allrecipes · yes bbc · no | partly After the table.');
    expect(markdownExcerpt('Area | Owner\n--- | ---\nImport | me')).toBe('Area · Owner Import · me');
    // A pipe in prose (no delimiter row) is not a table; a lone "---" is a rule.
    expect(markdownExcerpt('a | b\n\n---\n\nc')).toBe('a | b c');
  });
});

describe('tagPatch', () => {
  it('produces valid API patches', () => {
    expect(taskUpdateInput.parse(tagPatch([1, 2], [2, 3]))).toEqual({ addTagIds: [3], removeTagIds: [1] });
  });

  it('returns add/remove ids relative to the starting set', () => {
    expect(tagPatch([1, 2], [2, 3])).toEqual({ addTagIds: [3], removeTagIds: [1] });
    expect(tagPatch([1], [1, 4])).toEqual({ addTagIds: [4] });
    expect(tagPatch([1, 2], [2, 1])).toBeNull();
  });
});

describe('due dates', () => {
  it('classifies due dates relative to today', () => {
    expect(dueState('2026-10-12', '2026-10-13')).toBe('overdue');
    expect(dueState('2026-10-13', '2026-10-13')).toBe('today');
    expect(dueState('2026-10-14', '2026-10-13')).toBe('soon');
    expect(dueState('2026-10-20', '2026-10-13')).toBe('upcoming');
    expect(dueState('2026-10-01', '2026-10-13', true)).toBe('closed');
  });

  it('offers today, tomorrow and the first day of next week', () => {
    // 2026-10-13 is a Tuesday.
    expect(quickDates('2026-10-13', 1).map((q) => q.date)).toEqual(['2026-10-13', '2026-10-14', '2026-10-19']);
    expect(quickDates('2026-10-13', 0).map((q) => q.date)).toEqual(['2026-10-13', '2026-10-14', '2026-10-18']);
    // Sunday with Monday-start weeks: next week starts tomorrow.
    expect(quickDates('2026-10-18', 1)[2]!.date).toBe('2026-10-19');
  });
});

describe('parseEstimateInput', () => {
  it('parses numbers, decimal commas and empty input', () => {
    expect(parseEstimateInput('3', 'points')).toEqual({ ok: true, value: 3 });
    expect(parseEstimateInput(' 2,5 ', 'points')).toEqual({ ok: true, value: 2.5 });
    expect(parseEstimateInput('.5', 'hours')).toEqual({ ok: true, value: 0.5 });
    expect(parseEstimateInput('5.', 'points')).toEqual({ ok: true, value: 5 });
    expect(parseEstimateInput('', 'points')).toEqual({ ok: true, value: null });
  });

  it('accepts durations in hours mode only', () => {
    expect(parseEstimateInput('1h 30m', 'hours')).toEqual({ ok: true, value: 1.5 });
    expect(parseEstimateInput('45m', 'hours')).toEqual({ ok: true, value: 0.75 });
    expect(parseEstimateInput('1h', 'points').ok).toBe(false);
  });

  it('rejects garbage and out-of-range values', () => {
    expect(parseEstimateInput('abc', 'points').ok).toBe(false);
    expect(parseEstimateInput('-1', 'points').ok).toBe(false);
    expect(parseEstimateInput(String(ESTIMATE_MAX + 1), 'points').ok).toBe(false);
  });

  it('rounds to two decimals', () => {
    expect(parseEstimateInput('1.234', 'points')).toEqual({ ok: true, value: 1.23 });
  });
});

describe('progressSummary', () => {
  const stats = { tasksTotal: 20, tasksClosed: 12, estimateTotal: 20, estimateClosed: 8 };

  it('summarizes by tasks', () => {
    expect(progressSummary(stats)).toEqual({ done: 12, total: 20, percent: 60, text: '12/20 done · 60%' });
  });

  it('summarizes by estimate in the configured unit', () => {
    expect(progressSummary(stats, 'estimate', 'points').text).toBe('8/20 pts done · 40%');
    expect(progressSummary(stats, 'estimate', 'hours').text).toBe('8/20h done · 40%');
  });

  it('handles empty scopes', () => {
    const empty = { tasksTotal: 0, tasksClosed: 0, estimateTotal: 0, estimateClosed: 0 };
    expect(progressSummary(empty)).toMatchObject({ percent: 0, text: 'No tasks' });
    expect(progressSummary(empty, 'estimate').text).toBe('No estimates');
  });
});

describe('entity groups', () => {
  const l = lookups({
    projects: [project(1, 'WEB'), project(2, 'APP', { position: 0 }), project(3, 'OLD', { status: 'archived' })],
    milestones: [milestone(10, 1, 2), milestone(11, 1, 1)],
    epics: [epic(20, 1, 10), epic(21, 1, null), epic(22, 1, 11), epic(23, 2, null), epic(24, 1, 999)],
  });
  // lookups() keeps the given order; sort projects by position like buildLookups does.
  l.projects.sort((a, b) => a.position - b.position);
  l.milestonesByProject.get(1)!.sort((a, b) => a.position - b.position);

  it('scopes projects in position order and skips archived by default', () => {
    expect(scopeProjectIds(l, undefined)).toEqual([2, 1]);
    expect(scopeProjectIds(l, 3)).toEqual([3]);
    expect(scopeProjectIds(l, [1, 2, 99])).toEqual([2, 1]);
  });

  it('groups epics by milestone order, then epics without (or with a foreign) milestone', () => {
    const groups = groupEpicsByMilestone(l, [1]);
    expect(groups.map((g) => [g.key, g.epics.map((e) => e.id)])).toEqual([
      ['m11', [22]],
      ['m10', [20]],
      ['p1:none', [21, 24]],
    ]);
    expect(epicGroupLabel(groups[0]!, false)).toBe('M11');
    expect(epicGroupLabel(groups[2]!, true)).toBe('WEB · No milestone');
  });

  it('omits projects without epics', () => {
    expect(groupEpicsByMilestone(l, [3])).toEqual([]);
  });

  it('spreads started statuses over the pie', () => {
    const statuses = [status(1, 'unstarted'), status(2, 'started', 5), status(3, 'started', 3), status(4, 'completed')];
    expect(statusFraction(statuses[2]!, statuses)).toBeCloseTo(1 / 3);
    expect(statusFraction(statuses[1]!, statuses)).toBeCloseTo(2 / 3);
    expect(statusFraction(statuses[0]!, statuses)).toBe(0);
  });
});

describe('taskItemPropsEqual', () => {
  const onOpen = () => {};
  it('compares fields and hide by content, everything else by identity', () => {
    const t = task();
    expect(taskItemPropsEqual({ task: t, hide: ['project'], fields: { ref: true } }, { task: t, hide: ['project'], fields: { ref: true } })).toBe(true);
    expect(taskItemPropsEqual({ task: t, hide: ['project'] }, { task: t, hide: ['epic'] })).toBe(false);
    expect(taskItemPropsEqual({ task: t, fields: { ref: true } }, { task: t, fields: { ref: false } })).toBe(false);
    expect(taskItemPropsEqual({ task: t, onOpen }, { task: t, onOpen: () => {} })).toBe(false);
    expect(taskItemPropsEqual({ task: t }, { task: { ...t } })).toBe(false);
    expect(taskItemPropsEqual({ task: t, style: { a: 1 } }, { task: t, style: { a: 1 } })).toBe(false);
  });
});
