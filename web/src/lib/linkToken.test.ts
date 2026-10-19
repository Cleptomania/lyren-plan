// A link's token (`#t=…`) leaves the address bar before anything renders or asks the server, and only
// the page it opened can read it (design §5.7, §12.7, §13.7).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetLinkToken,
  hashWithoutLinkToken,
  heldLinkToken,
  holdLinkToken,
  isLinkTokenPage,
  linkTokenFromHash,
  takeLinkToken,
  takeLinkTokenFromAddress,
} from './linkToken';

const TOKEN = 'Qx3lU5m9yTqZ-1h0N8e2aR7cKp4vW6sJbD_fG3oLi0E';

afterEach(() => {
  forgetLinkToken();
  vi.unstubAllGlobals();
});

describe('the token in the fragment', () => {
  it('reads #t= and keeps the rest of the fragment', () => {
    expect(linkTokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
    expect(linkTokenFromHash(`t=${TOKEN}&x=1`)).toBe(TOKEN);
    expect(linkTokenFromHash('#t=%20%20')).toBeNull();
    expect(linkTokenFromHash('#code=abc')).toBeNull();
    expect(linkTokenFromHash('')).toBeNull();
    expect(linkTokenFromHash(`#t=${'x'.repeat(300)}`)).toHaveLength(200);
    expect(hashWithoutLinkToken(`#t=${TOKEN}`)).toBe('');
    expect(hashWithoutLinkToken(`#t=${TOKEN}&x=1`)).toBe('#x=1');
    expect(hashWithoutLinkToken('')).toBe('');
  });

  it('knows the four pages a link opens, with or without a trailing slash', () => {
    for (const page of ['/signup/complete', '/reset', '/email/confirm', '/invite', '/invite/']) expect(isLinkTokenPage(page)).toBe(true);
    for (const page of ['/', '/login', '/signup', '/forgot', '/recover', '/setup', '/s/x/invite', '/invitex']) expect(isLinkTokenPage(page)).toBe(false);
  });
});

describe('taking the token out of the address', () => {
  it('replaces the address without the token, then holds it for that page only', () => {
    const replace = vi.fn();
    expect(takeLinkToken({ pathname: '/invite', search: '?from=mail', hash: `#t=${TOKEN}` }, replace)).toBe(true);
    expect(replace).toHaveBeenCalledWith('/invite?from=mail');
    expect(heldLinkToken('/invite')).toBe(TOKEN);
    expect(heldLinkToken('/invite/')).toBe(TOKEN);
    expect(heldLinkToken('/reset')).toBeNull();
    forgetLinkToken();
    expect(heldLinkToken('/invite')).toBeNull();
  });

  it('leaves other pages, and token pages without a token, alone', () => {
    const replace = vi.fn();
    expect(takeLinkToken({ pathname: '/setup', search: '', hash: '#code=1a2b' }, replace)).toBe(false);
    expect(takeLinkToken({ pathname: '/login', search: '', hash: `#t=${TOKEN}` }, replace)).toBe(false);
    expect(takeLinkToken({ pathname: '/reset', search: '', hash: '' }, replace)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(heldLinkToken('/login')).toBeNull();
  });

  it('a newer link replaces the token held; a link the app was handed is held the same way', () => {
    takeLinkToken({ pathname: '/reset', search: '', hash: `#t=${TOKEN}` }, () => undefined);
    holdLinkToken('/reset', 'another-token-of-the-recovery-page-000000');
    expect(heldLinkToken('/reset')).toBe('another-token-of-the-recovery-page-000000');
    takeLinkToken({ pathname: '/email/confirm', search: '', hash: `#t=${TOKEN}` }, () => undefined);
    expect(heldLinkToken('/reset')).toBeNull();
    expect(heldLinkToken('/email/confirm')).toBe(TOKEN);
  });

  it('at start, with history.replaceState and before anything else reads the address', () => {
    const location = { pathname: '/signup/complete', search: '', hash: `#t=${TOKEN}` };
    const history = { state: { idx: 0 }, replaceState: vi.fn() };
    vi.stubGlobal('window', { location, history });
    takeLinkTokenFromAddress();
    expect(history.replaceState).toHaveBeenCalledWith({ idx: 0 }, '', '/signup/complete');
    expect(heldLinkToken('/signup/complete')).toBe(TOKEN);
  });
});
