// Imperative task commands (open, update, duplicate, archive, delete, edit tags, pick a due
// date). Requests go to the single <TaskActionsHost /> (mounted by AppShell), which owns the
// mutations, toasts, confirmations and dialogs — so menus on hundreds of cards stay cheap
// and a dialog survives its card re-rendering or moving to another column.

import type { TaskUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { toast } from '../ui';

export interface TaskUpdateOptions {
  /** Success toast once the server confirmed (default: none — the UI already shows it). */
  success?: string | ((saved: TaskDTO) => string);
  /** Adds "Undo" to the success toast, applying this patch to the saved task. */
  undo?: TaskUpdateInput;
}

export interface TaskDeleteOptions {
  /**
   * Called after the task was deleted (e.g. a task page navigates away). Without it the host
   * closes the task drawer when it shows the deleted task.
   */
  onDeleted?: (task: TaskDTO) => void;
}

export type TaskActionRequest =
  | { type: 'open'; task: TaskDTO }
  | { type: 'update'; task: TaskDTO; patch: TaskUpdateInput; options?: TaskUpdateOptions }
  | { type: 'duplicate'; task: TaskDTO }
  | { type: 'delete'; task: TaskDTO; options?: TaskDeleteOptions }
  | { type: 'editTags'; task: TaskDTO }
  | { type: 'pickDueDate'; task: TaskDTO };

type Handler = (request: TaskActionRequest) => void;

let handler: Handler | null = null;

/** Used by TaskActionsHost. Returns an unregister function. */
export function registerTaskActionHandler(next: Handler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

function dispatch(request: TaskActionRequest): void {
  if (!handler) {
    console.error(`Task action "${request.type}" dispatched without a mounted <TaskActionsHost />`);
    toast.error('That action is not available right now');
    return;
  }
  handler(request);
}

/**
 * Task commands for menus and feature code. Updates are optimistic (useUpdateTask) and
 * failures roll back with an error toast.
 *
 *   taskActions.update(task, { statusId }, { success: 'Moved to Done' })
 */
export const taskActions = {
  /** Open the task drawer (?task=<id>). */
  open: (task: TaskDTO): void => dispatch({ type: 'open', task }),
  update: (task: TaskDTO, patch: TaskUpdateInput, options?: TaskUpdateOptions): void =>
    dispatch({ type: 'update', task, patch, options }),
  /** Duplicate (placed right after the original); the toast offers "Open". */
  duplicate: (task: TaskDTO): void => dispatch({ type: 'duplicate', task }),
  /** Archive / unarchive with an "Undo" toast. */
  setArchived: (task: TaskDTO, archived: boolean): void =>
    dispatch({
      type: 'update',
      task,
      patch: { archived },
      options: { success: `${archived ? 'Archived' : 'Unarchived'} ${task.ref}`, undo: { archived: !archived } },
    }),
  /** Asks for confirmation first. */
  delete: (task: TaskDTO, options?: TaskDeleteOptions): void => dispatch({ type: 'delete', task, options }),
  /** Tag editor dialog (search, toggle, create). */
  editTags: (task: TaskDTO): void => dispatch({ type: 'editTags', task }),
  /** Due-date dialog (quick dates + date input). */
  pickDueDate: (task: TaskDTO): void => dispatch({ type: 'pickDueDate', task }),
};

export type TaskActions = typeof taskActions;
