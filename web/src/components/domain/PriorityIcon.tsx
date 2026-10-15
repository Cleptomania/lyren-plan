// Priority glyph (Linear style): none = three dashes, low/medium/high = 1/2/3 of three
// rising bars, urgent = filled square with "!". Shape carries the meaning; color helps.

import { PRIORITY_META, type Priority } from '@shared/constants';

export interface PriorityIconProps {
  priority: Priority;
  /** Pixel size (default 16). */
  size?: number;
  /** Accessible name (default "High priority", "No priority" …); null = decorative. */
  label?: string | null;
  className?: string;
}

/** "High priority" / "No priority". */
export function priorityLabel(priority: Priority): string {
  return priority === 0 ? PRIORITY_META[0].label : `${PRIORITY_META[priority].label} priority`;
}

/** Priority color tuned for contrast in both themes (mixed toward the text color). */
export function priorityColor(priority: Priority): string {
  return priority === 0 ? 'var(--fg-subtle)' : `color-mix(in srgb, ${PRIORITY_META[priority].color} 82%, var(--fg))`;
}

const BARS = [
  { x: 2, h: 6 },
  { x: 6.5, h: 9 },
  { x: 11, h: 12 },
] as const;

function Glyph({ priority }: { priority: Priority }) {
  if (priority === 0) {
    return (
      <g fill="currentColor">
        <rect x={1.5} y={7.25} width={3.2} height={1.5} rx={0.75} />
        <rect x={6.4} y={7.25} width={3.2} height={1.5} rx={0.75} />
        <rect x={11.3} y={7.25} width={3.2} height={1.5} rx={0.75} />
      </g>
    );
  }
  if (priority === 4) {
    return (
      <>
        <rect x={1} y={1} width={14} height={14} rx={3.5} fill="currentColor" />
        <rect x={7.1} y={3.6} width={1.8} height={5.6} rx={0.9} fill="var(--surface)" />
        <circle cx={8} cy={11.7} r={1.1} fill="var(--surface)" />
      </>
    );
  }
  return (
    <g fill="currentColor">
      {BARS.map((bar, i) => (
        <rect key={bar.x} x={bar.x} y={14 - bar.h} width={3} height={bar.h} rx={1} opacity={i < priority ? 1 : 0.28} />
      ))}
    </g>
  );
}

export function PriorityIcon({ priority, size = 16, label, className }: PriorityIconProps) {
  const name = label === undefined ? priorityLabel(priority) : label;
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
      style={{ color: priorityColor(priority), flexShrink: 0 }}
    >
      <Glyph priority={priority} />
    </svg>
  );
}
