import { WifiOff } from 'lucide-react';

/** Thin banner shown while offline: above the tab bar on phones, along the bottom of the content on desktop. */
export function OfflineBanner({ left }: { left: string }) {
  return (
    <div
      role="status"
      data-bottom-chrome=""
      style={{ left }}
      className="fixed right-0 bottom-[var(--bottom-bar-h)] z-30 flex h-7 items-center justify-center gap-1.5 border-t border-warning/30 bg-warning-soft px-3 text-xs font-medium text-warning"
    >
      <WifiOff aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">Offline — changes can’t be saved</span>
    </div>
  );
}
