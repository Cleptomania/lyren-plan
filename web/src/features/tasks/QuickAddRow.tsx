// Inline "Add task" row at the end of a TaskList (or of one of its groups). Enter creates the
// task and keeps the field focused for rapid entry; Esc (or ✕) closes it. Without a
// resolvable project it opens the full "New task" dialog instead.

import { clsx } from 'clsx';
import { CornerDownLeft, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { LIMITS } from '@shared/constants';
import { taskCreateInput, type TaskCreateInput } from '@shared/schemas';
import { useCreateTask } from '../../api/tasks';
import { IconButton, Spinner, toast } from '../../components/ui';
import { openCreateTask } from '../../lib/events';
import { useOverlay } from '../../lib/overlays';

export interface QuickAddRowProps {
  /** Fields for the new task (createDefaults merged with the group's fields). */
  defaults: Partial<TaskCreateInput>;
  /** Accessible context, e.g. the group name ("Add task to In Progress"). */
  context?: string;
  className?: string;
}

export function QuickAddRow({ defaults, context, className }: QuickAddRowProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const { mutateAsync } = useCreateTask();
  const label = context ? `Add task to ${context}` : 'Add task';

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setTitle('');
    if (restoreFocus) requestAnimationFrame(() => openerRef.current?.focus({ preventScroll: true }));
  };

  // While typing, Esc must close this row rather than an enclosing drawer.
  useOverlay(open && focused, () => close(true));

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = title.trim();
    if (!value) return;
    const parsed = taskCreateInput.safeParse({ ...defaults, title: value });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Invalid task');
      return;
    }
    setTitle('');
    setPending((n) => n + 1);
    mutateAsync(parsed.data)
      .catch((err: unknown) => {
        toast.error(err);
        // Give the text back unless the user already typed the next title.
        setTitle((current) => current || value);
      })
      .finally(() => setPending((n) => n - 1));
  };

  if (defaults.projectId === undefined) {
    return (
      <AddButton ref={openerRef} label={label} className={className} onClick={() => openCreateTask(defaults)} />
    );
  }

  if (!open) {
    return <AddButton ref={openerRef} label={label} className={className} onClick={() => setOpen(true)} />;
  }

  return (
    <form onSubmit={submit} className={clsx('flex min-h-11 items-center gap-2 px-3 py-1', className)}>
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center text-fg-subtle">
        {pending > 0 ? <Spinner size="sm" label={null} /> : <Plus className="size-4" />}
      </span>
      <input
        ref={inputRef}
        value={title}
        maxLength={LIMITS.titleMax}
        enterKeyHint="enter"
        autoComplete="off"
        aria-label={label}
        placeholder="Task title"
        onChange={(e) => setTitle(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          setFocused(false);
          // Leaving an empty field closes it (unless focus moved to this row's buttons).
          if (!title.trim() && !e.currentTarget.form?.contains(e.relatedTarget as Node | null)) close(false);
        }}
        className="h-9 min-w-0 flex-1 rounded-md bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg-subtle"
      />
      {pending > 0 && <span className="sr-only" role="status">Adding task…</span>}
      <IconButton
        type="submit"
        size="sm"
        variant="ghost"
        aria-label="Add"
        tooltip="Add (Enter)"
        icon={<CornerDownLeft />}
        disabled={!title.trim()}
      />
      <IconButton size="sm" variant="ghost" aria-label="Close" tooltip="Close (Esc)" icon={<X />} onClick={() => close(true)} />
    </form>
  );
}

interface AddButtonProps {
  label: string;
  onClick: () => void;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

function AddButton({ label, onClick, className, ref }: AddButtonProps) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      className={clsx(
        'flex h-11 w-full items-center gap-2 px-3 text-left text-sm text-fg-muted transition-colors',
        'hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2',
        className,
      )}
    >
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center">
        <Plus className="size-4" />
      </span>
      Add task
    </button>
  );
}
