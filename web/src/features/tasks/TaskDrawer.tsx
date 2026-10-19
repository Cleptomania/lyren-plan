// Task drawer content (lazy chunk of TaskDrawerHost). ≥ md: a NON-modal right panel — the
// page stays interactive, clicking another card swaps the task, Esc closes it when it is the
// top overlay. < md: a modal full-screen sheet with ←, the ref and "⋯". The URL (?task=)
// owns the open state and its history entry, so the kit Drawer gets history={false}.

import { ArrowLeft, Link2, Maximize2, SearchX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { TaskDTO } from '@shared/types';
import { ApiError } from '../../api/client';
import { useTask } from '../../api/tasks';
import { useSpaceId } from '../../app/space';
import { TaskActionsMenu } from '../../components/domain';
import {
  Button,
  Drawer,
  EmptyState,
  ErrorState,
  IconButton,
  Skeleton,
  SkeletonText,
  Spinner,
  Tooltip,
  iconButtonClasses,
  type MenuItem,
} from '../../components/ui';
import { useIsMobile } from '../../lib/hooks';
import { taskPageUrl, useCloseTask } from '../../lib/taskLinks';
import { copyTaskLink, detailMenuItems, TaskDetail, type TaskDetailHandle } from './TaskDetail';
import { useTaskSaving } from './useTaskSave';

export interface TaskDrawerProps {
  /** The task in ?task=, or null when the drawer should close. */
  taskId: number | null;
}

export default function TaskDrawer({ taskId }: TaskDrawerProps) {
  const closeTask = useCloseTask();
  const isMobile = useIsMobile();
  // Keep showing the last task while the drawer animates out.
  const [shownId, setShownId] = useState(taskId);
  if (taskId !== null && taskId !== shownId) setShownId(taskId);
  const id = taskId ?? shownId;
  const open = taskId !== null;
  // This component stays mounted after closing: only fetch while open, so the last task isn't
  // refetched after every task change (or into a 404 once it is deleted).
  const query = useTask(id, { enabled: open });
  const task = query.data?.id === id ? query.data : undefined;

  const detailRef = useRef<TaskDetailHandle>(null);
  const initialFocus = useMemo(
    () => ({
      get current(): HTMLElement | null {
        return detailRef.current?.focusTarget() ?? null;
      },
      set current(_value: HTMLElement | null) {
        // read-only
      },
    }),
    [],
  );

  // On a cold open the title only exists once the task loaded: move focus there if it is
  // still on the panel (never steal it when the user swaps tasks from the page).
  const focusPending = useRef(false);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) focusPending.current = true;
  wasOpen.current = open;
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusPending.current || !task) return;
    // Check on the next frame: the drawer's focus manager moves focus in on a frame too, and a
    // fast fetch can land before it does (focus would then end on the panel, not the title).
    const frame = requestAnimationFrame(() => {
      focusPending.current = false;
      const panel = contentRef.current?.closest<HTMLElement>('[role="dialog"]');
      const active = document.activeElement;
      if (!panel || active === panel || active === document.body || active === null) {
        detailRef.current?.focusTarget()?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [task]);

  let body;
  if (task) {
    body = <TaskDetail key={task.id} ref={detailRef} task={task} variant="drawer" />;
  } else if (query.error instanceof ApiError && query.error.status === 404) {
    body = (
      <EmptyState
        icon={<SearchX />}
        title="Task not found"
        body="It may have been deleted, or the link is wrong."
        action={<Button onClick={closeTask}>Close</Button>}
      />
    );
  } else if (query.error) {
    body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else {
    body = (
      <div className="flex flex-col gap-5" aria-busy>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-4/5" />
        <SkeletonText lines={6} />
      </div>
    );
  }

  return (
    <Drawer
      open={open}
      onClose={closeTask}
      modal={false}
      history={false}
      width="36rem"
      initialFocus={initialFocus}
      aria-label={task ? `${task.ref}: ${task.title}` : 'Task'}
      header={<DrawerHeader task={task} loading={!task && !query.error} isMobile={isMobile} onClose={closeTask} />}
      bodyClassName="pb-safe-3"
    >
      <div ref={contentRef} className="px-4 pt-4 md:px-5">
        {body}
      </div>
    </Drawer>
  );
}

interface DrawerHeaderProps {
  task: TaskDTO | undefined;
  loading: boolean;
  isMobile: boolean;
  onClose: () => void;
}

function DrawerHeader({ task, loading, isMobile, onClose }: DrawerHeaderProps) {
  const sid = useSpaceId();
  const navigate = useNavigate();
  // Navigating drops ?task=, which closes the drawer (no explicit close: that would pop history).
  const extra = useMemo<MenuItem[] | undefined>(
    () =>
      task
        ? detailMenuItems(sid, task, [{ label: 'Open full page', icon: <Maximize2 />, onSelect: () => navigate(taskPageUrl(sid, task)) }])
        : undefined,
    [sid, task, navigate],
  );

  return (
    <div className="flex min-h-12 items-center gap-1 border-b border-border px-2 py-1.5 md:min-h-[3.25rem] md:px-3">
      {isMobile && <IconButton aria-label="Close task" tooltip={false} icon={<ArrowLeft />} onClick={onClose} />}
      {task ? (
        <Tooltip content="Copy link">
          <Button size="sm" variant="ghost" icon={<Link2 />} onClick={() => copyTaskLink(sid, task)} aria-label={`Copy link to ${task.ref}`} className="tabular-nums">
            {task.ref}
          </Button>
        </Tooltip>
      ) : (
        loading && <Skeleton className="ml-2 h-4 w-16" />
      )}
      {task && <SavingHint taskId={task.id} />}
      <div className="ml-auto flex items-center gap-0.5">
        {task && !isMobile && (
          <Tooltip content="Open full page">
            <Link to={taskPageUrl(sid, task)} aria-label="Open full page" className={iconButtonClasses({ className: '[&_svg]:size-4' })}>
              <Maximize2 aria-hidden />
            </Link>
          </Tooltip>
        )}
        {task && <TaskActionsMenu task={task} onOpen={false} extraItems={extra} />}
        {!isMobile && <IconButton aria-label="Close task" tooltip="Close (Esc)" icon={<X />} onClick={onClose} />}
      </div>
    </div>
  );
}

function SavingHint({ taskId }: { taskId: number }) {
  const saving = useTaskSaving(taskId);
  if (!saving) return null;
  return (
    <span className="flex items-center gap-1.5 px-1 text-xs text-fg-subtle" role="status">
      <Spinner size="xs" label={null} />
      Saving…
    </span>
  );
}

