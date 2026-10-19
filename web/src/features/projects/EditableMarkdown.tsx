// Inline-editable Markdown (descriptions): rendered Markdown with an always-visible Edit
// button; editing uses the kit MarkdownEditor (mod+Enter saves, Esc cancels; navigating away
// saves too). Long text is clamped with "Show more".

import { clsx } from 'clsx';
import { Pencil, Plus } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LIMITS } from '@shared/constants';
import { Button, Markdown, MarkdownEditor, useConfirm } from '../../components/ui';

export interface EditableMarkdownProps {
  value: string;
  /** Resolve true when saved (the editor closes), false to keep editing (e.g. the request failed). */
  onSave: (next: string) => Promise<boolean>;
  /** Accessible name, e.g. "Project description". */
  label: string;
  /** Text of the empty-state button (default "Add a description"). */
  emptyLabel?: string;
  /** Clamp long text to about this many pixels with a "Show more" toggle (0 = never). Default 320. */
  clampPx?: number;
  /** Section heading rendered in a row with the Edit button (otherwise the button floats top-right). */
  heading?: ReactNode;
  /**
   * Asked when the editor unmounts while holding an unsaved draft (the user navigated away): return
   * false when there is nothing left to save to (the entity was just deleted, or the user signed
   * out), so the draft is dropped instead of sending a request that can only fail. Default: save.
   */
  canSaveOnLeave?: () => boolean;
  /** The text only, no editing (a role that may not change it, design §12.9). */
  readOnly?: boolean;
  className?: string;
}

export function EditableMarkdown({
  value,
  onSave,
  label,
  emptyLabel = 'Add a description',
  clampPx = 320,
  heading,
  canSaveOnLeave,
  readOnly = false,
  className,
}: EditableMarkdownProps) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);

  // Measure whether the rendered Markdown exceeds the clamp (re-measured when it loads/changes).
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || clampPx <= 0) return;
    const measure = () => setOverflowing(el.scrollHeight > clampPx + 24);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, clampPx, editing]);

  const start = () => {
    setDraft(value);
    setEditing(true);
  };
  const finish = () => {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus({ preventScroll: true }));
  };
  const cancel = async () => {
    if (draft !== value && !(await confirm({ title: 'Discard changes?', body: 'Your edits to the description will be lost.', confirmLabel: 'Discard', danger: true }))) {
      return;
    }
    finish();
  };
  const save = async () => {
    if (saving) return;
    if (draft === value) return finish();
    setSaving(true);
    const ok = await onSave(draft);
    setSaving(false);
    if (ok) finish();
  };

  // Leaving the page while editing (a link, Back) saves the draft, like task descriptions do:
  // onSave runs a mutation that outlives this component, and a failure shows a toast. Not when
  // the unmount is because the entity itself went away (canSaveOnLeave).
  const latest = useRef({ editing, draft, value, saving, onSave, canSaveOnLeave });
  latest.current = { editing, draft, value, saving, onSave, canSaveOnLeave };
  useEffect(
    () => () => {
      const { editing: wasEditing, draft: text, value: saved, saving: inFlight, onSave: persist, canSaveOnLeave: canSave } = latest.current;
      if (wasEditing && !inFlight && text !== saved && (canSave?.() ?? true)) void persist(text);
    },
    [],
  );

  const editButton = readOnly ? null : (
    <Button
      ref={editButtonRef}
      size="sm"
      variant="ghost"
      icon={<Pencil />}
      aria-label={`Edit ${label.toLowerCase()}`}
      onClick={start}
      hideLabelOnMobile
      className={heading ? '-mr-2' : 'absolute right-0 top-0'}
    >
      Edit
    </Button>
  );
  const headingRow = (action: ReactNode) =>
    heading ? (
      <div className="mb-2 flex min-h-9 items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">{heading}</h2>
        {action}
      </div>
    ) : null;

  if (editing) {
    return (
      <div className={className}>
        {headingRow(null)}
        <MarkdownEditor
          value={draft}
          onChange={setDraft}
          onSubmit={() => void save()}
          onCancel={() => void cancel()}
          autoFocus
          aria-label={label}
          maxLength={LIMITS.descriptionMax}
          minRows={4}
          actions={
            <>
              <Button size="sm" variant="ghost" onClick={() => void cancel()} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
                Save
              </Button>
            </>
          }
        />
      </div>
    );
  }

  if (!value.trim()) {
    if (readOnly) {
      return (
        <div className={className}>
          {headingRow(null)}
          <p className="text-sm text-fg-subtle">No description.</p>
        </div>
      );
    }
    return (
      <div className={className}>
        {headingRow(null)}
        <button
          ref={editButtonRef}
          type="button"
          onClick={start}
          aria-label={`${label}: empty. ${emptyLabel}`}
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 text-left text-sm text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
        >
          <Plus aria-hidden className="size-4" />
          {emptyLabel}
        </button>
      </div>
    );
  }

  const clamped = clampPx > 0 && overflowing && !expanded;
  const fade = 'linear-gradient(to bottom, #000 calc(100% - 3rem), transparent)';
  return (
    <div className={clsx('relative min-w-0', className)}>
      {headingRow(editButton)}
      <div
        ref={bodyRef}
        className={clsx('min-w-0', !heading && !readOnly && 'pr-12 md:pr-20', clamped && 'overflow-hidden')}
        style={clamped ? { maxHeight: clampPx, maskImage: fade, WebkitMaskImage: fade } : undefined}
      >
        <Markdown source={value} />
      </div>
      {overflowing && (
        <Button size="sm" variant="ghost" className="-ml-2 mt-1" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      )}
      {!heading && editButton}
    </div>
  );
}
