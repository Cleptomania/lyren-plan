// Status glyph whose SHAPE encodes the category (color is the status's own color):
//   backlog = dashed circle · unstarted = empty circle · started = ring with a partial pie
//   completed = filled circle with a check · cancelled = filled circle with an x

import type { StatusCategory } from '@shared/constants';
import type { StatusDTO } from '@shared/types';

export type StatusLike = Pick<StatusDTO, 'name' | 'category' | 'color'>;

export interface StatusIconProps {
  status: StatusLike;
  /** Pie fill (0..1) for 'started' statuses; see statusFraction(). Default 0.5. */
  fraction?: number;
  /** Pixel size (default 16). */
  size?: number;
  /** Accessible name (default: the status name); null = decorative (next to the name in text). */
  label?: string | null;
  className?: string;
}

const STROKE = 1.5;
const RING_R = 6;
const PIE_R = 3.25;

function piePath(fraction: number): string | null {
  const f = Math.min(1, Math.max(0, fraction));
  if (f <= 0) return null;
  if (f >= 1) return `M8 ${8 - PIE_R}A${PIE_R} ${PIE_R} 0 1 1 7.999 ${8 - PIE_R}Z`;
  const angle = f * 2 * Math.PI;
  const x = 8 + PIE_R * Math.sin(angle);
  const y = 8 - PIE_R * Math.cos(angle);
  return `M8 8L8 ${8 - PIE_R}A${PIE_R} ${PIE_R} 0 ${f > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)}Z`;
}

function Glyph({ category, fraction }: { category: StatusCategory; fraction: number }) {
  switch (category) {
    case 'backlog':
      // 10 dashes around the ring (circumference ≈ 37.7).
      return <circle cx={8} cy={8} r={RING_R} fill="none" stroke="currentColor" strokeWidth={STROKE} strokeDasharray="2.27 1.5" />;
    case 'unstarted':
      return <circle cx={8} cy={8} r={RING_R} fill="none" stroke="currentColor" strokeWidth={STROKE} />;
    case 'started': {
      const pie = piePath(fraction);
      return (
        <>
          <circle cx={8} cy={8} r={RING_R} fill="none" stroke="currentColor" strokeWidth={STROKE} />
          {pie && <path d={pie} fill="currentColor" />}
        </>
      );
    }
    case 'completed':
      return (
        <>
          <circle cx={8} cy={8} r={RING_R + STROKE / 2} fill="currentColor" />
          <path d="M5.1 8.15 7.15 10.2 10.9 6.2" fill="none" stroke="var(--surface)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case 'cancelled':
      return (
        <>
          <circle cx={8} cy={8} r={RING_R + STROKE / 2} fill="currentColor" />
          <path d="M5.9 5.9 10.1 10.1M10.1 5.9 5.9 10.1" fill="none" stroke="var(--surface)" strokeWidth={1.6} strokeLinecap="round" />
        </>
      );
  }
}

export function StatusIcon({ status, fraction = 0.5, size = 16, label, className }: StatusIconProps) {
  const name = label === undefined ? status.name : label;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      role={name ? 'img' : undefined}
      aria-label={name ?? undefined}
      aria-hidden={name ? undefined : true}
      focusable="false"
      className={className}
      style={{ color: status.color, flexShrink: 0 }}
    >
      <Glyph category={status.category} fraction={fraction} />
    </svg>
  );
}
