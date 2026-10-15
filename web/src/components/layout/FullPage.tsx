// Full-screen and in-page loading / error states used by the app gates and route Suspense.

import { Spinner } from '../ui/Spinner';
import { ErrorState } from '../ui/ErrorState';
import { AppMark } from './AppMark';

/** Whole-screen loading (auth / bootstrap gates). */
export function FullPageSpinner() {
  return (
    <div className="flex h-full min-h-dvh flex-col items-center justify-center gap-5 bg-bg text-fg-muted">
      <AppMark size={36} className="opacity-90" />
      <Spinner size="md" />
    </div>
  );
}

/** In-page loading (lazy route chunks). Delayed slightly so fast loads don't flash a spinner. */
export function PageSpinner() {
  return (
    <div className="flex min-h-48 items-center justify-center p-8 text-fg-subtle motion-safe:animate-[fade-in_200ms_ease-out_150ms_both]">
      <Spinner size="md" />
    </div>
  );
}

export function FullPageError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex h-full min-h-dvh items-center justify-center bg-bg p-6">
      <ErrorState error={error} onRetry={onRetry} />
    </div>
  );
}
