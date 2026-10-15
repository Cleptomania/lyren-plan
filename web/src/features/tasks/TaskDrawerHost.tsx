// Mounted once in AuthedApp. Shows the task from the ?task=<id> search param in a drawer.
// Stays tiny: the drawer content is a lazy chunk, loaded on first open and prefetched when
// the browser is idle.

import { lazy, Suspense, useEffect, useState } from 'react';
import { useOpenTaskId } from '../../lib/taskLinks';

const loadTaskDrawer = () => import('./TaskDrawer');
const TaskDrawer = lazy(loadTaskDrawer);

export function TaskDrawerHost() {
  const taskId = useOpenTaskId();
  const [mounted, setMounted] = useState(taskId !== null);
  if (taskId !== null && !mounted) setMounted(true);

  useEffect(() => {
    // Also mount the (closed) drawer once the chunk is in: React.lazy suspends on its first
    // render even for a cached chunk, and React 19 holds a suspended reveal for ~300 ms, which
    // would delay the first open.
    const prefetch = () => void loadTaskDrawer().then(() => setMounted(true), () => undefined);
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(prefetch, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  if (!mounted) return null;
  return (
    // No visual fallback: the chunk is usually prefetched, and the drawer animates in itself.
    <Suspense fallback={null}>
      <TaskDrawer taskId={taskId} />
    </Suspense>
  );
}
