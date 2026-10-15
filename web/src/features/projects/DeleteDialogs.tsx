// Delete confirmations for projects (type the key), milestones (keep or delete the epics)
// and epics (keep or delete the tasks). Each shows a spinner while the request runs and
// toasts the outcome.

import { clsx } from 'clsx';
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { EpicDTO, MilestoneDTO, ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useDeleteEpic, useDeleteMilestone, useDeleteProject } from '../../api/projects';
import { useTaskQuery } from '../../api/tasks';
import { Button, ConfirmDialog, Dialog, toast } from '../../components/ui';
import type { OverlayControls } from '../../components/ui/internal/overlayControls';
import { pluralize } from '../../lib/format';

/** Keep showing the last non-null value while a dialog animates closed. */
function useLatest<T>(value: T | null): T | null {
  const ref = useRef(value);
  if (value !== null) ref.current = value;
  return ref.current;
}

/**
 * After a successful delete: close the dialog and run `onDeleted` once it has closed and its
 * phone history entry (Back closes these dialogs) is gone. `onDeleted` typically navigates
 * away with { replace: true }, which must replace the deleted entity's page entry, not the
 * dialog's. `dialog` is the dialog's controls captured when the delete was confirmed: they
 * keep working even if a refetch has unmounted the dialog meanwhile (then any pop still in
 * flight is waited out).
 */
function closeThenDeleted(dialog: OverlayControls | null, onClose: () => void, deleted: (() => void) | undefined) {
  if (dialog && deleted) dialog.afterClose(deleted);
  else deleted?.();
  onClose();
}

/** Hooks around a delete: confirmed (request sent), failed (after the error toast), succeeded. */
export interface DeleteCallbacks<T> {
  onDeleting?: (entity: T) => void;
  onFailed?: (entity: T) => void;
  onDeleted?: (entity: T) => void;
}

// ---- Project ---------------------------------------------------------------------------

export interface DeleteProjectDialogProps {
  project: ProjectDTO | null;
  onClose: () => void;
  /** Called when the user confirms, before the request is sent. */
  onDeleting?: (project: ProjectDTO) => void;
  /** Called when the request failed (after the error toast). */
  onFailed?: (project: ProjectDTO) => void;
  /** Called after a successful delete, once the dialog has closed (e.g. to navigate away). */
  onDeleted?: (project: ProjectDTO) => void;
}

export function DeleteProjectDialog({ project: current, onClose, onDeleting, onFailed, onDeleted }: DeleteProjectDialogProps) {
  const project = useLatest(current);
  const { milestonesByProject, epicsByProject } = useLookups();
  const del = useDeleteProject();
  const controls = useRef<OverlayControls>(null);
  if (!project) return null;
  const milestones = milestonesByProject.get(project.id)?.length ?? 0;
  const epics = epicsByProject.get(project.id)?.length ?? 0;
  const tasks = project.stats.tasksTotal;
  return (
    <ConfirmDialog
      open={current !== null}
      controlsRef={controls}
      onCancel={() => !del.isPending && onClose()}
      onConfirm={() => {
        onDeleting?.(project);
        const dialog = controls.current;
        // mutateAsync, not mutate(…, callbacks): the refetch after the delete can unmount this
        // dialog (the page renders nothing once the project is gone) before per-call callbacks
        // run, and React Query skips those after unmount, so onDeleted never navigated away.
        del.mutateAsync(project.id).then(
          () => {
            toast.success(`Deleted ${project.name}`);
            closeThenDeleted(dialog, onClose, onDeleted && (() => onDeleted(project)));
          },
          (err: unknown) => {
            toast.error(err);
            onFailed?.(project);
          },
        );
      }}
      busy={del.isPending}
      danger
      title={`Delete ${project.name}?`}
      confirmLabel="Delete project"
      typeToConfirm={project.key}
      body={
        <p>
          This permanently deletes the project and everything in it: {pluralize(tasks, 'task')},{' '}
          {pluralize(milestones, 'milestone')} and {pluralize(epics, 'epic')}, plus archived tasks, comments, work logs,
          activity and the project’s boards. This can’t be undone.
        </p>
      }
    />
  );
}

// ---- Choice cards ----------------------------------------------------------------------------

interface Choice<V extends string> {
  value: V;
  title: ReactNode;
  description: ReactNode;
  danger?: boolean;
}

function ChoiceGroup<V extends string>({
  legend,
  value,
  onChange,
  choices,
}: {
  legend: string;
  value: V;
  onChange: (value: V) => void;
  choices: ReadonlyArray<Choice<V>>;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{legend}</legend>
      {choices.map((c) => {
        const checked = c.value === value;
        return (
          <label
            key={c.value}
            className={clsx(
              'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2',
              checked ? (c.danger ? 'border-danger bg-danger-soft' : 'border-accent bg-accent-soft') : 'border-border hover:border-border-strong',
            )}
          >
            <input
              type="radio"
              name={name}
              value={c.value}
              checked={checked}
              onChange={() => onChange(c.value)}
              className={clsx('mt-0.5 size-4 shrink-0 focus-visible:outline-none', c.danger ? 'accent-danger' : 'accent-accent')}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium text-fg">{c.title}</span>
              <span className="text-[13px] text-fg-muted">{c.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function DeleteShell({
  open,
  title,
  onClose,
  onConfirm,
  busy,
  confirmLabel,
  controlsRef,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  confirmLabel: string;
  controlsRef: RefObject<OverlayControls | null>;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    // Phones: a bottom sheet with its own history entry, so Back closes it (SPEC §9).
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      size="sm"
      mobileLayout="sheet"
      controlsRef={controlsRef}
      initialFocus={cancelRef}
      onSubmit={() => !busy && onConfirm()}
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm text-fg-muted">{children}</div>
    </Dialog>
  );
}

// ---- Milestone ---------------------------------------------------------------------------

export interface DeleteMilestoneDialogProps extends DeleteCallbacks<MilestoneDTO> {
  milestone: MilestoneDTO | null;
  onClose: () => void;
}

export function DeleteMilestoneDialog({ milestone: current, onClose, onDeleting, onFailed, onDeleted }: DeleteMilestoneDialogProps) {
  const milestone = useLatest(current);
  const { epicsByMilestone } = useLookups();
  const del = useDeleteMilestone();
  const controls = useRef<OverlayControls>(null);
  const [mode, setMode] = useState<'detach' | 'delete'>('detach');
  const [shownFor, setShownFor] = useState<number | null>(null);
  if (current && shownFor !== current.id) {
    // New target: start from the safe choice.
    setShownFor(current.id);
    setMode('detach');
  }
  if (!milestone) return null;
  const epics = epicsByMilestone.get(milestone.id) ?? [];
  const tasks = epics.reduce((n, e) => n + e.stats.tasksTotal, 0);
  const confirm = () => {
    onDeleting?.(milestone);
    const dialog = controls.current;
    // mutateAsync: see DeleteProjectDialog (callbacks must run even if the page unmounts).
    del.mutateAsync({ id: milestone.id, epics: epics.length > 0 ? mode : 'detach' }).then(
      () => {
        toast.success(
          mode === 'delete' && epics.length > 0
            ? `Deleted “${milestone.name}” and ${pluralize(epics.length, 'epic')}`
            : `Deleted “${milestone.name}”`,
        );
        closeThenDeleted(dialog, onClose, onDeleted && (() => onDeleted(milestone)));
      },
      (err: unknown) => {
        toast.error(err);
        onFailed?.(milestone);
      },
    );
  };
  return (
    <DeleteShell
      open={current !== null}
      title={`Delete “${milestone.name}”?`}
      onClose={onClose}
      onConfirm={confirm}
      busy={del.isPending}
      confirmLabel="Delete milestone"
      controlsRef={controls}
    >
      {epics.length === 0 ? (
        <p>The milestone has no epics. Tasks are not affected.</p>
      ) : (
        <>
          <p>
            “{milestone.name}” has {pluralize(epics.length, 'epic')}. What should happen to {epics.length === 1 ? 'it' : 'them'}?
          </p>
          <ChoiceGroup
            legend="Epics of this milestone"
            value={mode}
            onChange={setMode}
            choices={[
              {
                value: 'detach',
                title: `Keep ${epics.length === 1 ? 'the epic' : `the ${epics.length} epics`}`,
                description: 'They move to “Epics without milestone”. Tasks are not affected.',
              },
              {
                value: 'delete',
                title: `Delete ${epics.length === 1 ? 'the epic' : `the ${epics.length} epics`} too`,
                description:
                  tasks > 0 ? `Their ${pluralize(tasks, 'task')} are kept, without an epic.` : 'Tasks are not affected.',
                danger: true,
              },
            ]}
          />
        </>
      )}
    </DeleteShell>
  );
}

// ---- Epic ----------------------------------------------------------------------------------

export interface DeleteEpicDialogProps extends DeleteCallbacks<EpicDTO> {
  epic: EpicDTO | null;
  onClose: () => void;
}

export function DeleteEpicDialog({ epic: current, onClose, onDeleting, onFailed, onDeleted }: DeleteEpicDialogProps) {
  const epic = useLatest(current);
  const del = useDeleteEpic();
  const controls = useRef<OverlayControls>(null);
  const [mode, setMode] = useState<'detach' | 'delete'>('detach');
  const [shownFor, setShownFor] = useState<number | null>(null);
  if (current && shownFor !== current.id) {
    setShownFor(current.id);
    setMode('detach');
  }
  // Exact count including archived tasks (stats leave out archived open ones).
  const count = useTaskQuery(
    { filter: { projectIds: epic ? [epic.projectId] : [], epicIds: epic ? [epic.id] : [], archived: 'include' }, limit: 1 },
    { enabled: current !== null },
  );
  if (!epic) return null;
  const tasks = count.data && !count.isPlaceholderData ? count.data.total : epic.stats.tasksTotal;
  const confirm = () => {
    onDeleting?.(epic);
    const dialog = controls.current;
    // mutateAsync: see DeleteProjectDialog (callbacks must run even if the page unmounts).
    del.mutateAsync({ id: epic.id, tasks: tasks > 0 ? mode : 'detach' }).then(
      () => {
        toast.success(
          mode === 'delete' && tasks > 0 ? `Deleted “${epic.name}” and ${pluralize(tasks, 'task')}` : `Deleted “${epic.name}”`,
        );
        closeThenDeleted(dialog, onClose, onDeleted && (() => onDeleted(epic)));
      },
      (err: unknown) => {
        toast.error(err);
        onFailed?.(epic);
      },
    );
  };
  return (
    <DeleteShell
      open={current !== null}
      title={`Delete “${epic.name}”?`}
      onClose={onClose}
      onConfirm={confirm}
      busy={del.isPending}
      confirmLabel={mode === 'delete' && tasks > 0 ? `Delete epic and ${pluralize(tasks, 'task')}` : 'Delete epic'}
      controlsRef={controls}
    >
      {tasks === 0 ? (
        <p>The epic has no tasks.</p>
      ) : (
        <>
          <p>
            “{epic.name}” has {pluralize(tasks, 'task')}. What should happen to {tasks === 1 ? 'it' : 'them'}?
          </p>
          <ChoiceGroup
            legend="Tasks of this epic"
            value={mode}
            onChange={setMode}
            choices={[
              {
                value: 'detach',
                title: `Keep ${tasks === 1 ? 'the task' : `the ${tasks} tasks`}`,
                description: 'They stay in the project, without an epic.',
              },
              {
                value: 'delete',
                title: `Delete ${tasks === 1 ? 'the task' : `the ${tasks} tasks`} too`,
                description: 'Permanently deletes the tasks with their comments and work logs.',
                danger: true,
              },
            ]}
          />
        </>
      )}
    </DeleteShell>
  );
}
