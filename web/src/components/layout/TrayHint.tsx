// A one-time note for the Windows app in tray mode (BootstrapDTO.desktop.stopMode 'tray', SPEC §12.1):
// it runs without a window, so where is it and how is it stopped? Shown once per browser (and
// address) until dismissed; never for the Node build, Docker, Linux, a console window or a phone.

import { X } from 'lucide-react';
import type { DesktopAppDTO } from '@shared/types';
import { Button, IconButton } from '../ui';
import { isBoolean, usePersistentState } from './usePersistentState';

export const TRAY_HINT_KEY = 'lyren.trayHint.dismissed';

/** Whether to show the hint: the Windows app without a window, not yet dismissed, on a computer (not a phone). */
export function showTrayHint(desktop: DesktopAppDTO | undefined, dismissed: boolean, isMobile: boolean): boolean {
  return desktop?.stopMode === 'tray' && !dismissed && !isMobile;
}

export const TRAY_HINT_TITLE = 'Lyren Plan runs in the notification area';
export const TRAY_HINT_TEXT =
  'It keeps running without a window, also when you close this page. To quit it, right-click the Lyren Plan icon ' +
  'near the clock and choose Quit Lyren Plan. Windows may put new icons under the ^ arrow next to them; to keep it ' +
  'on the taskbar, turn it on under Settings → Personalization → Taskbar → Other system tray icons (it may be ' +
  'listed as Windows PowerShell, which shows the icon for Lyren Plan).';

export function TrayHint({ desktop, isMobile }: { desktop: DesktopAppDTO | undefined; isMobile: boolean }) {
  const [dismissed, setDismissed] = usePersistentState(TRAY_HINT_KEY, false, isBoolean);
  if (!showTrayHint(desktop, dismissed, isMobile)) return null;
  return (
    <section
      aria-labelledby="tray-hint-title"
      className="fixed right-4 bottom-4 z-30 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 rounded-lg border border-border bg-popover p-4 text-[13px] leading-relaxed text-fg-muted shadow-pop"
    >
      <div className="flex items-start gap-2">
        <h2 id="tray-hint-title" className="flex-1 text-sm font-semibold text-fg">
          {TRAY_HINT_TITLE}
        </h2>
        <IconButton aria-label="Dismiss" icon={<X />} size="sm" onClick={() => setDismissed(true)} />
      </div>
      <p>{TRAY_HINT_TEXT}</p>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setDismissed(true)}>
          Got it
        </Button>
      </div>
    </section>
  );
}
