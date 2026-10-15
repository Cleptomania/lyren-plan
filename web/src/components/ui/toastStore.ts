// Toast queue (framework-free, unit-tested). The React side lives in Toast.tsx.

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastOptions {
  /** One action button, e.g. { label: 'Undo', onClick }. Clicking it also dismisses the toast. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss delay (ms). Defaults: 4000; 6000 for errors and toasts with an action. 0 = sticky. */
  durationMs?: number;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastOptions['action'];
  durationMs: number;
  /** How many times the same message was shown while visible ("×3"). */
  count: number;
  /** Bumped when a duplicate re-shows the toast (restarts its timer). */
  version: number;
  /** Set while the exit animation runs. */
  closing: boolean;
}

export const TOAST_EXIT_MS = 180;

export function defaultToastDuration(kind: ToastKind, opts: ToastOptions): number {
  if (opts.durationMs !== undefined) return opts.durationMs;
  return opts.action || kind === 'error' ? 6000 : 4000;
}

export function createToastStore(maxVisible = 3) {
  let items: ToastItem[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  function remove(id: number) {
    const next = items.filter((t) => t.id !== id);
    if (next.length !== items.length) {
      items = next;
      emit();
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot(): readonly ToastItem[] {
      return items;
    },
    /** Show a toast; returns its id. An identical visible toast (no action) is refreshed instead. */
    show(kind: ToastKind, message: string, opts: ToastOptions = {}): number {
      const dup = !opts.action && items.find((t) => !t.closing && !t.action && t.kind === kind && t.message === message);
      if (dup) {
        items = items.map((t) => (t === dup ? { ...t, count: t.count + 1, version: t.version + 1 } : t));
        emit();
        return dup.id;
      }
      const toast: ToastItem = {
        id: nextId++,
        kind,
        message,
        action: opts.action,
        durationMs: defaultToastDuration(kind, opts),
        count: 1,
        version: 0,
        closing: false,
      };
      const open = items.filter((t) => !t.closing);
      const dropped = new Set(open.slice(0, Math.max(0, open.length + 1 - maxVisible)).map((t) => t.id));
      items = [...items.filter((t) => !dropped.has(t.id)), toast];
      emit();
      return toast.id;
    },
    /** Start the exit animation, then remove. */
    dismiss(id: number): void {
      const t = items.find((x) => x.id === id);
      if (!t || t.closing) return;
      items = items.map((x) => (x.id === id ? { ...x, closing: true } : x));
      emit();
      setTimeout(() => remove(id), TOAST_EXIT_MS);
    },
    clear(): void {
      items = [];
      emit();
    },
  };
}

export type ToastStore = ReturnType<typeof createToastStore>;
