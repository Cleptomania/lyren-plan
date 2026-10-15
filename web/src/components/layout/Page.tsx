// Page containers. Pages scroll the document; board pages use FullBleedPage, a fixed-height
// (100dvh-based) column whose content manages its own scrolling.

import { clsx } from 'clsx';
import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';

export type PageWidth = 'narrow' | 'default' | 'wide' | 'full';

export const PAGE_WIDTHS: Record<PageWidth, string> = {
  narrow: 'max-w-3xl',
  default: 'max-w-5xl',
  wide: 'max-w-7xl',
  full: 'max-w-none',
};

const PageWidthContext = createContext<PageWidth>('full');

/** Max-width class of the enclosing Page (PageHeader aligns its content with it). */
export function usePageWidthClass(): string {
  return PAGE_WIDTHS[useContext(PageWidthContext)];
}

/** Lets FullBleedPage tell the AppShell to drop the document-scrolling bottom padding. */
export const ShellLayoutContext = createContext<{ registerFullBleed: () => () => void } | null>(null);

export interface PageProps {
  /** Usually a <PageHeader>; rendered full-width above the content, aligned to `width`. */
  header?: ReactNode;
  children: ReactNode;
  /** Content max width: narrow 48rem · default 64rem · wide 80rem · full. */
  width?: PageWidth;
  className?: string;
}

/** Standard document-scrolling page: header + padded, centered content. */
export function Page({ header, children, width = 'default', className }: PageProps) {
  return (
    <PageWidthContext.Provider value={width}>
      {header}
      <div className={clsx('mx-auto w-full min-w-0 px-4 py-4 md:px-6 md:py-6', PAGE_WIDTHS[width], className)}>{children}</div>
    </PageWidthContext.Provider>
  );
}

export interface FullBleedPageProps {
  header?: ReactNode;
  /** Fills the remaining height; give your scroller `h-full overflow-auto` (or flex children). */
  children: ReactNode;
  className?: string;
}

/**
 * Short viewports (phones in landscape, small phones with browser bars: ≤ 600px tall) can't fit
 * the board chrome AND cards. There FullBleedPage becomes a vertical scroller whose header (and
 * any other chrome) scrolls away, and the element carrying FULL_BLEED_MAIN (the board area)
 * keeps exactly the visible app height, so scrolling to the end shows a full-height board.
 * The document itself still never scrolls.
 */
export const FULL_BLEED_MAIN = '[@media(max-height:600px)]:h-app-screen [@media(max-height:600px)]:flex-none';

/**
 * Fixed-height page for boards: exactly fills the viewport above the mobile tab bar (dvh,
 * so it follows the mobile browser toolbars). The document does not scroll; the content
 * area (`flex-1 min-h-0`) does its own scrolling. See FULL_BLEED_MAIN for short viewports.
 */
export function FullBleedPage({ header, children, className }: FullBleedPageProps) {
  const shell = useContext(ShellLayoutContext);
  useLayoutEffect(() => shell?.registerFullBleed(), [shell]);
  return (
    <PageWidthContext.Provider value="full">
      <div
        className={clsx(
          'flex h-app-screen min-h-0 flex-col overflow-hidden',
          '[@media(max-height:600px)]:overflow-y-auto [@media(max-height:600px)]:overscroll-y-contain [@media(max-height:600px)]:[&>header]:static',
        )}
      >
        {header}
        <div className={clsx('relative flex min-h-0 flex-1 flex-col [@media(max-height:600px)]:flex-none', className)}>{children}</div>
      </div>
    </PageWidthContext.Provider>
  );
}
