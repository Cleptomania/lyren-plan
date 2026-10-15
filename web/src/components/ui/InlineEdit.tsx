// Click-to-edit text (titles, names). Enter or blur saves, Esc cancels. Newlines are not
// allowed: pasted line breaks become spaces.

import { clsx } from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useOverlay } from '../../lib/overlays';
import { autosizeTextarea } from './autosize';

export interface InlineEditProps {
  value: string;
  /** Called with the trimmed new value when it changed. */
  onSave: (value: string) => void | Promise<unknown>;
  /** Accessible name (e.g. "Task title"). */
  'aria-label': string;
  placeholder?: string;
  /** Empty input reverts instead of saving (default true). */
  required?: boolean;
  maxLength?: number;
  disabled?: boolean;
  /** Controlled editing state (e.g. start editing from a "Rename" menu item). */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Typography classes, applied to both the display and the editor (e.g. "text-xl font-semibold"). */
  className?: string;
}

/** The trimmed one-line value to save, or null when nothing changed (or a required value is empty). */
function changedValue(draft: string, value: string, required: boolean): string | null {
  const next = draft.replace(/\s*\n\s*/g, ' ').trim();
  return next === value.trim() || (required && !next) ? null : next;
}

export function InlineEdit({
  value,
  onSave,
  'aria-label': ariaLabel,
  placeholder = 'Untitled',
  required = true,
  maxLength,
  disabled,
  editing: editingProp,
  onEditingChange,
  className,
}: InlineEditProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const editing = !disabled && (editingProp ?? uncontrolled);
  const setEditing = (next: boolean) => {
    if (editingProp === undefined) setUncontrolled(next);
    onEditingChange?.(next);
  };
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const displayRef = useRef<HTMLButtonElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!editing || !el) return;
    finished.current = false;
    autosizeTextarea(el, 1, 0);
    el.focus();
    el.select();
  }, [editing]);

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = save ? changedValue(draft, value, required) : null;
    setEditing(false);
    requestAnimationFrame(() => displayRef.current?.focus({ preventScroll: true }));
    if (next === null) {
      setDraft(value);
      return;
    }
    void onSave(next);
  };

  // Unmounting while editing (e.g. Back closes the task drawer) fires no blur: save the draft
  // anyway, like a blur would. Mutations keep running after unmount.
  const latest = useRef({ editing, draft, value, required, onSave });
  latest.current = { editing, draft, value, required, onSave };
  useEffect(
    () => () => {
      const l = latest.current;
      if (!l.editing || finished.current) return;
      finished.current = true;
      const next = changedValue(l.draft, l.value, l.required);
      if (next !== null) void l.onSave(next);
    },
    [],
  );

  // While editing, Esc must cancel the edit rather than close an enclosing drawer/dialog.
  useOverlay(editing, () => finish(false));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      finish(true);
    }
  };

  const shared = 'w-full min-w-0 rounded-md px-1.5 py-0.5 -mx-1.5 break-words';
  if (editing) {
    return (
      <textarea
        ref={inputRef}
        rows={1}
        aria-label={ariaLabel}
        value={draft}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value.replace(/\r?\n/g, ' '));
          autosizeTextarea(e.currentTarget, 1, 0);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => finish(true)}
        className={clsx(
          shared,
          'block resize-none overflow-hidden bg-surface text-fg outline-none ring-2 ring-focus/40',
          className,
        )}
      />
    );
  }
  return (
    <button
      ref={displayRef}
      type="button"
      aria-label={`${ariaLabel}: ${value || placeholder}. Edit`}
      disabled={disabled}
      onClick={() => setEditing(true)}
      className={clsx(
        shared,
        'block text-left transition-colors hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent',
        // Touch: at least a 40px target, text centered.
        'pointer-coarse:flex pointer-coarse:min-h-10 pointer-coarse:items-center',
        !value && 'text-fg-subtle',
        className,
      )}
    >
      {value || placeholder}
    </button>
  );
}
