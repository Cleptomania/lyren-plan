// The setup code in the URL fragment. The desktop app opens /setup#code=<code> on its first start
// so the code is filled in; SetupPage reads it once and removes it from the address bar. (A
// fragment never reaches the server, so the code stays out of request logs.)

import { SETUP_CODE_FRAGMENT_PARAM } from '@shared/constants';
import type { DesktopAppDTO } from '@shared/types';

const MAX_CODE = 200;

function params(hash: string): URLSearchParams {
  return new URLSearchParams(hash.replace(/^#/, ''));
}

/** The setup code in `hash` (e.g. '#code=1a2b3c'), or null. */
export function setupCodeFromHash(hash: string): string | null {
  const code = params(hash).get(SETUP_CODE_FRAGMENT_PARAM)?.trim();
  return code ? code.slice(0, MAX_CODE) : null;
}

/** `hash` without the setup code: '' when nothing else is left, else '#…'. */
export function hashWithoutSetupCode(hash: string): string {
  const p = params(hash);
  p.delete(SETUP_CODE_FRAGMENT_PARAM);
  const rest = p.toString();
  return rest ? `#${rest}` : '';
}

/**
 * Where to find the setup code (the field's hint) and what to do about a wrong one. The Windows app
 * without a window (stopMode 'tray') keeps it out of its log file, but starting it again opens this
 * page with the code filled in; elsewhere it is in the app's window or the server log.
 */
export function setupCodeHelp(desktop: DesktopAppDTO | undefined): { hint: string; invalid: string } {
  if (desktop?.stopMode === 'tray') {
    return {
      hint: 'Start Lyren Plan again to open this page with the code filled in.',
      invalid: 'Invalid setup code — start Lyren Plan again to open this page with the code filled in',
    };
  }
  return {
    hint: 'Shown in the Lyren Plan window or server log when it started (or the SETUP_TOKEN you configured).',
    invalid: 'Invalid setup code — check the Lyren Plan window or server log',
  };
}
