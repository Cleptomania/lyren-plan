// Activity feed (global or per project): newest first, grouped by day, "Load more" paging
// through GET /api/activity (useActivityFeed infinite query).

import { clsx } from 'clsx';
import { History } from 'lucide-react';
import { useId } from 'react';
import { useActivityFeed } from '../../api/timeline';
import { useSharedToday } from '../../components/domain';
import { Button, EmptyState, ErrorState, Skeleton, toast } from '../../components/ui';
import { dayHeading, isoToLocalDate } from '../../lib/format';
import { groupByDay } from './activityGroups';
import { ActivityItem } from './ActivityItem';

export interface ActivityFeedProps {
  /** Restrict to one project's activity. */
  projectId?: number;
  /** Page size (default 30). */
  limit?: number;
  /** Denser rendering for sidebars/dashboard cards. */
  compact?: boolean;
  /** Show a "Load more" button for older entries (default true). */
  paginate?: boolean;
}

function FeedSkeleton({ rows, compact }: { rows: number; compact: boolean }) {
  return (
    <div role="status" className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={clsx('flex gap-3', compact ? 'py-2' : 'py-3')}>
          <Skeleton className={clsx('shrink-0 rounded-full', compact ? 'size-6' : 'size-8')} />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <Skeleton className={clsx('h-3.5', ['w-3/4', 'w-1/2', 'w-2/3'][i % 3])} />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading activity</span>
    </div>
  );
}

export function ActivityFeed({ projectId, limit = 30, compact = false, paginate = true }: ActivityFeedProps) {
  const feed = useActivityFeed({ projectId, limit });
  const today = useSharedToday();
  const headingId = useId();

  if (!feed.data) {
    if (feed.isError) return <ErrorState error={feed.error} onRetry={() => void feed.refetch()} size={compact ? 'sm' : 'md'} />;
    return <FeedSkeleton rows={compact ? 4 : 6} compact={compact} />;
  }

  const pages = paginate ? feed.data.pages : feed.data.pages.slice(0, 1);
  const items = pages.flatMap((p) => p.items);
  if (items.length === 0) {
    return (
      <EmptyState
        size={compact ? 'sm' : 'md'}
        icon={<History />}
        title="No activity yet"
        body={
          projectId !== undefined
            ? 'Changes to this project, its milestones, epics and tasks will show up here.'
            : 'Changes to projects, tasks, comments and work logs will show up here.'
        }
      />
    );
  }

  const days = groupByDay(items, (e) => isoToLocalDate(e.createdAt));
  const loadMore = async () => {
    const result = await feed.fetchNextPage();
    if (result.isError) toast.error(result.error);
  };

  return (
    <div className="flex min-w-0 flex-col">
      {days.map((day, i) => (
        <section key={`${day.date}-${i}`} aria-labelledby={`${headingId}-${i}`} className={clsx(i > 0 && (compact ? 'mt-2' : 'mt-4'))}>
          <h3
            id={`${headingId}-${i}`}
            className={clsx(
              'font-semibold text-fg-muted',
              compact ? 'pt-1 text-[11px] uppercase tracking-wide' : 'border-b border-border pb-1.5 text-[13px]',
            )}
          >
            {dayHeading(day.date, today)}
          </h3>
          <ol className={clsx('flex flex-col', !compact && 'divide-y divide-border')}>
            {day.items.map((entry) => (
              <li key={entry.id}>
                <ActivityItem entry={entry} compact={compact} showProject={projectId === undefined} />
              </li>
            ))}
          </ol>
        </section>
      ))}
      {paginate && feed.hasNextPage && (
        <div className={clsx('flex justify-center', compact ? 'pt-2' : 'pt-4')}>
          <Button size={compact ? 'sm' : 'md'} onClick={() => void loadMore()} loading={feed.isFetchingNextPage}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
