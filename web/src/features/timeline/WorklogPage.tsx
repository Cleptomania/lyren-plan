// /worklog — time logged across tasks for a date range: presets (honouring the week start),
// project filter, range total, entries by day with daily totals and per-project totals.

import { clsx } from 'clsx';
import { CalendarRange, Clock } from 'lucide-react';
import type { MouseEvent } from 'react';
import { useSearchParams } from 'react-router';
import { formatMinutes } from '@shared/duration';
import type { ISODate } from '@shared/dates';
import { useLookups } from '../../api/bootstrap';
import { useWorklogReport } from '../../api/timeline';
import { useSpaceId } from '../../app/space';
import { TaskRef, useSharedToday } from '../../components/domain';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card, ColorDot, DateInput, EmptyState, ErrorState, Field, Select, Skeleton, SkeletonList } from '../../components/ui';
import { dayHeading, pluralize } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { personText } from '../../lib/people';
import { ImportedNote } from './ImportedNote';
import { taskPageUrl, useOpenTask } from '../../lib/taskLinks';
import { ProjectFilter, useProjectParam } from './ProjectFilter';
import {
  formatRange,
  RANGE_PRESET_LABELS,
  RANGE_PRESETS,
  reportDays,
  reportProjects,
  resolveRange,
  type DateRange,
  type RangePreset,
  type ReportItem,
} from './worklogReport';

/** URL state: ?range=<preset>&from=&to= (custom) &project=<id>. */
function useRangeParams(today: ISODate, weekStartsOn: 0 | 1) {
  const [params, setParams] = useSearchParams();
  const resolved = resolveRange({ range: params.get('range'), from: params.get('from'), to: params.get('to') }, today, weekStartsOn);
  const update = (preset: RangePreset, range?: DateRange) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('range', preset);
        if (preset === 'custom' && range) {
          next.set('from', range.from);
          next.set('to', range.to);
        } else {
          next.delete('from');
          next.delete('to');
        }
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  return { ...resolved, update };
}

export default function WorklogPage() {
  useDocumentTitle('Work log');
  const { settings, projectById } = useLookups();
  const today = useSharedToday();
  const { preset, range, update } = useRangeParams(today, settings.weekStartsOn);
  const [projectId, setProjectId] = useProjectParam();
  const report = useWorklogReport({ from: range.from, to: range.to, projectId, today });

  const setPreset = (next: RangePreset) => (next === 'custom' ? update('custom', range) : update(next));
  const setCustom = (patch: Partial<DateRange>) => {
    const next = { ...range, ...patch };
    update('custom', next.from <= next.to ? next : { from: next.to, to: next.from });
  };

  const filters = (
    <div className="flex min-w-0 flex-wrap items-end gap-2 pb-3">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
        <Select
          aria-label="Date range"
          size="sm"
          value={preset}
          onChange={(e) => setPreset(e.target.value as RangePreset)}
          options={RANGE_PRESETS.map((p) => ({ value: p, label: RANGE_PRESET_LABELS[p] }))}
        />
      </div>
      <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">
        <ProjectFilter value={projectId} onChange={setProjectId} />
      </div>
      {preset === 'custom' && (
        <div className="flex w-full min-w-0 items-end gap-2 sm:w-auto">
          <Field label="From" className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <DateInput size="sm" value={range.from} onChange={(from) => from && setCustom({ from })} clearable={false} />
          </Field>
          <Field label="To" className="min-w-0 flex-1 sm:w-40 sm:flex-none">
            <DateInput size="sm" value={range.to} onChange={(to) => to && setCustom({ to })} clearable={false} />
          </Field>
        </div>
      )}
    </div>
  );

  const project = projectId !== undefined ? projectById.get(projectId) : undefined;
  const subtitle = `${formatRange(range, today)}${project ? ` · ${project.name}` : ''}`;

  return (
    <Page
      width="default"
      header={
        <PageHeader title="Work log" subtitle={subtitle}>
          {filters}
        </PageHeader>
      }
    >
      {report.data ? (
        <WorklogReportView items={report.data.items} totalMinutes={report.data.totalMinutes} range={range} today={today} showProjects={projectId === undefined} fetching={report.isFetching} />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        <ReportSkeleton />
      )}
    </Page>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status">
      <Skeleton className="h-20 w-full rounded-lg" />
      <SkeletonList rows={5} withIcon />
      <span className="sr-only">Loading work log</span>
    </div>
  );
}

interface ReportViewProps {
  items: ReportItem[];
  totalMinutes: number;
  range: DateRange;
  today: ISODate;
  showProjects: boolean;
  fetching: boolean;
}

function WorklogReportView({ items, totalMinutes, range, today, showProjects, fetching }: ReportViewProps) {
  const { projectById } = useLookups();

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Clock />}
        title="No time logged in this period"
        body={
          <>
            Time is logged from a task: open it and use <span className="font-medium text-fg">Work log → Log time</span>. Entries
            from {formatRange(range, today)} will show up here.
          </>
        }
      />
    );
  }

  const days = reportDays(items);
  const projects = showProjects ? reportProjects(items) : [];

  return (
    <div className={clsx('grid min-w-0 gap-6 transition-opacity md:grid-cols-[minmax(0,1fr)_16rem]', fetching && 'opacity-70')} aria-busy={fetching || undefined}>
      <aside aria-label="Totals" className="flex min-w-0 flex-col gap-3 md:order-2">
        <Card padding="sm" className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-medium text-fg-muted">Total</p>
            <p className="text-2xl font-semibold tabular-nums text-fg">{formatMinutes(totalMinutes)}</p>
            <p className="text-xs text-fg-muted">
              {pluralize(items.length, 'entry', 'entries')} · {pluralize(days.length, 'day')}
            </p>
          </div>
          {projects.length > 0 && (
            <ul aria-label="By project" className="flex flex-col gap-2 border-t border-border pt-3">
              {projects.map((p) => {
                const proj = projectById.get(p.projectId);
                const share = totalMinutes > 0 ? (p.minutes / totalMinutes) * 100 : 0;
                return (
                  <li key={p.projectId} className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2 text-[13px]">
                      <ColorDot color={proj?.color ?? 'var(--fg-subtle)'} square />
                      <span className="min-w-0 flex-1 truncate text-fg">{proj?.name ?? 'Unknown project'}</span>
                      <span className="shrink-0 font-medium tabular-nums text-fg">{formatMinutes(p.minutes)}</span>
                    </div>
                    <div aria-hidden className="h-1 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full" style={{ width: `${share}%`, backgroundColor: proj?.color ?? 'var(--fg-subtle)' }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </aside>

      <div className="flex min-w-0 flex-col gap-5 md:order-1">
        {days.map((day) => (
          <section key={day.date} aria-label={dayHeading(day.date, today)} className="min-w-0">
            <h2 className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 text-[13px] font-semibold text-fg-muted">
              <span className="flex items-center gap-1.5">
                <CalendarRange aria-hidden className="size-3.5 text-fg-subtle" />
                {dayHeading(day.date, today)}
              </span>
              <span className="tabular-nums text-fg">{formatMinutes(day.minutes)}</span>
            </h2>
            <ol className="flex min-w-0 flex-col divide-y divide-border">
              {day.items.map((item) => (
                <li key={item.id}>
                  <ReportEntry item={item} />
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}

function ReportEntry({ item }: { item: ReportItem }) {
  const sid = useSpaceId();
  const { projectById, user, personById } = useLookups();
  const openTask = useOpenTask();
  const project = projectById.get(item.task.projectId);
  const duration = item.minutes !== null && item.minutes > 0 ? formatMinutes(item.minutes) : null;

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openTask(item.task.id);
  };

  return (
    <div className="flex min-w-0 items-start gap-3 py-2.5">
      <ColorDot color={project?.color ?? 'var(--fg-subtle)'} square label={project?.name} className="mt-[7px]" />
      <div className="min-w-0 flex-1">
        <a
          href={taskPageUrl(sid, item.task)}
          onClick={onClick}
          className="-my-1 flex min-h-8 min-w-0 items-baseline gap-2 rounded py-1 text-sm text-fg hover:underline pointer-coarse:min-h-10"
        >
          <TaskRef value={item.task.ref} />
          <span className="min-w-0 truncate">{item.task.title}</span>
        </a>
        {item.note && <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-[13px] text-fg-muted">{item.note}</p>}
        {item.author?.id !== user.id && <p className="mt-0.5 text-xs text-fg-subtle">{personText(item.author, personById)}</p>}
        <ImportedNote entry={item} className="mt-0.5" />
      </div>
      <span className={clsx('shrink-0 pt-0.5 text-sm tabular-nums', duration ? 'font-semibold text-fg' : 'text-fg-subtle')}>
        {duration ?? '—'}
        {!duration && <span className="sr-only">no time, note only</span>}
      </span>
    </div>
  );
}
