// One activity entry rendered as a sentence (SPEC §9.1; used by ActivityFeed and the dashboard):
// actor avatar, "Alex changed status from Todo → In Progress", the task (link that opens the
// drawer; plain text once deleted), the project and a relative time.

import { clsx } from 'clsx';
import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import type { ActivityDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { TaskRef, UserAvatar } from '../../components/domain';
import { ColorDot } from '../../components/ui';
import { projectUrl, taskPageUrl, useOpenTask } from '../../lib/taskLinks';
import { activityDetail, activityPhrases, activityTask, actorName, joinList } from './activityText';
import { RelativeTime } from './RelativeTime';

export interface ActivityItemProps {
  entry: ActivityDTO;
  /** Denser single-line rendering. */
  compact?: boolean;
  /** Show the task ref/title link (default true). */
  showTask?: boolean;
  /** Show the project dot/name (default true). */
  showProject?: boolean;
}

/** True for a plain left click (modified clicks keep the link's default: new tab/window). */
function isPlainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function ActivityItem({ entry, compact = false, showTask = true, showProject = true }: ActivityItemProps) {
  const lookups = useLookups();
  const openTask = useOpenTask();
  const sentence = joinList(activityPhrases(entry, lookups));
  const task = showTask ? activityTask(entry) : null;
  const project = showProject && entry.projectId !== null ? lookups.projectById.get(entry.projectId) : undefined;
  const detail = compact ? null : activityDetail(entry);

  const taskLabel = task && (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      {task.ref && <TaskRef value={task.ref} className="text-[11px]" />}
      {task.title && <span className="min-w-0 truncate">{task.title}</span>}
    </span>
  );

  const taskNode =
    task && task.id !== null ? (
      <a
        href={taskPageUrl({ id: task.id, ref: task.ref ?? undefined })}
        onClick={(e) => {
          if (!isPlainClick(e)) return;
          e.preventDefault();
          openTask(task.id!);
        }}
        className="-my-1 inline-flex min-h-8 min-w-0 max-w-full items-center rounded py-1 text-fg hover:underline focus-visible:outline-offset-0 pointer-coarse:min-h-10"
      >
        {taskLabel}
      </a>
    ) : task ? (
      <span className="inline-flex min-w-0 max-w-full items-center text-fg-muted" title="This task was deleted">
        {taskLabel}
        <span className="sr-only"> (deleted)</span>
      </span>
    ) : null;

  const projectNode = project && (
    <Link
      to={projectUrl(project.id)}
      className="-my-1 inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded py-1 hover:text-fg hover:underline pointer-coarse:min-h-10"
    >
      <ColorDot color={project.color} square size="sm" />
      <span className="min-w-0 truncate">{project.name}</span>
    </Link>
  );

  const meta = (
    <div className={clsx('flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-muted', !compact && 'mt-0.5')}>
      {taskNode && <span className="flex min-w-0 max-w-full">{taskNode}</span>}
      {projectNode && <span className="flex min-w-0 max-w-[14rem]">{projectNode}</span>}
      <RelativeTime iso={entry.createdAt} className="text-fg-subtle" />
    </div>
  );

  return (
    <div className={clsx('flex min-w-0 gap-3', compact ? 'py-2' : 'py-3')}>
      <UserAvatar user={entry.actor} size={compact ? 'sm' : 'md'} className={compact ? 'mt-px' : undefined} />
      <div className="min-w-0 flex-1">
        <p className={clsx('break-words text-fg', compact ? 'line-clamp-2 text-[13px] leading-5' : 'text-sm leading-5')}>
          <span className="font-medium">{actorName(entry)}</span> <span className="text-fg-muted">{sentence}</span>
        </p>
        {detail && <p className="mt-1 line-clamp-2 break-words border-l-2 border-border pl-2 text-[13px] text-fg-muted">{detail}</p>}
        {meta}
      </div>
    </div>
  );
}
