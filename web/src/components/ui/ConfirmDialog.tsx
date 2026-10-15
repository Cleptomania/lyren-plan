// Confirmation dialogs. Imperative, promise-based use (preferred):
//
//   const confirm = useConfirm();
//   if (await confirm({ title: 'Delete project?', body: '…', danger: true, typeToConfirm: project.key })) …
//
// <ConfirmHost /> renders the requests; AppShell mounts it. <ConfirmDialog> is the
// controlled component underneath, for the rare case that needs one directly.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Field } from './Field';
import { Input } from './Input';
import type { OverlayControls } from './internal/overlayControls';
import { useSheetMode } from './internal/useSheetMode';

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  /** Default "Confirm" ("Delete" reads better for danger). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button; Cancel gets the initial focus. */
  danger?: boolean;
  /** Require typing this exact text (e.g. a project key) before confirming. */
  typeToConfirm?: string;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Spinner on the confirm button (when the caller awaits work before closing). */
  busy?: boolean;
  /** Imperative handle of the underlying Dialog (ConfirmHost waits for its history entry). */
  controlsRef?: Ref<OverlayControls>;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  busy,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  typeToConfirm,
  controlsRef,
}: ConfirmDialogProps) {
  // Phones / touch: Back cancels the confirm (it is the top overlay, SPEC §9).
  const backCancels = useSheetMode();
  const [typed, setTyped] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);
  const matches = !typeToConfirm || typed.trim() === typeToConfirm;

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      mobileLayout="center"
      history={backCancels}
      controlsRef={controlsRef}
      hideCloseButton
      initialFocus={typeToConfirm ? inputRef : danger ? cancelRef : confirmRef}
      onSubmit={() => {
        if (matches && !busy) onConfirm();
      }}
      footer={
        <>
          <Button ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} type="submit" variant={danger ? 'danger' : 'primary'} disabled={!matches} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm text-fg-muted">
        {body && <div className="break-words">{body}</div>}
        {typeToConfirm && (
          <Field
            label={
              <>
                Type <span className="font-mono font-semibold text-fg">{typeToConfirm}</span> to confirm
              </>
            }
          >
            <Input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

// ---- Imperative API -------------------------------------------------------------------

interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let queue: PendingConfirm[] = [];
let nextId = 1;
let hosts = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => queue[0];

/** Ask for confirmation; resolves true when confirmed, false when cancelled/dismissed. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  if (hosts === 0) {
    // No host mounted (should not happen inside the app shell): degrade to the native dialog.
    console.warn('confirm() called without a mounted <ConfirmHost />');
    return Promise.resolve(window.confirm(options.title));
  }
  return new Promise<boolean>((resolve) => {
    queue = [...queue, { ...options, id: nextId++, resolve }];
    emit();
  });
}

/**
 * Remove a request and resolve it. `defer` (the dialog's afterClose) delays the resolution
 * until the dialog has closed and its history entry is gone, so a caller that navigates or
 * opens another overlay right after `await confirm()` cannot race with that history.back().
 */
function settle(id: number, ok: boolean, defer?: (run: () => void) => void) {
  const item = queue.find((q) => q.id === id);
  if (!item) return;
  if (defer) defer(() => item.resolve(ok));
  queue = queue.filter((q) => q.id !== id);
  emit();
  if (!defer) item.resolve(ok);
}

/** Stable `confirm` function (SPEC §9.1). */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return confirm;
}

export interface ConfirmHostProps {
  /**
   * Pending confirms are cancelled when this changes (AppShell passes the route's path and
   * query): a confirm must never outlive the page it was asked on.
   */
  resetKey?: string;
}

/** Renders pending confirm() requests one at a time. Mount once (AppShell does). */
export function ConfirmHost({ resetKey }: ConfirmHostProps = {}) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  // Keep the last request around so the dialog can animate out with its content.
  const [shown, setShown] = useState<PendingConfirm | undefined>(current);
  if (current && current !== shown) setShown(current);
  const controls = useRef<OverlayControls>(null);

  useEffect(() => {
    hosts++;
    return () => {
      hosts--;
      // Unmounting (e.g. sign-out) cancels anything still pending.
      if (hosts === 0) for (const q of queue) settle(q.id, false);
    };
  }, []);

  const lastKey = useRef(resetKey);
  useEffect(() => {
    if (lastKey.current === resetKey) return;
    lastKey.current = resetKey;
    for (const q of queue) settle(q.id, false);
  }, [resetKey]);

  if (!shown) return null;
  const { id, resolve: _resolve, ...options } = shown;
  const finish = (ok: boolean) => {
    const dialog = controls.current;
    settle(id, ok, dialog ? (run) => dialog.afterClose(run) : undefined);
  };
  return (
    <ConfirmDialog
      key={id}
      {...options}
      controlsRef={controls}
      open={current?.id === id}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />
  );
}
