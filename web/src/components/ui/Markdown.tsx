// Safe Markdown rendering (GFM: tables, task lists, strikethrough, autolinks). Raw HTML is
// shown as text, links open in a new tab, remote images become links. The renderer is
// lazy-loaded; until it arrives the plain source is shown.

import { clsx } from 'clsx';
import { lazy, Suspense } from 'react';

const loadRenderer = () => import('./MarkdownRenderer');
const MarkdownRenderer = lazy(loadRenderer);

/** Start loading the renderer chunk early (e.g. when idle or on hover). */
export function preloadMarkdown(): void {
  void loadRenderer();
}

export interface MarkdownProps {
  source: string;
  className?: string;
}

export function Markdown({ source, className }: MarkdownProps) {
  return (
    <Suspense fallback={<div className={clsx('markdown whitespace-pre-wrap', className)}>{source}</div>}>
      <MarkdownRenderer source={source} className={className} />
    </Suspense>
  );
}
