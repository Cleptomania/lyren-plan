// Task description: rendered Markdown; clicking it (or "Edit") opens the MarkdownEditor.
// Saves on blur, mod+Enter and Esc (Esc leaves the editor like a blur does, so a second Esc
// closes the drawer with the text kept); only the Cancel button discards, after asking when
// there are changes. A failed save reopens the editor with the draft. Read-only for a role that may
// not change tasks (design §12.9).

import { clsx } from 'clsx';
import { Pencil } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import { LIMITS } from '@shared/constants';
import type { TaskUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { Button, IconButton, Markdown, MarkdownEditor, useConfirm } from '../../components/ui';

export interface TaskDescriptionProps {
  task: TaskDTO;
  save: (patch: TaskUpdateInput) => Promise<TaskDTO>;
  /** Show the description only (viewers). */
  readOnly?: boolean;
}

export function TaskDescription({ task, save, readOnly = false }: TaskDescriptionProps) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  /** Set once an edit session ended (saved or cancelled) so the trailing blur is ignored. */
  const finished = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const headingId = `task-${task.id}-description`;

  // Continue writing at the end of an existing description (autofocus puts the caret first).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (editing && el) el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const start = () => {
    setDraft(task.description);
    finished.current = false;
    setEditing(true);
  };

  const cancel = async () => {
    if (finished.current) return;
    // Ends the edit session first: the confirm takes focus, and the blur must not save the
    // text the user is about to discard.
    finished.current = true;
    if (draft.replace(/\s+$/, '') !== task.description) {
      const discard = await confirm({
        title: 'Discard changes?',
        body: 'Your edits to the description will be lost.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!discard) {
        // Keep editing (blur / Save / Esc save again).
        finished.current = false;
        requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
        return;
      }
    }
    setEditing(false);
  };

  const commit = (text: string) => {
    if (finished.current) return;
    finished.current = true;
    setEditing(false);
    const next = text.replace(/\s+$/, '');
    if (next === task.description) return;
    save({ description: next }).catch(() => {
      // Keep the user's text: reopen the editor with it.
      setDraft(next);
      finished.current = false;
      setEditing(true);
    });
  };

  // Leaving the task while editing (e.g. another card opened in the drawer) still saves.
  const latest = useRef({ editing, draft, commit });
  latest.current = { editing, draft, commit };
  useEffect(
    () => () => {
      const { editing: wasEditing, draft: text, commit: save } = latest.current;
      if (wasEditing) save(text);
    },
    [],
  );

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    commit(draft);
  };

  const onViewClick = (e: MouseEvent<HTMLDivElement>) => {
    // Links and task-list checkboxes inside the Markdown keep their own behaviour.
    if ((e.target as HTMLElement).closest('a, button, input, summary')) return;
    if (window.getSelection()?.toString()) return; // selecting text is not a request to edit
    start();
  };

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h2 id={headingId} className="text-[13px] font-semibold text-fg-muted">
          Description
        </h2>
        {!editing && !readOnly && task.description && (
          <IconButton size="sm" aria-label="Edit description" icon={<Pencil />} onClick={start} />
        )}
      </div>
      {readOnly ? (
        task.description ? (
          <div className="min-w-0 py-1 text-sm">
            <Markdown source={task.description} />
          </div>
        ) : (
          <p className="py-1 text-sm text-fg-subtle">No description.</p>
        )
      ) : editing ? (
        <div onBlur={onBlur}>
          <MarkdownEditor
            value={draft}
            onChange={setDraft}
            onSubmit={() => commit(draft)}
            onCancel={() => commit(draft)}
            textareaRef={textareaRef}
            autoFocus
            minRows={5}
            maxLength={LIMITS.descriptionMax}
            aria-label="Description"
            placeholder="Add a description… (Markdown supported)"
            actions={
              <>
                {/* preventDefault on mousedown keeps focus in the editor (Safari does not focus buttons). */}
                <Button size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => void cancel()}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(draft)}>
                  Save
                </Button>
              </>
            }
          />
        </div>
      ) : task.description ? (
        <div
          onClick={onViewClick}
          className={clsx('-mx-2 min-w-0 cursor-text rounded-md px-2 py-1 text-sm transition-colors hover:bg-surface-2')}
        >
          <Markdown source={task.description} />
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="-mx-2 flex min-h-10 items-center rounded-md px-2 text-left text-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-muted"
        >
          Add a description…
        </button>
      )}
    </section>
  );
}
