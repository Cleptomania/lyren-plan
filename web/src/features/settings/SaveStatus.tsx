// "Saving… / Saved" next to a settings page's heading, for settings that save as they change (the
// mutations update their caches optimistically and roll back on failure).

import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '../../components/ui';

export type SaveState = 'idle' | 'saving' | 'saved';

/** `begin()` before each save, `end(ok)` when it settles; overlapping saves report once all are done. */
export function useSaveState() {
  const [state, setState] = useState<SaveState>('idle');
  const inFlight = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const begin = useCallback(() => {
    window.clearTimeout(timer.current);
    inFlight.current++;
    setState('saving');
  }, []);
  const end = useCallback((ok: boolean) => {
    inFlight.current--;
    if (inFlight.current > 0) return;
    setState(ok ? 'saved' : 'idle');
    if (ok) timer.current = window.setTimeout(() => setState('idle'), 2000);
  }, []);
  return { state, begin, end };
}

export function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span aria-live="polite" className="flex h-8 items-center gap-1.5 text-xs text-fg-muted">
      {state === 'saving' && (
        <>
          <Spinner size="xs" label={null} /> Saving…
        </>
      )}
      {state === 'saved' && (
        <>
          <Check aria-hidden className="size-3.5 text-success" /> Saved
        </>
      )}
    </span>
  );
}
