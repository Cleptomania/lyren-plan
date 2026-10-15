// The Windows app's one-time tray hint (TrayHint): only without a window (stopMode 'tray'), until
// dismissed, never on a phone or for the other distributions.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DesktopAppDTO } from '@shared/types';
import { showTrayHint, TRAY_HINT_TEXT, TRAY_HINT_TITLE, TrayHint } from './TrayHint';

const WIN: DesktopAppDTO = { exe: 'lyren-plan-0.1.0-win-x64.exe', windows: true };

describe('tray hint', () => {
  it('only for the Windows app in tray mode, not dismissed, not on a phone', () => {
    expect(showTrayHint({ ...WIN, stopMode: 'tray' }, false, false)).toBe(true);
    expect(showTrayHint({ ...WIN, stopMode: 'tray' }, true, false)).toBe(false);
    expect(showTrayHint({ ...WIN, stopMode: 'tray' }, false, true)).toBe(false);
    expect(showTrayHint({ ...WIN, stopMode: 'terminal' }, false, false)).toBe(false);
    expect(showTrayHint(WIN, false, false)).toBe(false);
    expect(showTrayHint(undefined, false, false)).toBe(false); // Node build, Docker
  });

  it('says where the icon is, how to quit, and how to keep it visible', () => {
    const html = renderToStaticMarkup(createElement(TrayHint, { desktop: { ...WIN, stopMode: 'tray' }, isMobile: false }));
    expect(html).toContain(TRAY_HINT_TITLE);
    expect(html).toContain('Got it');
    expect(TRAY_HINT_TEXT).toContain('right-click the Lyren Plan icon near the clock and choose Quit Lyren Plan');
    expect(TRAY_HINT_TEXT).toContain('Settings → Personalization → Taskbar → Other system tray icons');
    expect(TRAY_HINT_TEXT).toContain('Windows PowerShell');
    expect(renderToStaticMarkup(createElement(TrayHint, { desktop: WIN, isMobile: false }))).toBe('');
  });
});
