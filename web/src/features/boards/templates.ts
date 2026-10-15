// Starting points for new boards (New board dialog). Pure: each template builds a partial
// BoardConfig that the server completes with defaults. Unit-tested in templates.test.ts.

import type { BoardConfigInput, CustomColumn } from '@shared/board';
import type { TagDTO } from '@shared/types';

export type BoardTemplateId = 'status' | 'priority' | 'due-week' | 'project-lanes' | 'epic' | 'custom' | 'blank';

export interface TemplateContext {
  /** Tags by name (a "blocked" tag adds a Blocked column to the custom starter). */
  tags: readonly Pick<TagDTO, 'id' | 'name'>[];
  /** The project of a project board; null for a global board. */
  projectId: number | null;
}

export interface BoardTemplate {
  id: BoardTemplateId;
  name: string;
  description: string;
  /** Only meaningful across projects (hidden for project boards). */
  globalOnly?: boolean;
  build: (ctx: TemplateContext) => BoardConfigInput;
}

type CustomColumnInput = Omit<CustomColumn, 'color'> & { color: string | null };

function customStarter(ctx: TemplateContext): CustomColumnInput[] {
  const blocked = ctx.tags.find((t) => t.name.trim().toLowerCase() === 'blocked');
  const cols: CustomColumnInput[] = [];
  if (blocked) {
    cols.push({
      id: 'blocked',
      name: 'Blocked',
      color: '#ef4444',
      match: { tagIds: [blocked.id] },
      onDrop: { addTagIds: [blocked.id] },
    });
  }
  cols.push(
    { id: 'now', name: 'Now', color: '#f97316', match: { priorities: [4, 3] }, onDrop: { priority: 3 } },
    { id: 'next', name: 'Next', color: '#3b82f6', match: { priorities: [2] }, onDrop: { priority: 2 } },
    { id: 'later', name: 'Later', color: '#64748b', match: { priorities: [1, 0] }, onDrop: { priority: 1 } },
  );
  return cols;
}

/** Card fields: the project badge is redundant on a project board. */
function fields(ctx: TemplateContext, extra: Record<string, boolean> = {}): Record<string, boolean> {
  return { ...(ctx.projectId === null ? {} : { project: false }), ...extra };
}

export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  {
    id: 'status',
    name: 'Status board',
    description: 'A column per status; closed tasks drop off after two weeks.',
    build: (ctx) => ({
      filter: { closedWithinDays: 14 },
      columns: { groupBy: 'status' },
      card: { colorBy: ctx.projectId === null ? 'project' : 'epic', fields: fields(ctx) },
    }),
  },
  {
    id: 'priority',
    name: 'Priority triage',
    description: 'Open work by priority, urgent first. Closed tasks hide after 7 days.',
    build: (ctx) => ({
      filter: { closedWithinDays: 7 },
      columns: { groupBy: 'priority' },
      swimlanes: { groupBy: ctx.projectId === null ? 'project' : 'none' },
      card: { colorBy: ctx.projectId === null ? 'project' : 'epic', fields: fields(ctx, { status: true }) },
    }),
  },
  {
    id: 'due-week',
    name: 'Due this week',
    description: 'Overdue, today, tomorrow and the rest of the week. Drag to reschedule.',
    build: (ctx) => ({
      filter: { due: ['overdue', 'today', 'tomorrow', 'this_week'], closedWithinDays: 0 },
      sort: { field: 'priority', dir: 'desc' },
      columns: {
        groupBy: 'due',
        prefs: { due: { order: [], hidden: ['past', 'next_week', 'later', 'no_date'], collapsed: [], wipLimits: {} } },
      },
      card: { fields: fields(ctx, { status: true, dueDate: true }) },
    }),
  },
  {
    id: 'project-lanes',
    name: 'Per-project lanes',
    description: 'Status categories as columns with one lane per project.',
    globalOnly: true,
    build: () => ({
      filter: { closedWithinDays: 14 },
      columns: { groupBy: 'statusCategory' },
      swimlanes: { groupBy: 'project' },
      card: { fields: { project: false, status: true } },
    }),
  },
  {
    id: 'epic',
    name: 'By epic',
    description: 'A column per epic (plus “No epic”) to see how work is spread.',
    build: (ctx) => ({
      filter: { closedWithinDays: 14 },
      columns: { groupBy: 'epic' },
      card: { fields: fields(ctx, { epic: false, status: true }) },
    }),
  },
  {
    id: 'custom',
    name: 'Custom columns starter',
    description: 'Now / Next / Later by priority (and Blocked when you have that tag). Edit them freely.',
    build: (ctx) => ({
      filter: { closedWithinDays: 0 },
      columns: { groupBy: 'custom', custom: customStarter(ctx), showUnmatched: true },
      card: { fields: fields(ctx, { status: true }) },
    }),
  },
  {
    id: 'blank',
    name: 'Blank',
    description: 'Status columns and no filters at all (closed tasks included).',
    build: (ctx) => ({ filter: {}, card: { fields: fields(ctx) } }),
  },
];

/** Templates offered for a global board (projectId null) or a project board. */
export function templatesFor(projectId: number | null): BoardTemplate[] {
  return BOARD_TEMPLATES.filter((t) => projectId === null || !t.globalOnly);
}

export function findTemplate(id: string): BoardTemplate | undefined {
  return BOARD_TEMPLATES.find((t) => t.id === id);
}
