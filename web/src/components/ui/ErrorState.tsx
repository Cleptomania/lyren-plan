import { clsx } from 'clsx';
import { CloudOff, RotateCw, TriangleAlert } from 'lucide-react';
import { ApiError, errorMessage } from '../../api/client';
import { unreachableText } from '../../api/networkError';
import { Button } from './Button';

export interface ErrorStateProps {
  /** Anything thrown (ApiError, Error, unknown). */
  error: unknown;
  /** Shows a "Try again" button. */
  onRetry?: () => void;
  /** Overrides the heading (default depends on the error). */
  title?: string;
  /** 'sm' for inside cards / panels, 'md' (default) for whole pages. */
  size?: 'sm' | 'md';
  className?: string;
}

function describe(error: unknown): { title: string; body: string; offline: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'network_error') {
      const { title, body } = unreachableText();
      return { title, body, offline: true };
    }
    if (error.status === 404) return { title: 'Not found', body: error.message, offline: false };
    if (error.status === 403) return { title: 'Not allowed', body: error.message, offline: false };
  }
  return { title: 'Something went wrong', body: errorMessage(error), offline: false };
}

/** Error placeholder for failed queries, with an optional retry. */
export function ErrorState({ error, onRetry, title, size = 'md', className }: ErrorStateProps) {
  const d = describe(error);
  return (
    <div
      role="alert"
      className={clsx('flex flex-col items-center justify-center text-center', size === 'md' ? 'gap-3 px-6 py-14' : 'gap-2 px-4 py-8', className)}
    >
      <div
        aria-hidden
        className={clsx(
          'flex items-center justify-center rounded-xl',
          d.offline ? 'bg-surface-2 text-fg-muted' : 'bg-danger-soft text-danger',
          size === 'md' ? 'mb-1 size-11 [&_svg]:size-5' : 'size-9 [&_svg]:size-4',
        )}
      >
        {d.offline ? <CloudOff /> : <TriangleAlert />}
      </div>
      <div className="flex max-w-md flex-col gap-1">
        <p className={clsx('font-semibold text-fg', size === 'md' ? 'text-[15px]' : 'text-sm')}>{title ?? d.title}</p>
        <p className="text-sm break-words text-fg-muted">{d.body}</p>
      </div>
      {onRetry && (
        <Button size="sm" icon={<RotateCw />} onClick={onRetry} className="mt-1">
          Try again
        </Button>
      )}
    </div>
  );
}
