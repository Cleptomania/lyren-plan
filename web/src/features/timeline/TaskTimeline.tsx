// Rendered inside the task detail (drawer and full page) below the task fields:
// Comments (default) · Work log · History, each with a count (SPEC §9.1).

import { useState } from 'react';
import type { TaskDTO } from '@shared/types';
import { useTaskTimeline } from '../../api/timeline';
import { ErrorState, SegmentedControl, useOverlayControls } from '../../components/ui';
import { CommentsPanel } from './CommentsPanel';
import { HistoryPanel } from './HistoryPanel';
import { WorklogPanel } from './WorklogPanel';

export interface TaskTimelineProps {
  task: TaskDTO;
}

type TimelineTab = 'comments' | 'worklog' | 'history';

function TabLabel({ label, count }: { label: string; count: number | undefined }) {
  return (
    <>
      {label}
      {count !== undefined && <span className="ml-1 tabular-nums text-fg-subtle">{count}</span>}
    </>
  );
}

export function TaskTimeline({ task }: TaskTimelineProps) {
  const timeline = useTaskTimeline(task.id);
  const [tab, setTab] = useState<TimelineTab>('comments');
  // Inside the task drawer (or any overlay) the comment composer sticks to the bottom of the
  // scroll container; on the full task page it simply follows the comments.
  const inOverlay = useOverlayControls() !== null;
  const data = timeline.data;

  const failed = !data && timeline.isError;

  return (
    <section aria-label="Comments, work log and history" className="flex min-w-0 flex-col gap-3">
      <SegmentedControl<TimelineTab>
        aria-label="Timeline section"
        value={tab}
        onChange={setTab}
        fullWidth
        // Size segments to their labels (then share the rest): equal thirds cut "Comments 12"
        // at 360px while "History" has room to spare.
        className="max-w-md [&>button]:flex-auto"
        options={[
          { value: 'comments', label: <TabLabel label="Comments" count={data?.comments.length ?? task.commentCount} /> },
          { value: 'worklog', label: <TabLabel label="Work log" count={data?.worklogs.length} /> },
          { value: 'history', label: <TabLabel label="History" count={data?.activity.length} /> },
        ]}
      />
      {failed ? (
        <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} size="sm" />
      ) : tab === 'comments' ? (
        <CommentsPanel key={task.id} taskId={task.id} comments={data?.comments} stickyComposer={inOverlay} />
      ) : tab === 'worklog' ? (
        <WorklogPanel key={task.id} task={task} worklogs={data?.worklogs} />
      ) : (
        <HistoryPanel key={task.id} entries={data?.activity} />
      )}
    </section>
  );
}
