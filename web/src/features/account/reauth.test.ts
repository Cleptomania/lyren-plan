import { describe, expect, it, vi } from 'vitest';
import { canConfirm, ensureReauthWith, REAUTH_MARGIN_MS, reauthMethods, reauthOpen, reauthText, reauthUnavailableText, sharedPrompt } from './reauth';

describe('reauthOpen', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  it('is open while the window ends more than the margin from now', () => {
    expect(reauthOpen(at(5 * 60_000), now)).toBe(true);
    expect(reauthOpen(at(REAUTH_MARGIN_MS + 1), now)).toBe(true);
  });

  it('is closed when the window is over, about to end, unknown or unreadable', () => {
    expect(reauthOpen(at(REAUTH_MARGIN_MS), now)).toBe(false);
    expect(reauthOpen(at(-1), now)).toBe(false);
    expect(reauthOpen(null, now)).toBe(false);
    expect(reauthOpen(undefined, now)).toBe(false);
    expect(reauthOpen('not a date', now)).toBe(false);
  });
});

describe('ensureReauthWith', () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  const open = new Date(now + 5 * 60_000).toISOString();
  const over = new Date(now - 1).toISOString();

  it('goes on without asking while the window is open', async () => {
    const prompt = vi.fn(async () => true);
    expect(await ensureReauthWith({ reauthUntil: open, nowMs: now, prompt })).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('asks once the window has closed, or when forced (the server refused), and passes the answer on', async () => {
    const prompt = vi.fn(async () => false);
    expect(await ensureReauthWith({ reauthUntil: over, nowMs: now, prompt })).toBe(false);
    expect(await ensureReauthWith({ reauthUntil: null, nowMs: now, prompt })).toBe(false);
    prompt.mockResolvedValue(true);
    expect(await ensureReauthWith({ reauthUntil: open, nowMs: now, force: true, prompt })).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(3);
  });
});

describe('sharedPrompt', () => {
  it('shows one prompt for requests refused together, and both get its answer', async () => {
    let answer!: (ok: boolean) => void;
    const ask = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));
    const prompt = sharedPrompt(ask);
    const first = prompt();
    const second = prompt();
    expect(ask).toHaveBeenCalledTimes(1);
    answer(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
  });

  it('asks again once the previous prompt was answered, cancelled or failed', async () => {
    const ask = vi.fn(async () => false);
    const prompt = sharedPrompt(ask);
    expect(await prompt()).toBe(false);
    ask.mockRejectedValueOnce(new Error('gone'));
    await expect(prompt()).rejects.toThrow('gone');
    ask.mockResolvedValueOnce(true);
    expect(await prompt()).toBe(true);
    expect(ask).toHaveBeenCalledTimes(3);
  });
});

describe('reauthMethods', () => {
  const base = { hasPassword: true, passkeysHere: true, passkeyCount: 1, passkeys: [{ rpIdMatches: true }], listFailed: false };

  it('offers the password with one, and a passkey that works here where passkeys are available', () => {
    expect(reauthMethods(base)).toEqual({ password: true, passkey: true });
    expect(reauthMethods({ ...base, hasPassword: false })).toEqual({ password: false, passkey: true });
    // Not on this origin (the desktop app, an IP address), or no passkeys at all: the password only.
    expect(reauthMethods({ ...base, passkeysHere: false })).toEqual({ password: true, passkey: false });
    expect(reauthMethods({ ...base, passkeyCount: 0, passkeys: undefined })).toEqual({ password: true, passkey: false });
  });

  it('asks the list which passkeys work here: passkeyCount counts those of another address too', () => {
    expect(reauthMethods({ ...base, passkeys: [{ rpIdMatches: false }] })).toEqual({ password: true, passkey: false });
    expect(reauthMethods({ ...base, passkeys: [{ rpIdMatches: false }, { rpIdMatches: true }] })).toEqual({ password: true, passkey: true });
    expect(reauthMethods({ ...base, passkeys: undefined })).toEqual({ password: true, passkey: 'checking' });
    // The list failed to load: the button shows, and the server says when none works here.
    expect(reauthMethods({ ...base, passkeys: undefined, listFailed: true })).toEqual({ password: true, passkey: true });
  });

  it('words the dialog by what it offers', () => {
    expect(reauthText({ password: true, passkey: false })).toBe('This action needs your password again, because your last sign-in was a while ago.');
    expect(reauthText({ password: true, passkey: 'checking' })).toMatch(/password or a passkey/);
    expect(reauthText({ password: false, passkey: true })).toMatch(/one of your passkeys/);
    expect(reauthText({ password: false, passkey: false })).toMatch(/confirm it’s you/);
    expect(reauthUnavailableText({ passkeysHere: true, passkeyCount: 2, mail: true })).toBe(
      'Your account has no password, and none of its passkeys works on this address. To set a password or a passkey here, sign out and use “Forgot password?”, or ask an administrator for a reset link.',
    );
    // Passkeys off, or another address of the instance (an IP address): never a dead end either.
    expect(reauthUnavailableText({ passkeysHere: false, passkeyCount: 2, mail: false })).toBe(
      'Your account has no password, and passkeys cannot be used on this address. To set a password or a passkey here, ask an administrator of this instance for a reset link.',
    );
    expect(canConfirm({ password: false, passkey: false })).toBe(false);
    expect(canConfirm({ password: false, passkey: 'checking' })).toBe(true);
    expect(canConfirm({ password: true, passkey: false })).toBe(true);
  });
});
