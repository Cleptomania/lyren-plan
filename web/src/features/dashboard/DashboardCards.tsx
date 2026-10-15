// Building blocks of the dashboard: summary tiles, task sections, the projects and recent
// activity cards, and their compact empty / loading states.

import { clsx } from 'clsx';
import { Activity, CircleAlert, FolderKanban, Milestone as MilestoneIcon } from 'lucide-react';
import { forwardRef, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ActivityDTO, MilestoneDTO, ProjectDTO, TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { DueDateLabel, TaskRow, type CardFields, type RowHideKey } from '../../components/domain';
import { Badge, ButtonLink, Card, ColorDot, ProgressBar, Skeleton, SkeletonList, Spinner } from '../../components/ui';
import { percent } from '../../lib/format';
import { projectUrl } from '../../lib/taskLinks';
import { ActivityItem } from '../timeline/ActivityItem';
import { dashboardProjects, nextMilestone, type DashboardSection } from './dashboardModel';
import { SECTION_PAGE, useFullSection } from './useFullSection';
import { useTaskOverlay } from './useTaskOverlay';

export type Tone = 'danger' | 'warning' | 'accent' | 'success' | 'neutral';

const TONE_ICON: Record<Tone, string> = {
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  neutral: 'bg-surface-2 text-fg-muted',
};

function ToneIcon({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span aria-hidden className={clsx('flex shrink-0 items-center justify-center rounded-md [&_svg]:size-4', TONE_ICON[tone], className)}>
      {children}
    </span>
  );
}

/** Scroll to a dashboard section and move focus to its heading (instead of a hash navigation). */
function jumpToSection(e: MouseEvent<HTMLAnchorElement>, id: string): void {
  const section = document.getElementById(id);
  if (!section || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  document.getElementById(`${id}-heading`)?.focus({ preventScroll: true });
}

// ---- Summary tiles ---------------------------------------------------------------------------

export interface StatTileProps {
  label: string;
  value: string;
  /** Spoken after the value ("3 tasks"). */
  unit?: string;
  hint?: ReactNode;
  icon: ReactNode;
  tone: Tone;
  /** Highlight the value (e.g. overdue > 0). */
  emphasize?: boolean;
  /** In-page section id, or a route. */
  target: { section: string } | { to: string };
}

export function StatTile({ label, value, unit, hint, icon, tone, emphasize, target }: StatTileProps) {
  const className = clsx(
    'group flex h-full min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-surface p-3 shadow-card transition-colors md:p-4',
    'hover:border-border-strong active:bg-surface-2',
  );
  const body = (
    <>
      <span className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 pt-1 text-[13px] font-medium leading-tight text-fg-muted">{label}</span>
        <ToneIcon tone={tone} className="size-7">
          {icon}
        </ToneIcon>
      </span>
      <span
        className={clsx(
          'text-2xl font-semibold leading-tight tabular-nums md:text-[28px]',
          emphasize ? (tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-fg') : 'text-fg',
        )}
      >
        {value}
        {unit && <span className="sr-only"> {unit}</span>}
      </span>
      {hint && <span className="truncate text-xs text-fg-subtle">{hint}</span>}
    </>
  );
  if ('to' in target) {
    return (
      <Link to={target.to} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <a href={`#${target.section}`} onClick={(e) => jumpToSection(e, target.section)} className={className}>
      {body}
    </a>
  );
}

// ---- Card scaffolding ------------------------------------------------------------------------

function CardHead({ id, title, icon, tone, count, action }: { id: string; title: string; icon: ReactNode; tone: Tone; count?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex min-h-14 items-center gap-2.5 px-4 py-2.5">
      <ToneIcon tone={tone} className="size-7">
        {icon}
      </ToneIcon>
      <h2 id={`${id}-heading`} tabIndex={-1} className="min-w-0 truncate text-sm font-semibold text-fg outline-none">
        {title}
      </h2>
      {count}
      {action && <div className="-mr-2 ml-auto flex shrink-0 items-center">{action}</div>}
    </header>
  );
}

/** Compact, friendly empty state inside a dashboard card. */
export function SectionEmpty({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-t border-border px-4 py-4">
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-fg-subtle [&_svg]:size-4">
        {icon}
      </span>
      <p className="text-sm text-fg-muted">{children}</p>
    </div>
  );
}

// ---- Task sections ---------------------------------------------------------------------------

const PREVIEW_ROWS = 5;

/**
 * Rows in the dashboard's narrower columns: ref, priority, status, title, tags, project, due.
 * Epic, estimate and comment count are dropped so titles keep room.
 */
const DASHBOARD_ROW_FIELDS: Partial<CardFields> = { epic: false, estimate: false, commentCount: false };

export interface TaskSectionProps {
  /** Anchor id (stat tiles link here). */
  id: string;
  /** Which dashboard list this is (its filter loads the rest of a truncated list). */
  section: DashboardSection;
  title: string;
  icon: ReactNode;
  tone: Tone;
  /** The list from GET /api/dashboard (capped). */
  tasks: TaskDTO[];
  /** Uncapped number of matching tasks (DashboardDTO.counts): more than `tasks` when truncated. */
  total: number;
  today: string;
  empty: { icon: ReactNode; text: ReactNode };
  fields?: Partial<CardFields>;
  hide?: RowHideKey[];
}

/**
 * A card of task rows: the first PREVIEW_ROWS, then "Show N more" for the rest. A list the
 * server truncated loads in full when expanded (rendered a page at a time), so every task is
 * reachable.
 */
export function TaskSection({ id, section, title, icon, tone, tasks, total, today, empty, fields, hide }: TaskSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const live = useTaskOverlay();
  const full = useFullSection(section, today, expanded && total > tasks.length);
  const rows = expanded ? (full.tasks ?? tasks) : tasks.slice(0, PREVIEW_ROWS);
  // Rows not on screen: of the loaded section while expanded, else of the dashboard's total.
  const hidden = expanded && full.tasks ? full.remaining : Math.max(0, Math.max(total, tasks.length) - rows.length);
  const listId = `${id}-list`;

  // After "Show fewer" the long list is gone: bring its button back into view. After the last
  // page loads its "Show more" button is gone: keep keyboard focus in the card (on the toggle).
  const toggleRef = useRef<HTMLButtonElement>(null);
  const after = useRef<'collapse' | 'more' | null>(null);
  useLayoutEffect(() => {
    const pending = after.current;
    if (pending === null || full.loading) return;
    after.current = null;
    const toggle = toggleRef.current;
    if (!toggle) return;
    if (pending === 'collapse') {
      // Centred, so neither a sticky header nor the phone tab bar covers it.
      const r = toggle.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) toggle.scrollIntoView({ block: 'center' });
    } else if (!document.activeElement || document.activeElement === document.body) toggle.focus();
  });

  const collapse = () => {
    setExpanded(false);
    full.reset();
    after.current = 'collapse';
  };

  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24">
      <Card padding="none" className="overflow-hidden">
        <CardHead
          id={id}
          title={title}
          icon={icon}
          tone={tone}
          count={
            <Badge variant={total > 0 ? tone : 'neutral'} className="tabular-nums">
              {total}
              <span className="sr-only"> {total === 1 ? 'task' : 'tasks'}</span>
            </Badge>
          }
        />
        {tasks.length === 0 ? (
          <SectionEmpty icon={empty.icon}>{empty.text}</SectionEmpty>
        ) : (
          <div id={listId} className="divide-y divide-border border-t border-border">
            {rows.map((task) => (
              <TaskRow key={task.id} task={live(task)} compact fields={{ ...DASHBOARD_ROW_FIELDS, ...fields }} hide={hide} />
            ))}
          </div>
        )}
        {(expanded || hidden > 0) && (
          <div className="flex border-t border-border">
            <FooterButton
              ref={toggleRef}
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={expanded ? collapse : () => setExpanded(true)}
            >
              {expanded ? 'Show fewer' : `Show ${hidden} more`}
            </FooterButton>
            {expanded && hidden > 0 && (
              <FooterButton
                aria-controls={listId}
                // Not `disabled`: that would drop keyboard focus while the page loads.
                aria-disabled={full.loading || undefined}
                aria-busy={full.loading || undefined}
                onClick={() => {
                  if (full.loading) return;
                  after.current = 'more';
                  if (full.failed) full.retry();
                  else full.more();
                }}
                className={clsx('border-l border-border', full.failed && 'text-danger hover:text-danger')}
              >
                {full.loading ? (
                  <>
                    <Spinner size="xs" label={null} />
                    Loading {Math.min(hidden, SECTION_PAGE)} more…
                  </>
                ) : full.failed ? (
                  'Couldn’t load. Retry'
                ) : (
                  `Show ${Math.min(hidden, SECTION_PAGE)} more`
                )}
              </FooterButton>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}

/** Full-width footer button of a dashboard card ("Show 12 more"). */
const FooterButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(function FooterButton(
  { className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={clsx(
        'flex h-10 min-w-0 flex-1 items-center justify-center gap-2 whitespace-nowrap px-3 text-[13px] font-medium text-fg-muted transition-colors',
        'hover:bg-surface-2 hover:text-fg focus-visible:-outline-offset-2 aria-disabled:cursor-default aria-disabled:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </button>
  );
});

function ShowMoreButton({ expanded, more, controls, onToggle }: { expanded: boolean; more: number; controls: string; onToggle: () => void }) {
  return (
    <div className="flex border-t border-border">
      <FooterButton aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
        {expanded ? 'Show fewer' : `Show ${more} more`}
      </FooterButton>
    </div>
  );
}

export function TaskSectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Card padding="none">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-4 w-28" />
      </div>
      <SkeletonList rows={rows} className="border-t border-border px-3" />
    </Card>
  );
}

// ---- Projects --------------------------------------------------------------------------------

const PROJECT_ROWS = 6;

export function ProjectsCard({ today }: { today: string }) {
  const { projects, milestonesByProject } = useLookups();
  const active = dashboardProjects(projects);
  const shown = active.slice(0, PROJECT_ROWS);
  return (
    <section aria-labelledby="projects-heading">
      <Card padding="none" className="overflow-hidden">
        <CardHead
          id="projects"
          title="Projects"
          icon={<FolderKanban />}
          tone="neutral"
          action={
            <ButtonLink to="/projects" variant="ghost" size="sm">
              {active.length > PROJECT_ROWS ? `All ${active.length}` : 'All projects'}
            </ButtonLink>
          }
        />
        {active.length === 0 ? (
          <SectionEmpty icon={<FolderKanban />}>
            No active projects. <Link to="/projects" className="font-medium text-accent hover:underline">Start one</Link> to see its
            progress here.
          </SectionEmpty>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {shown.map((p) => (
              <ProjectRow key={p.id} project={p} milestone={nextMilestone(milestonesByProject.get(p.id))} today={today} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function ProjectRow({ project, milestone, today }: { project: ProjectDTO; milestone: MilestoneDTO | null; today: string }) {
  const { tasksTotal, tasksClosed, tasksOpen, tasksOverdue } = project.stats;
  const pct = percent(tasksClosed, tasksTotal);
  return (
    <li>
      <Link
        to={projectUrl(project.id)}
        className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2 active:bg-surface-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ColorDot color={project.color} size="md" square />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{project.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{project.key}</span>
        </span>
        <ProgressBar value={tasksClosed} total={tasksTotal} color={project.color} aria-label={`${project.name}: ${pct}% done`} />
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
          <span className="tabular-nums">{tasksTotal === 0 ? 'No tasks yet' : `${pct}% done`}</span>
          {tasksTotal > 0 && <span className="tabular-nums">{tasksOpen} open</span>}
          {tasksOverdue > 0 && (
            <span className="inline-flex items-center gap-1 font-medium text-danger tabular-nums">
              <CircleAlert aria-hidden className="size-3" />
              {tasksOverdue} overdue
            </span>
          )}
          {milestone && (
            <span className="inline-flex min-w-0 max-w-full items-center gap-1">
              <MilestoneIcon aria-hidden className="size-3 shrink-0" />
              <span className="sr-only">Next milestone:</span>
              <span className="min-w-0 truncate">{milestone.name}</span>
              <DueDateLabel date={milestone.dueDate} today={today} plain />
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

// ---- Recent activity -------------------------------------------------------------------------

const PREVIEW_ACTIVITY = 6;

export function ActivityCard({ items }: { items: ActivityDTO[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, PREVIEW_ACTIVITY);
  const more = items.length - PREVIEW_ACTIVITY;
  return (
    <section aria-labelledby="activity-heading">
      <Card padding="none" className="overflow-hidden">
        <CardHead
          id="activity"
          title="Recent activity"
          icon={<Activity />}
          tone="neutral"
          action={
            <ButtonLink to="/activity" variant="ghost" size="sm">
              View all
            </ButtonLink>
          }
        />
        {items.length === 0 ? (
          <SectionEmpty icon={<Activity />}>Changes to your projects and tasks will show up here.</SectionEmpty>
        ) : (
          <ul id="activity-list" className="divide-y divide-border border-t border-border">
            {shown.map((entry) => (
              <li key={entry.id} className="min-w-0 px-4 py-0.5">
                <ActivityItem entry={entry} compact />
              </li>
            ))}
          </ul>
        )}
        {more > 0 && <ShowMoreButton expanded={expanded} more={more} controls="activity-list" onToggle={() => setExpanded((e) => !e)} />}
      </Card>
    </section>
  );
}
