import { describe, expect, it } from 'vitest';
import { hashWithoutSetupCode, setupCodeFromHash, setupCodeHelp } from './setupLink';

describe('setup code in the URL fragment', () => {
  it('reads the code the desktop app puts in the fragment', () => {
    expect(setupCodeFromHash('#code=1a2b3c4d5e6f')).toBe('1a2b3c4d5e6f');
    expect(setupCodeFromHash('code=1a2b')).toBe('1a2b');
    expect(setupCodeFromHash('#code=a%20b%26c')).toBe('a b&c');
    expect(setupCodeFromHash('#code=%20%20')).toBeNull();
    expect(setupCodeFromHash('#other=1')).toBeNull();
    expect(setupCodeFromHash('')).toBeNull();
    expect(setupCodeFromHash('#code=' + 'x'.repeat(300))).toHaveLength(200);
  });

  it('removes only the code from the fragment', () => {
    expect(hashWithoutSetupCode('#code=abc')).toBe('');
    expect(hashWithoutSetupCode('#code=abc&x=1')).toBe('#x=1');
    expect(hashWithoutSetupCode('')).toBe('');
  });
});

describe('where the setup code is', () => {
  it('the Windows app without a window: start it again (the log file leaves the code out); elsewhere its window or the server log', () => {
    const tray = setupCodeHelp({ exe: 'lyren-plan.exe', windows: true, stopMode: 'tray' });
    expect(tray.hint).toBe('Start Lyren Plan again to open this page with the code filled in.');
    expect(tray.hint).not.toMatch(/log/);
    expect(tray.invalid).not.toMatch(/window/);
    for (const desktop of [undefined, { exe: 'x.exe', windows: true }, { exe: 'x.exe', windows: true, stopMode: 'terminal' as const }]) {
      expect(setupCodeHelp(desktop)).toEqual({
        hint: 'Shown in the Lyren Plan window or server log when it started (or the SETUP_TOKEN you configured).',
        invalid: 'Invalid setup code — check the Lyren Plan window or server log',
      });
    }
  });
});
