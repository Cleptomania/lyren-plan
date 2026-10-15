// Task work log ("log activity"): total vs estimate, a "Log time" form that reads durations
// like "1h 30m" / "90" / "1.5h" / "1:30", and the entries (newest first) with edit/delete.

import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Clock, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { LIMITS } from '@shared/constants';
import { isValidISODate } from '@shared/dates';
import { formatMinutes } from '@shared/duration';
import type { TaskDTO, WorklogDTO } from '@shared/types';
import { ApiError } from '../../api/client';
import { useLookups } from '../../api/bootstrap';
import { useAddWorklog, useDeleteWorklog, useUpdateWorklog } from '../../api/timeline';
import { useSharedToday } from '../../components/domain';
import {
  Button,
  DateInput,
  Field,
  IconButton,
  Input,
  Menu,
  ProgressBar,
  SkeletonList,
  Textarea,
  toast,
  useConfirm,
} from '../../components/ui';
import { formatDate, formatEstimate } from '../../lib/format';
import { clearDraft, readJsonDraft, writeDraft } from './drafts';
import { isGoneError, stillInTimeline, worklogLeaveInput } from './leaveSave';
import {
  DURATION_HINT,
  durationText,
  parseDurationInput,
  validateWorklogForm,
  worklogApiErrors,
  type WorklogFormErrors,
  type WorklogFormValues,
} from './worklogForm';

export interface WorklogPanelProps {
  task: TaskDTO;
  /** Oldest first (API order); undefined while the timeline loads. */
  worklogs: WorklogDTO[] | undefined;
}

function isFormDraft(v: unknown): v is WorklogFormValues {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (o.date === null || typeof o.date === 'string') && typeof o.duration === 'string' && typeof o.note === 'string';
}

export function WorklogPanel({ task, worklogs }: WorklogPanelProps) {
  const { user } = useLookups();
  const [formOpen, setFormOpen] = useState(() => readJsonDraft('worklog', task.id, isFormDraft) !== null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const total = worklogs ? worklogs.reduce((sum, w) => sum + (w.minutes ?? 0), 0) : task.worklogMinutes;
  // Newest work first: the entry just logged appears right under the form.
  const entries = worklogs ? [...worklogs].reverse() : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <WorklogSummary task={task} totalMinutes={total}>
        {!formOpen && (
          <Button
            size="sm"
            variant="primary"
            icon={<Plus />}
            onClick={() => {
              setEditingId(null);
              setFormOpen(true);
            }}
          >
            Log time
          </Button>
        )}
      </WorklogSummary>

      {formOpen && <WorklogForm taskId={task.id} onClose={() => setFormOpen(false)} />}

      {entries === undefined ? (
        <SkeletonList rows={2} withIcon={false} />
      ) : entries.length === 0 ? (
        !formOpen && <p className="py-1 text-sm text-fg-muted">No time logged yet. Use “Log time” to record work on this task.</p>
      ) : (
        <ol aria-label="Work log entries" className="flex min-w-0 flex-col divide-y divide-border border-y border-border">
          {entries.map((w) => (
            <li key={w.id} className="min-w-0">
              {editingId === w.id ? (
                <div className="py-3">
                  <WorklogForm taskId={task.id} entry={w} onClose={() => setEditingId(null)} />
                </div>
              ) : (
                <WorklogEntry
                  entry={w}
                  taskId={task.id}
                  canEdit={w.author?.id === user.id}
                  showAuthor={w.author?.id !== user.id}
                  onEdit={() => {
                    setFormOpen(false);
                    setEditingId(w.id);
                  }}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---- Summary ------------------------------------------------------------------------

function WorklogSummary({ task, totalMinutes, children }: { task: TaskDTO; totalMinutes: number; children?: ReactNode }) {
  const { settings } = useLookups();
  const estimateMinutes = settings.estimateUnit === 'hours' && task.estimate !== null && task.estimate > 0 ? Math.round(task.estimate * 60) : null;
  const over = estimateMinutes !== null && totalMinutes > estimateMinutes ? totalMinutes - estimateMinutes : 0;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <Clock aria-hidden className="size-4 shrink-0 text-fg-subtle" />
        <p className="min-w-0 flex-1 text-sm">
          {totalMinutes > 0 ? (
            <>
              <span className="font-semibold tabular-nums text-fg">{formatMinutes(totalMinutes)}</span>{' '}
              <span className="text-fg-muted">
                logged
                {estimateMinutes !== null && ` of ${formatEstimate(task.estimate, 'hours')} estimated`}
              </span>
            </>
          ) : (
            <span className="text-fg-muted">
              Nothing logged yet{estimateMinutes !== null && ` · ${formatEstimate(task.estimate, 'hours')} estimated`}
            </span>
          )}
        </p>
        {children}
      </div>
      {estimateMinutes !== null && totalMinutes > 0 && (
        <div className="flex flex-col gap-1">
          <ProgressBar
            value={Math.min(totalMinutes, estimateMinutes)}
            total={estimateMinutes}
            aria-label="Time logged against the estimate"
            color={over > 0 ? 'var(--warning)' : undefined}
          />
          {over > 0 && <p className="text-xs font-medium text-warning">{formatMinutes(over)} over the estimate</p>}
        </div>
      )}
    </div>
  );
}

// ---- One entry ----------------------------------------------------------------------

interface WorklogEntryProps {
  entry: WorklogDTO;
  taskId: number;
  canEdit: boolean;
  showAuthor: boolean;
  onEdit: () => void;
}

function WorklogEntry({ entry, taskId, canEdit, showAuthor, onEdit }: WorklogEntryProps) {
  const remove = useDeleteWorklog(taskId);
  const confirm = useConfirm();
  const today = useSharedToday();
  const duration = entry.minutes !== null && entry.minutes > 0 ? formatMinutes(entry.minutes) : null;

  const del = async () => {
    const ok = await confirm({
      title: 'Delete this work log entry?',
      body: duration ? `${duration} on ${formatDate(entry.date, today)} will no longer count towards this task.` : 'This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    // The row unmounts once the refreshed list drops it, so don't rely on mutate callbacks.
    remove.mutateAsync(entry.id).then(
      () => toast.success('Work log entry deleted'),
      (err: unknown) => toast.error(err),
    );
  };

  return (
    <div className={clsx('flex min-w-0 items-start gap-3 py-2.5 transition-opacity', remove.isPending && 'pointer-events-none opacity-50')}>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          <span className={clsx('tabular-nums', duration ? 'font-semibold text-fg' : 'text-fg-subtle')}>{duration ?? 'No time'}</span>
          <time dateTime={entry.date} className="text-[13px] text-fg-muted">
            {formatDate(entry.date, today)}
          </time>
          {showAuthor && <span className="min-w-0 truncate text-[13px] text-fg-muted">· {entry.author?.displayName ?? 'Unknown user'}</span>}
        </p>
        {entry.note && <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-fg">{entry.note}</p>}
      </div>
      {canEdit && (
        <Menu
          label="Work log entry actions"
          trigger={<IconButton aria-label="Work log entry actions" icon={<MoreHorizontal />} size="sm" loading={remove.isPending} className="-mr-1.5 shrink-0" />}
          items={[
            { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
            { separator: true },
            { label: 'Delete…', icon: <Trash2 />, danger: true, onSelect: () => void del() },
          ]}
        />
      )}
    </div>
  );
}

// ---- Form (create + edit) -----------------------------------------------------------

interface WorklogFormProps {
  taskId: number;
  /** Edit this entry; omit to log new time. */
  entry?: WorklogDTO;
  onClose: () => void;
}

function WorklogForm({ taskId, entry, onClose: close }: WorklogFormProps) {
  const today = useSharedToday();
  const qc = useQueryClient();
  const add = useAddWorklog(taskId);
  const update = useUpdateWorklog(taskId);
  const confirm = useConfirm();
  const formId = useId();
  const [values, setValues] = useState<WorklogFormValues>(() =>
    entry
      ? { date: entry.date, duration: durationText(entry.minutes), note: entry.note }
      : (readJsonDraft('worklog', taskId, isFormDraft) ?? { date: today, duration: '', note: '' }),
  );
  const [errors, setErrors] = useState<WorklogFormErrors>({});
  const [durationTouched, setDurationTouched] = useState(false);
  const pending = add.isPending || update.isPending;
  const parsed = parseDurationInput(values.duration);

  // Editing an entry and leaving without Save / Cancel (drawer closed with Back / ← / ×,
  // another task opened, the tab switched) saves valid changes, like comment edits; Cancel
  // reverts. New entries keep their sessionStorage draft instead.
  const closed = useRef(false);
  const onClose = () => {
    closed.current = true;
    close();
  };
  const latest = useRef({ values, entry, pending, save: update.mutateAsync, qc, taskId });
  latest.current = { values, entry, pending, save: update.mutateAsync, qc, taskId };
  useEffect(
    () => () => {
      const l = latest.current;
      if (!l.entry || closed.current || l.pending) return;
      const input = worklogLeaveInput(l.values, l.entry);
      if (!input || !stillInTimeline(l.qc, l.taskId, 'worklogs', l.entry.id)) return;
      l.save({ id: l.entry.id, ...input }).catch((err: unknown) => {
        if (!isGoneError(err)) toast.error(err);
      });
    },
    [],
  );

  const set = (patch: Partial<WorklogFormValues>) => {
    setValues((prev) => {
      const next = { ...prev, ...patch };
      if (!entry) writeDraft('worklog', taskId, next.duration.trim() || next.note.trim() ? JSON.stringify(next) : '');
      return next;
    });
    setErrors((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(patch) as Array<keyof WorklogFormValues>) delete next[k];
      // Either field can satisfy "time or a note".
      if ('note' in patch || 'duration' in patch) delete next.duration;
      return next;
    });
  };

  const cancel = async () => {
    if (pending) return;
    // New entries confirm before throwing typed text away (Cancel on an edit just reverts).
    if (!entry && (values.duration.trim() !== '' || values.note.trim() !== '')) {
      const discard = await confirm({ title: 'Discard this entry?', confirmLabel: 'Discard', danger: true });
      if (!discard) return;
      clearDraft('worklog', taskId);
    }
    onClose();
  };

  const onApiError = (err: unknown) => {
    if (err instanceof ApiError) setErrors(worklogApiErrors(err.details));
    toast.error(err);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (pending) return;
    setDurationTouched(true);
    const result = validateWorklogForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      const first = (['date', 'duration', 'note'] as const).find((k) => result.errors[k]);
      if (first) document.getElementById(`${formId}-${first}`)?.focus();
      return;
    }
    const input = result.input;
    if (entry) {
      if (input.date === entry.date && input.minutes === entry.minutes && input.note === entry.note) {
        onClose();
        return;
      }
      update.mutate({ id: entry.id, ...input }, { onSuccess: () => onClose(), onError: onApiError });
    } else {
      // mutateAsync so the draft is cleared even if the drawer moved on to another task.
      add.mutateAsync(input).then((saved) => {
        clearDraft('worklog', taskId);
        toast.success(saved.minutes ? `Logged ${formatMinutes(saved.minutes)}` : 'Note added to the work log');
        onClose();
      }, onApiError);
    }
  };

  const submitOnModEnter = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const durationError = errors.duration ?? (durationTouched && parsed.state === 'invalid' ? parsed.message : undefined);
  const durationHint =
    parsed.state === 'valid' ? (
      <span className="font-medium text-fg">= {formatMinutes(parsed.minutes)}</span>
    ) : (
      DURATION_HINT
    );

  return (
    <form
      onSubmit={submit}
      aria-label={entry ? 'Edit work log entry' : 'Log time'}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-3"
      noValidate
    >
      <div className="grid min-w-0 gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <Field label="Date" htmlFor={`${formId}-date`} error={errors.date} required>
          <DateInput
            value={values.date}
            onChange={(date) => set({ date })}
            clearable={false}
            disabled={pending}
            invalid={!!errors.date || (values.date !== null && !isValidISODate(values.date))}
          />
        </Field>
        <Field label="Time spent" htmlFor={`${formId}-duration`} error={durationError} hint={durationHint}>
          <Input
            value={values.duration}
            onChange={(e) => set({ duration: e.target.value })}
            onBlur={() => setDurationTouched(true)}
            placeholder="1h 30m"
            autoComplete="off"
            autoFocus={!entry}
            disabled={pending}
            enterKeyHint="done"
          />
        </Field>
      </div>
      <Field label="Note" htmlFor={`${formId}-note`} error={errors.note} optional>
        <Textarea
          value={values.note}
          onChange={(e) => set({ note: e.target.value })}
          onKeyDown={submitOnModEnter}
          autoGrow
          minRows={2}
          maxRows={8}
          maxLength={LIMITS.worklogNoteMax}
          placeholder="What did you work on?"
          disabled={pending}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void cancel()} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={pending} icon={entry ? undefined : <Clock />}>
          {entry ? 'Save' : 'Log time'}
        </Button>
      </div>
    </form>
  );
}
