// Mounted once in AuthedApp. Opens the "New task" dialog on the 'create-task' app event
// (openCreateTask(defaults)) and on the 'c' hotkey (prefilled from the current page).
// Stays tiny: the dialog is a lazy chunk, prefetched (and mounted closed) when the browser is
// idle so the first 'c' opens at once and the title catches every keystroke.

import { lazy, Suspense, useEffect, useState } from 'react';
import type { TaskCreateInput } from '@shared/schemas';
import { useCreateTaskDefaults } from '../../components/layout/useShellActions';
import { useAppEvent } from '../../lib/events';
import { useHotkey } from '../../lib/hooks';

const loadTaskCreateDialog = () => import('./TaskCreateDialog');
const TaskCreateDialog = lazy(loadTaskCreateDialog);

interface HostState {
  open: boolean;
  defaults: Partial<TaskCreateInput>;
  /** Remounts the dialog per opening so its draft starts from the current prefill. */
  session: number;
}

export function TaskCreateDialogHost() {
  // A getter: the task on screen (drawer / task page) is read from the cache at keypress time.
  const getPageDefaults = useCreateTaskDefaults();
  const [state, setState] = useState<HostState | null>(null);

  const show = (defaults: Partial<TaskCreateInput>) =>
    setState((s) => (s?.open ? s : { open: true, defaults, session: (s?.session ?? 0) + 1 }));

  // Mount the closed dialog once its chunk is in: React.lazy suspends on its first render even
  // for a cached chunk, and React 19 holds a suspended reveal for ~300 ms.
  useEffect(() => {
    const warm = () =>
      void loadTaskCreateDialog().then(
        () => setState((s) => s ?? { open: false, defaults: {}, session: 0 }),
        () => undefined,
      );
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(warm, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  useAppEvent('create-task', show);
  useHotkey('c', (e) => {
    e.preventDefault();
    show(getPageDefaults());
  });

  if (!state) return null;
  return (
    <Suspense fallback={null}>
      <TaskCreateDialog
        key={state.session}
        open={state.open}
        defaults={state.defaults}
        onClose={() => setState((s) => (s ? { ...s, open: false } : s))}
      />
    </Suspense>
  );
}
