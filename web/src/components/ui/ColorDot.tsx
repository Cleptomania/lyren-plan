import { clsx } from 'clsx';

export interface ColorDotProps {
  color: string;
  size?: 'xs' | 'sm' | 'md';
  /** Accessible name; omit when the dot is decorative (next to a text label). */
  label?: string;
  /** Rounded square instead of a circle (e.g. projects). */
  square?: boolean;
  className?: string;
}

const SIZES = { xs: 'size-1.5', sm: 'size-2', md: 'size-2.5' } as const;

/** Small swatch for an entity color (project, tag, epic…). */
export function ColorDot({ color, size = 'sm', label, square, className }: ColorDotProps) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx('inline-block shrink-0', SIZES[size], square ? 'rounded-[3px]' : 'rounded-full', className)}
      style={{ backgroundColor: color }}
    />
  );
}
