// React.lazy for overlay chunks that must never take the app down: when the chunk can't be
// loaded (offline before it was cached, or a stale deploy), opening shows an error toast and
// closes again instead of throwing into the router's error boundary; the next open retries.

import { lazy, useEffect, useMemo, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { servedFromThisComputer } from '../../api/networkError';
import { toast } from '../../components/ui/Toast';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
}

function LoadFailed({ open, onClose, what, onRetry }: OverlayProps & { what: string; onRetry: () => void }) {
  useEffect(() => {
    if (!open) return;
    const hint = servedFromThisComputer()
      ? 'If Lyren Plan runs on this computer, start it again, then try again.'
      : 'Check your connection and try again.';
    toast.error(`Couldn’t load ${what}. ${hint}`);
    onClose();
    onRetry();
    // Runs once per open; the callbacks are stable.
  }, [open]);
  return null;
}

export function useLazyOverlay<P extends OverlayProps>(
  load: () => Promise<{ default: ComponentType<P> }>,
  what: string,
): LazyExoticComponent<ComponentType<P>> {
  const [attempt, setAttempt] = useState(0);
  return useMemo(
    () =>
      lazy(() =>
        load().catch(() => ({
          default: (props: P) => (
            <LoadFailed open={props.open} onClose={props.onClose} what={what} onRetry={() => setAttempt((a) => a + 1)} />
          ),
        })),
      ),
    // `attempt` re-creates the lazy component so the import is tried again.
    [load, what, attempt],
  );
}
