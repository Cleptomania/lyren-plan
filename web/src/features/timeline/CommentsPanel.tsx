// Task comments: oldest → newest, own comments editable in place, and a composer that sticks
// to the bottom of the task drawer's scroll container (unsent drafts kept per task). Who may write,
// edit or delete follows the role (app/permissions.ts entryActions: admins and owners also delete
// anyone's comment; viewers only read), authors who left the space or whose account was deleted
// say so (lib/people.ts, design §12.9), and an imported comment says who imported it (ImportedNote).

import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { MessageSquare, MoreHorizontal, Pencil, Send, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { LIMITS } from '@shared/constants';
import type { CommentDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useAddComment, useDeleteComment, useUpdateComment } from '../../api/timeline';
import { entryActions, type EntryActions } from '../../app/permissions';
import { useSpace, useSpaceId } from '../../app/space';
import { UserAvatar } from '../../components/domain';
import { Button, IconButton, Markdown, MarkdownEditor, Menu, SkeletonText, toast, useConfirm } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { personLabel } from '../../lib/people';
import { ImportedNote } from './ImportedNote';
import { scrollBehavior } from '../../lib/motion';
import { clearDraft, readDraft, writeDraft } from './drafts';
import { commentLeaveBody, isGoneError, stillInTimeline } from './leaveSave';
import { RelativeTime } from './RelativeTime';

export interface CommentsPanelProps {
  taskId: number;
  /** undefined while the timeline loads. */
  comments: CommentDTO[] | undefined;
  /** Stick the composer to the bottom of the enclosing scroll container (task drawer). */
  stickyComposer: boolean;
}

export function CommentsPanel({ taskId, comments, stickyComposer }: CommentsPanelProps) {
  const { user, personById } = useLookups();
  const { permissions } = useSpace();
  const listRef = useRef<HTMLOListElement>(null);

  const revealLatest = () =>
    requestAnimationFrame(() => {
      const last = listRef.current?.lastElementChild;
      last?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
    });

  return (
    <div className="flex min-w-0 flex-col">
      {comments === undefined ? (
        <SkeletonText lines={3} className="py-2" />
      ) : comments.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-sm text-fg-muted">
          <MessageSquare aria-hidden className="size-4 text-fg-subtle" />
          No comments yet.
        </div>
      ) : (
        <ol ref={listRef} aria-label="Comments" className="flex min-w-0 flex-col gap-5 pb-4 pt-1">
          {comments.map((c) => (
            <li key={c.id} className="min-w-0 scroll-mb-48">
              <CommentItem comment={c} taskId={taskId} can={entryActions(permissions, c, user.id, personById)} />
            </li>
          ))}
        </ol>
      )}
      {permissions.write && <CommentComposer taskId={taskId} sticky={stickyComposer} onPosted={revealLatest} />}
    </div>
  );
}

// ---- One comment --------------------------------------------------------------------

function CommentItem({ comment, taskId, can }: { comment: CommentDTO; taskId: number; can: EntryActions }) {
  const sid = useSpaceId();
  const { user, personById } = useLookups();
  const qc = useQueryClient();
  const update = useUpdateComment(taskId);
  const remove = useDeleteComment(taskId);
  const confirm = useConfirm();
  const author = personLabel(comment.author, personById);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const deleting = remove.isPending;

  // Leaving while editing (drawer closed with Back / ← / ×, another task opened, timeline tab
  // switched) saves the edit, like the task title and description editors; only Cancel / Esc
  // discard it (after asking). Not when the comment is already gone (deleted elsewhere, signed
  // out). mutateAsync: the request and its error toast outlive this component.
  const latest = useRef({ editing, draft, body: comment.body, saving: update.isPending, save: update.mutateAsync, qc, sid, taskId, id: comment.id });
  latest.current = { editing, draft, body: comment.body, saving: update.isPending, save: update.mutateAsync, qc, sid, taskId, id: comment.id };
  useEffect(
    () => () => {
      const l = latest.current;
      const body = commentLeaveBody(l);
      if (body === null || !stillInTimeline(l.qc, l.sid, l.taskId, 'comments', l.id)) return;
      l.save({ id: l.id, body }).catch((err: unknown) => {
        if (!isGoneError(err)) toast.error(err);
      });
    },
    [],
  );

  const startEdit = () => {
    setDraft(comment.body);
    setEditing(true);
  };

  const cancelEdit = async () => {
    if (draft.trim() !== comment.body.trim()) {
      const discard = await confirm({ title: 'Discard your changes?', body: 'The comment stays as it was.', confirmLabel: 'Discard', danger: true });
      if (!discard) return;
    }
    setEditing(false);
  };

  const save = () => {
    const body = draft.trim();
    if (!body || update.isPending) return;
    if (body === comment.body) {
      setEditing(false);
      return;
    }
    update.mutate(
      { id: comment.id, body },
      {
        onSuccess: () => setEditing(false),
        onError: (err) => toast.error(err),
      },
    );
  };

  const del = async () => {
    const theirs = comment.author?.id !== user.id;
    const ok = await confirm({
      title: theirs ? `Delete ${author.name}’s comment?` : 'Delete this comment?',
      body: 'This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    // The item unmounts once the refreshed list drops it, so don't rely on mutate callbacks.
    remove.mutateAsync(comment.id).then(
      () => toast.success('Comment deleted'),
      (err: unknown) => toast.error(err),
    );
  };

  return (
    <article
      aria-label={`Comment by ${author.name}`}
      aria-busy={deleting || undefined}
      className={clsx('flex min-w-0 gap-3 transition-opacity', deleting && 'pointer-events-none opacity-50')}
    >
      <UserAvatar user={comment.author} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <header className="flex min-h-8 min-w-0 items-center gap-x-2 text-[13px]">
          <span className={clsx('min-w-0 truncate font-medium', author.gone ? 'italic text-fg-muted' : 'text-fg')}>{author.name}</span>
          {author.note && <span className="shrink-0 text-fg-muted">{author.note}</span>}
          <RelativeTime iso={comment.createdAt} className="shrink-0 text-fg-muted" />
          {comment.editedAt && (
            <span className="shrink-0 text-fg-subtle" title={`Edited ${formatDateTime(comment.editedAt)}`}>
              · edited
            </span>
          )}
          {(can.edit || can.delete) && !editing && (
            <Menu
              label="Comment actions"
              trigger={
                <IconButton
                  aria-label="Comment actions"
                  icon={<MoreHorizontal />}
                  size="sm"
                  loading={deleting}
                  className="-my-1 ml-auto -mr-1.5 shrink-0"
                />
              }
              items={[
                can.edit && { label: 'Edit', icon: <Pencil />, onSelect: startEdit },
                { separator: true },
                can.delete && { label: 'Delete…', icon: <Trash2 />, danger: true, onSelect: () => void del() },
              ]}
            />
          )}
        </header>
        <ImportedNote entry={comment} className="-mt-1 mb-1" />
        {editing ? (
          <MarkdownEditor
            aria-label="Edit comment"
            value={draft}
            onChange={setDraft}
            onSubmit={save}
            onCancel={() => void cancelEdit()}
            autoFocus
            minRows={3}
            maxRows={14}
            maxLength={LIMITS.commentMax}
            disabled={update.isPending}
            className="mt-1"
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={() => void cancelEdit()} disabled={update.isPending}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" onClick={save} loading={update.isPending} disabled={!draft.trim()}>
                  Save
                </Button>
              </>
            }
          />
        ) : (
          <Markdown source={comment.body} className="min-w-0 break-words text-sm" />
        )}
      </div>
    </article>
  );
}

// ---- Composer -----------------------------------------------------------------------

/**
 * Sticky elements stop at the scroll container's padding edge. To sit flush with the bottom
 * of the drawer (and paint over its bottom padding), offset `bottom` by that padding.
 */
function useScrollerBottomPadding(ref: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [padding, setPadding] = useState(0);
  useLayoutEffect(() => {
    if (!enabled) return;
    let scroller = ref.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    const el = scroller;
    const measure = () => setPadding(Number.parseFloat(getComputedStyle(el).paddingBottom) || 0);
    measure();
    // Safe-area padding changes with orientation.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, enabled]);
  return padding;
}

function CommentComposer({ taskId, sticky, onPosted }: { taskId: number; sticky: boolean; onPosted: () => void }) {
  const sid = useSpaceId();
  const add = useAddComment(taskId);
  const [draft, setDraft] = useState(() => readDraft(sid, 'comment', taskId) ?? '');
  const [expanded, setExpanded] = useState(() => draft !== '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerPadding = useScrollerBottomPadding(rootRef, sticky);
  const sending = add.isPending;

  const change = (value: string) => {
    setDraft(value);
    writeDraft(sid, 'comment', taskId, value);
  };

  const send = () => {
    const body = draft.trim();
    if (!body || sending) return;
    const hadFocus = document.activeElement === textareaRef.current;
    // mutateAsync (not mutate callbacks) so the saved draft is cleared even when the drawer
    // switched to another task meanwhile and this composer is gone.
    add.mutateAsync({ body }).then(
      () => {
        clearDraft(sid, 'comment', taskId);
        setDraft('');
        onPosted();
        if (hadFocus) requestAnimationFrame(() => textareaRef.current?.focus());
      },
      // The text stays in the editor (and in the saved draft) so nothing is lost.
      (err: unknown) => toast.error(err),
    );
  };

  // Esc leaves the editor (the draft is kept; a second Esc closes the drawer) and folds an
  // empty composer back into the one-line prompt. It deliberately doesn't fold on blur: the
  // height change would shift whatever the pointer is pressing at that moment.
  const promptRef = useRef<HTMLButtonElement>(null);
  const focusPrompt = useRef(false);
  const cancel = () => {
    if (draft.trim() !== '' || sending) return;
    focusPrompt.current = true;
    setExpanded(false);
  };
  useEffect(() => {
    if (expanded || !focusPrompt.current) return;
    focusPrompt.current = false;
    promptRef.current?.focus();
  }, [expanded]);

  return (
    <div
      ref={rootRef}
      style={sticky ? { bottom: -scrollerPadding } : undefined}
      className={clsx(
        'min-w-0',
        sticky
          ? [
              // Flush with the drawer's bottom edge; the composer pads the safe area itself.
              'sticky z-10 bg-popover pt-2 pb-safe-3',
              // The backdrop extends over the panel's side padding with a clipped box-shadow
              // (shadows never add scrollable overflow, unlike a wider pseudo-element).
              'border-t border-border [box-shadow:0_0_0_100vmax_var(--popover)] [clip-path:inset(0_-100vmax)]',
            ]
          : 'pt-1',
      )}
    >
      {expanded ? (
        <MarkdownEditor
          aria-label="New comment"
          value={draft}
          onChange={change}
          onSubmit={send}
          onCancel={cancel}
          autoFocus={draft === ''}
          placeholder="Leave a comment… (Markdown supported)"
          minRows={2}
          maxRows={10}
          maxLength={LIMITS.commentMax}
          disabled={sending}
          textareaRef={textareaRef}
          actions={
            <Button size="sm" variant="primary" icon={<Send />} onClick={send} loading={sending} disabled={!draft.trim()}>
              Comment
            </Button>
          }
        />
      ) : (
        <button
          ref={promptRef}
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-md border border-border bg-surface px-3 text-left text-sm text-fg-subtle transition-colors hover:border-border-strong"
        >
          <MessageSquare aria-hidden className="size-4 shrink-0" />
          Leave a comment…
        </button>
      )}
    </div>
  );
}
