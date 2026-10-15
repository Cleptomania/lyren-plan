import { describe, expect, it } from 'vitest';
import { STATUS_CATEGORIES, type StatusCategory } from '@shared/constants';
import { buildFilterContext, matchesTaskFilter } from '@shared/filter';
import { taskQueryInput } from '@shared/schemas';
import type { MilestoneDTO, ProjectDTO, StatusDTO, TaskDTO } from '@shared/types';
import { task } from '../../components/domain/fixtures.test-utils';
import {
  compareDashboardTasks,
  dashboardProjects,
  dashboardSectionFilter,
  dashboardSectionQuery,
  dueTomorrowHint,
  greetingFor,
  nextMilestone,
  type DashboardSection,
} from './dashboardModel';

const milestone = (id: number, patch: Partial<MilestoneDTO>): MilestoneDTO =>
  ({ id, status: 'planned', dueDate: null, position: id, ...patch }) as MilestoneDTO;

describe('dashboard helpers', () => {
  it('greets by time of day', () => {
    expect([0, 4, 5, 11, 12, 17, 18, 23].map(greetingFor)).toEqual([
      'Good evening',
      'Good evening',
      'Good morning',
      'Good morning',
      'Good afternoon',
      'Good afternoon',
      'Good evening',
      'Good evening',
    ]);
  });

  it('keeps active projects in order', () => {
    const projects = [
      { id: 1, status: 'active' },
      { id: 2, status: 'archived' },
      { id: 3, status: 'on_hold' },
      { id: 4, status: 'active' },
    ] as ProjectDTO[];
    expect(dashboardProjects(projects).map((p) => p.id)).toEqual([1, 4]);
  });

  it('picks the earliest due open milestone', () => {
    expect(nextMilestone(undefined)).toBeNull();
    expect(nextMilestone([milestone(1, {}), milestone(2, { status: 'completed', dueDate: '2026-01-01' })])).toBeNull();
    const list = [
      milestone(1, { dueDate: '2026-06-01' }),
      milestone(2, { dueDate: '2026-05-01', status: 'cancelled' }),
      milestone(3, { dueDate: '2026-05-10', status: 'active', position: 5 }),
      milestone(4, { dueDate: '2026-05-10', position: 2 }),
      milestone(5, {}),
    ];
    expect(nextMilestone(list)?.id).toBe(4);
  });

  it('counts tasks due tomorrow, with "+" when the truncated list may hold more', () => {
    const due = (...dates: string[]) => dates.map((dueDate) => ({ dueDate }));
    expect(dueTomorrowHint([], 0, '2026-10-15')).toBe('Nothing due tomorrow');
    expect(dueTomorrowHint(due('2026-10-16'), 1, '2026-10-15')).toBe('Nothing due tomorrow');
    expect(dueTomorrowHint(due('2026-10-15', '2026-10-15', '2026-10-17'), 3, '2026-10-15')).toBe('2 due tomorrow');
    // Truncated, but a later date is listed: every task due tomorrow is in the list.
    expect(dueTomorrowHint(due('2026-10-15', '2026-10-16'), 80, '2026-10-15')).toBe('1 due tomorrow');
    // Truncated and all listed tasks are due tomorrow: there may be more.
    expect(dueTomorrowHint(due('2026-10-15', '2026-10-15'), 80, '2026-10-15')).toBe('2+ due tomorrow');
    expect(dueTomorrowHint(due('2026-10-15', '2026-10-15'), 2, '2026-10-15')).toBe('2 due tomorrow');
  });
});

// ---- Full section lists ------------------------------------------------------------------------

const TODAY = '2026-10-14';
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const DAY = 86_400_000;
// One status per category: id = index + 1 (backlog 1, unstarted 2, started 3, completed 4, cancelled 5).
const statuses = STATUS_CATEGORIES.map((category, i) => ({ id: i + 1, category, position: i }) as StatusDTO);
const statusOf = (c: StatusCategory) => statuses.find((s) => s.category === c)!.id;
const ctx = buildFilterContext({
  statuses,
  projects: [{ id: 1, status: 'active' } as ProjectDTO],
  today: TODAY,
  weekStartsOn: 1,
  nowMs: NOW,
});
const SECTIONS: DashboardSection[] = ['overdue', 'dueToday', 'dueSoon', 'inProgress', 'recentlyClosed'];

describe('dashboard section queries', () => {
  // [title, task] — what each section must contain (server/src/routes/dashboard.ts).
  const t = (id: number, patch: Partial<TaskDTO>) => task({ id, ref: `WEB-${id}`, statusId: statusOf('unstarted'), ...patch });
  const closed = (id: number, daysAgo: number | null, patch: Partial<TaskDTO> = {}) =>
    t(id, { statusId: statusOf('completed'), completedAt: daysAgo === null ? null : new Date(NOW - daysAgo * DAY).toISOString(), ...patch });
  const tasks = [
    t(1, { dueDate: '2026-10-13' }), // overdue
    t(2, { dueDate: '2026-09-01', statusId: statusOf('started') }), // overdue + in progress
    closed(3, 1, { dueDate: '2026-10-01' }), // closed: not overdue, recently closed
    t(4, { dueDate: TODAY }), // due today
    closed(5, 30, { dueDate: TODAY }), // closed long ago: nowhere
    t(6, { dueDate: '2026-10-15' }), // due soon (tomorrow)
    t(7, { dueDate: '2026-10-21' }), // due soon (last day of the window)
    t(8, { dueDate: '2026-10-22' }), // beyond the window
    t(9, { statusId: statusOf('backlog'), dueDate: '2026-10-16' }), // backlog counts as open
    t(10, { dueDate: '2026-10-12', archivedAt: '2026-10-13T00:00:00.000Z' }), // archived: nowhere
    closed(11, null), // closed without completedAt counts as recent
  ];
  const ids = (section: DashboardSection) =>
    tasks.filter((x) => matchesTaskFilter(x, dashboardSectionFilter(section, TODAY), ctx)).map((x) => x.id);

  it('selects what each dashboard list holds', () => {
    expect(ids('overdue')).toEqual([1, 2]);
    expect(ids('dueToday')).toEqual([4]);
    expect(ids('dueSoon')).toEqual([6, 7, 9]);
    expect(ids('inProgress')).toEqual([2]);
    expect(ids('recentlyClosed')).toEqual([3, 11]);
  });

  it('builds valid POST /tasks/query inputs for the client date', () => {
    for (const section of SECTIONS) {
      const input = dashboardSectionQuery(section, TODAY, 200);
      expect(taskQueryInput.safeParse(input).success).toBe(true);
      expect(input).toMatchObject({ limit: 200, today: TODAY });
    }
    expect(dashboardSectionQuery('dueSoon', TODAY, 1).filter).toMatchObject({ dueFrom: '2026-10-15', dueTo: '2026-10-21' });
  });

  it('orders like the dashboard: due date, then urgency (no priority last), then manual order', () => {
    const list = [
      t(1, { dueDate: '2026-10-02', priority: 0, rank: 'a0' }),
      t(2, { dueDate: '2026-10-01', priority: 1, rank: 'a5' }),
      t(3, { dueDate: '2026-10-02', priority: 4, rank: 'a9' }),
      t(4, { dueDate: '2026-10-02', priority: 2, rank: 'a1' }),
      t(5, { dueDate: '2026-10-02', priority: 2, rank: 'a0' }),
      t(6, { dueDate: '2026-10-02', priority: 2, rank: 'a0' }),
    ];
    const order = (s: DashboardSection) => [...list].sort(compareDashboardTasks(s)).map((x) => x.id);
    expect(order('overdue')).toEqual([2, 3, 5, 6, 4, 1]);
    expect(order('dueSoon')).toEqual([2, 3, 5, 6, 4, 1]);
    expect(order('dueToday')).toEqual([3, 5, 6, 4, 2, 1]);
  });

  it('orders work in progress by latest update and closed work by latest completion', () => {
    const wip = [
      t(1, { updatedAt: '2026-10-10T00:00:00.000Z' }),
      t(2, { updatedAt: '2026-10-12T00:00:00.000Z' }),
      t(3, { updatedAt: '2026-10-10T00:00:00.000Z' }),
    ];
    expect([...wip].sort(compareDashboardTasks('inProgress')).map((x) => x.id)).toEqual([2, 3, 1]);
    const done = [closed(1, 2), closed(2, null), closed(3, 1), closed(4, 2)];
    expect([...done].sort(compareDashboardTasks('recentlyClosed')).map((x) => x.id)).toEqual([3, 4, 1, 2]);
  });
});
