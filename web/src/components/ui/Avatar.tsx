import { clsx } from 'clsx';
import { initials } from './text';

export interface AvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  xs: 'size-5 text-[9px]',
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const;

/** Initials avatar (decorative; put the name in text next to it or in an aria-label). */
export function Avatar({ name, size = 'md', className }: AvatarProps) {
  return (
    <span
      aria-hidden
      title={name}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full bg-accent-soft font-semibold text-accent',
        SIZES[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
