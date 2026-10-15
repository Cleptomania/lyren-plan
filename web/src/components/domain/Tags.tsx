// Tag chips: colored dot + name in a neutral pill (readable for any tag color in both
// themes), with an optional remove button; TagList shows the first N and a "+k" chip.

import { clsx } from 'clsx';
import { X } from 'lucide-react';
import type { TagRef } from '@shared/types';
import { ColorDot } from '../ui';
import { Pill, type PillSize } from './Pill';

export interface TagChipProps {
  tag: TagRef;
  size?: PillSize;
  /** Shows an × button (accessible name "Remove tag <name>"). */
  onRemove?: (tag: TagRef) => void;
  className?: string;
}

export function TagChip({ tag, size = 'sm', onRemove, className }: TagChipProps) {
  return (
    <Pill
      size={size}
      tone="default"
      className={clsx(onRemove && (size === 'sm' ? 'pr-0.5' : 'pr-1'), className)}
      textClassName="max-w-[9rem]"
      icon={<ColorDot color={tag.color} size={size === 'sm' ? 'xs' : 'sm'} />}
      trailing={
        onRemove && (
          <button
            type="button"
            aria-label={`Remove tag ${tag.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(tag);
            }}
            className={clsx(
              'relative inline-flex shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-3 hover:text-fg',
              // Larger invisible hit area for touch.
              "before:absolute before:-inset-2 before:content-['']",
              size === 'sm' ? 'size-4' : 'size-5',
            )}
          >
            <X aria-hidden />
          </button>
        )
      }
    >
      <span className="sr-only">Tag </span>
      {tag.name}
    </Pill>
  );
}

export interface TagListProps {
  tags: readonly TagRef[];
  /** Show at most this many chips, then "+k" (default: all). */
  max?: number;
  size?: PillSize;
  /** Wrap onto several lines (default true); false keeps one line and clips. */
  wrap?: boolean;
  onRemove?: (tag: TagRef) => void;
  className?: string;
}

export function TagList({ tags, max, size = 'sm', wrap = true, onRemove, className }: TagListProps) {
  if (tags.length === 0) return null;
  const limit = max !== undefined && tags.length > max ? Math.max(0, max) : tags.length;
  const visible = tags.slice(0, limit);
  const hidden = tags.slice(limit);
  return (
    <span className={clsx('inline-flex min-w-0 max-w-full items-center gap-1', wrap ? 'flex-wrap' : 'overflow-hidden', className)}>
      {visible.map((tag) => (
        <TagChip key={tag.id} tag={tag} size={size} onRemove={onRemove} />
      ))}
      {hidden.length > 0 && (
        <Pill size={size} title={hidden.map((t) => t.name).join(', ')}>
          <span aria-hidden>+{hidden.length}</span>
          <span className="sr-only">
            and {hidden.length} more {hidden.length === 1 ? 'tag' : 'tags'}: {hidden.map((t) => t.name).join(', ')}
          </span>
        </Pill>
      )}
    </span>
  );
}
