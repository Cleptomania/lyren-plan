import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { taskUpdateInput } from '@shared/schemas';
import type { MenuAction, MenuItem } from '../ui/menuItems';
import { epic, lookups, milestone, project, status, task } from './fixtures.test-utils';
import type { TaskActions } from './taskActions';

// vitest compiles .tsx with the classic JSX runtime (no React plugin in vitest.config.ts):
// provide the global it expects, then load the module under test.
(globalThis as { React?: typeof React }).React = React;
const { buildTaskActionItems } = await import('./taskActionItems');

function fakeActions() {
  return {
    open: vi.fn(),
    update: vi.fn(),
    duplicate: vi.fn(),
    setArchived: vi.fn(),
    delete: vi.fn(),
    editTags: vi.fn(),
    pickDueDate: vi.fn(),
  } satisfies TaskActions;
}

const isAction = (i: MenuItem): i is MenuAction => !('separator' in i) && !('heading' in i);
const labels = (items: MenuItem[]) => items.map((i) => ('separator' in i ? '---' : 'heading' in i ? `# ${i.heading}` : i.label));
const find = (items: MenuItem[], label: string): MenuAction => {
  const item = items.filter(isAction).find((i) => i.label === label);
  if (!item) throw new Error(`No menu item "${label}" in ${labels(items).join(', ')}`);
  return item;
};

const l = lookups({
  statuses: [status(1, 'unstarted'), status(2, 'started'), status(3, 'completed')],
  projects: [project(1, 'WEB'), project(2, 'APP'), project(3, 'OLD', { status: 'archived' })],
  milestones: [milestone(10, 1)],
  epics: [epic(20, 1, 10), epic(21, 1, null), epic(30, 2, null)],
});
const today = '2026-10-13';

describe('buildTaskActionItems', () => {
  it('lists the shared actions in order', () => {
    const items = buildTaskActionItems(task(), { lookups: l, today }, fakeActions());
    expect(labels(items)).toEqual([
      'Open',
      '---',
      'Status',
      'Priority',
      'Due date',
      'Tags…',
      '---',
      'Move to epic',
      'Move to project',
      '---',
      'Duplicate',
      'Archive',
      'Delete…',
    ]);
  });

  it('inserts extra items before the destructive section and can hide Open', () => {
    const extra = vi.fn(() => [{ label: 'Move to column', items: [{ label: 'Done' }] }, false as const]);
    const items = buildTaskActionItems(task(), { lookups: l, today }, fakeActions(), { onOpen: false, extra });
    expect(extra).toHaveBeenCalledOnce();
    expect(labels(items)).toEqual([
      'Status',
      'Priority',
      'Due date',
      'Tags…',
      '---',
      'Move to epic',
      'Move to project',
      '---',
      'Move to column',
      '---',
      'Duplicate',
      'Archive',
      'Delete…',
    ]);
  });

  it('changes status, priority and due date through taskActions.update', () => {
    const actions = fakeActions();
    const t = task({ statusId: 1, priority: 2 });
    const items = buildTaskActionItems(t, { lookups: l, today }, actions);

    const statusSub = find(items, 'Status').items!.filter(isAction);
    expect(statusSub.map((s) => [s.label, s.checked])).toEqual([
      ['S1', true],
      ['S2', false],
      ['S3', false],
    ]);
    find(statusSub, 'S1').onSelect!();
    expect(actions.update).not.toHaveBeenCalled();
    find(statusSub, 'S3').onSelect!();
    expect(actions.update).toHaveBeenLastCalledWith(t, { statusId: 3 });

    const prioritySub = find(items, 'Priority').items!.filter(isAction);
    expect(prioritySub.map((p) => p.label)).toEqual(['Urgent', 'High', 'Medium', 'Low', 'No priority']);
    find(prioritySub, 'Urgent').onSelect!();
    expect(actions.update).toHaveBeenLastCalledWith(t, { priority: 4 });

    const dueSub = find(items, 'Due date').items!;
    find(dueSub, 'Tomorrow').onSelect!();
    expect(actions.update).toHaveBeenLastCalledWith(t, { dueDate: '2026-10-14' });
    expect(find(dueSub, 'Clear').disabled).toBe(true);
    find(dueSub, 'Pick a date…').onSelect!();
    expect(actions.pickDueDate).toHaveBeenCalledWith(t);
  });

  it('groups the project epics by milestone with a "No epic" choice', () => {
    const actions = fakeActions();
    const t = task({ epicId: 20, milestoneId: 10 });
    const items = buildTaskActionItems(t, { lookups: l, today }, actions);
    const epicItem = find(items, 'Move to epic');
    expect(epicItem.hint).toBe('E20');
    expect(labels(epicItem.items!)).toEqual(['No epic', '# M10', 'E20', '# No milestone', 'E21']);
    find(epicItem.items!, 'No epic').onSelect!();
    expect(actions.update).toHaveBeenLastCalledWith(t, { epicId: null });
  });

  it('moves between non-archived projects with a success toast', () => {
    const actions = fakeActions();
    const t = task();
    const items = buildTaskActionItems(t, { lookups: l, today }, actions);
    const projectItem = find(items, 'Move to project');
    expect(projectItem.items!.filter(isAction).map((p) => p.hint)).toEqual(['WEB', 'APP']);
    find(projectItem.items!, 'Project APP').onSelect!();
    const [, patch, options] = actions.update.mock.calls[0]!;
    expect(patch).toEqual({ projectId: 2 });
    expect(typeof options?.success).toBe('function');
  });

  it('disables Move to project when there is nowhere to go', () => {
    const single = { ...l, projects: [project(1, 'WEB')] };
    const items = buildTaskActionItems(task(), { lookups: single, today }, fakeActions());
    expect(find(items, 'Move to project').disabled).toBe(true);
  });

  it('archives, unarchives, duplicates and deletes', () => {
    const actions = fakeActions();
    const onDeleted = vi.fn();
    const archived = task({ archivedAt: '2026-10-01T00:00:00.000Z' });
    const items = buildTaskActionItems(archived, { lookups: l, today }, actions, { onDeleted });
    find(items, 'Unarchive').onSelect!();
    expect(actions.setArchived).toHaveBeenCalledWith(archived, false);
    find(items, 'Duplicate').onSelect!();
    expect(actions.duplicate).toHaveBeenCalledWith(archived);
    const del = find(items, 'Delete…');
    expect(del.danger).toBe(true);
    del.onSelect!();
    expect(actions.delete).toHaveBeenCalledWith(archived, { onDeleted });
  });

  it('uses a custom open handler', () => {
    const actions = fakeActions();
    const onOpen = vi.fn();
    const t = task();
    find(buildTaskActionItems(t, { lookups: l, today }, actions, { onOpen }), 'Open').onSelect!();
    expect(onOpen).toHaveBeenCalledWith(t);
    expect(actions.open).not.toHaveBeenCalled();
  });

  it('only emits patches that the API schema accepts unchanged', () => {
    const actions = fakeActions();
    const t = task({ epicId: 20, milestoneId: 10, dueDate: '2026-10-20' });
    const visit = (items: MenuItem[]) => {
      for (const item of items.filter(isAction)) {
        if (item.items) visit(item.items);
        else if (!item.disabled) item.onSelect?.();
      }
    };
    visit(buildTaskActionItems(t, { lookups: l, today }, actions));
    expect(actions.update.mock.calls.length).toBeGreaterThan(10);
    for (const [, patch] of actions.update.mock.calls) {
      expect(taskUpdateInput.parse(patch)).toEqual(patch);
    }
  });
});
