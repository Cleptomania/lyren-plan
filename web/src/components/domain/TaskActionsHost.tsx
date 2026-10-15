// Executes `taskActions` requests: optimistic updates with error toasts, duplicate, archive
// with Undo, confirmed delete, and the tag / due-date dialogs. Mount ONCE inside the router
// and the query client (AppShell does).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TaskUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useDeleteTask, useDuplicateTask, useUpdateTask } from '../../api/tasks';
import { keepFocusAfterRemoval } from '../../lib/focusSuccessor';
import { useCloseTask, useOpenTask, useOpenTaskId } from '../../lib/taskLinks';
import { confirm, toast } from '../ui';
import { OPEN_TASK_ATTR } from './openClick';
import { TaskDueDateDialog, TaskTagsDialog } from './TaskActionDialogs';
import { registerTaskActionHandler, type TaskActionRequest, type TaskUpdateOptions } from './taskActions';

interface DialogTarget {
  task: TaskDTO | null;
  open: boolean;
  /** Remounts the dialog per opening so its draft starts fresh. */
  key: number;
}

const CLOSED: DialogTarget = { task: null, open: false, key: 0 };

export function TaskActionsHost() {
  const { mutateAsync: updateTask } = useUpdateTask();
  const { mutateAsync: deleteTask } = useDeleteTask();
  const { mutateAsync: duplicateTask } = useDuplicateTask();
  const openTask = useOpenTask();
  const closeTask = useCloseTask();
  const openTaskId = useOpenTaskId();
  const [tagsDialog, setTagsDialog] = useState<DialogTarget>(CLOSED);
  const [dueDialog, setDueDialog] = useState<DialogTarget>(CLOSED);

  // Router-bound helpers change with the location; async continuations read the latest.
  const nav = useRef({ openTask, closeTask, openTaskId });
  useLayoutEffect(() => {
    nav.current = { openTask, closeTask, openTaskId };
  });

  const runUpdate = useCallback(
    function run(task: TaskDTO, patch: TaskUpdateInput, options?: TaskUpdateOptions) {
      updateTask({ id: task.id, ...patch }).then(
        (saved) => {
          if (!options?.success) return;
          const message = typeof options.success === 'function' ? options.success(saved) : options.success;
          const undo = options.undo;
          toast.success(message, undo ? { action: { label: 'Undo', onClick: () => run(saved, undo) } } : undefined);
        },
        (err: unknown) => toast.error(err),
      );
    },
    [updateTask],
  );

  const handle = useCallback(
    async (request: TaskActionRequest) => {
      const { task } = request;
      switch (request.type) {
        case 'open':
          nav.current.openTask(task.id);
          return;
        case 'update':
          runUpdate(task, request.patch, request.options);
          return;
        case 'duplicate':
          try {
            const copy = await duplicateTask(task.id);
            toast.success(`Duplicated as ${copy.ref}`, { action: { label: 'Open', onClick: () => nav.current.openTask(copy.id) } });
          } catch (err) {
            toast.error(err);
          }
          return;
        case 'delete': {
          // Deleting from a row / card ⋯ menu removes the focused trigger: keep focus in the list.
          const cancelFocus = keepFocusAfterRemoval(String(task.id), {
            keyAttr: 'data-task-id',
            focusSelector: `[${OPEN_TASK_ATTR}]`,
          });
          const ok = await confirm({
            title: `Delete ${task.ref}?`,
            body: `“${task.title}” will be deleted permanently, including its comments and work log.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return cancelFocus();
          try {
            await deleteTask(task.id);
            toast.success(`Deleted ${task.ref}`);
            const onDeleted = request.options?.onDeleted;
            if (onDeleted) onDeleted(task);
            else if (nav.current.openTaskId === task.id) nav.current.closeTask();
          } catch (err) {
            cancelFocus();
            toast.error(err);
          }
          return;
        }
        case 'editTags':
          setTagsDialog((d) => ({ task, open: true, key: d.key + 1 }));
          return;
        case 'pickDueDate':
          setDueDialog((d) => ({ task, open: true, key: d.key + 1 }));
          return;
      }
    },
    [runUpdate, duplicateTask, deleteTask],
  );

  useEffect(() => registerTaskActionHandler((request) => void handle(request)), [handle]);

  return (
    <>
      {tagsDialog.task && (
        <TaskTagsDialog
          key={`tags-${tagsDialog.key}`}
          task={tagsDialog.task}
          open={tagsDialog.open}
          onClose={() => setTagsDialog((d) => ({ ...d, open: false }))}
          onSave={(patch) => tagsDialog.task && runUpdate(tagsDialog.task, patch)}
        />
      )}
      {dueDialog.task && (
        <TaskDueDateDialog
          key={`due-${dueDialog.key}`}
          task={dueDialog.task}
          open={dueDialog.open}
          onClose={() => setDueDialog((d) => ({ ...d, open: false }))}
          onSave={(patch) => dueDialog.task && runUpdate(dueDialog.task, patch)}
        />
      )}
    </>
  );
}
