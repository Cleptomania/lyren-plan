import { describe, expect, it } from 'vitest';
import {
  ApiError,
  DAILY_LIMIT_TEXT,
  errorAction,
  errorFromResponse,
  errorMessage,
  lastOwnerSpaces,
  SPACE_IMPORTING_TEXT,
  TOO_MANY_REQUESTS_TEXT,
  UNAVAILABLE_TEXT,
  wrongHostUrl,
} from './errors';

const json = (code: string, message: string, details?: Array<{ path: string; message: string }>) => JSON.stringify({ error: { code, message, details } });
const HERE = { origin: 'https://lyren-plan.example.workers.dev', pathname: '/s/7k2m9q4w8x1c3v5b/tasks/WEB-1', search: '?task=3', hash: '#c' };
const wrongHost = (publicUrl: string) =>
  new ApiError(421, 'wrong_host', `This Lyren Plan instance is at ${publicUrl}`, [{ path: 'publicUrl', message: publicUrl }]);

describe('errorFromResponse', () => {
  it('reads the server’s error body', () => {
    const err = errorFromResponse(409, json('last_owner', 'The space needs another owner first.', [{ path: 'role', message: 'x' }]));
    expect(err).toMatchObject({ status: 409, code: 'last_owner', message: 'The space needs another owner first.', details: [{ path: 'role', message: 'x' }] });
  });

  it('a body that names error 1027 is the daily usage limit, whatever the status', () => {
    const page = '<!DOCTYPE html><html><head><title>Worker exceeded free tier daily request limit | Error 1027</title></head><body>…</body></html>';
    expect(errorFromResponse(429, page)).toMatchObject({ status: 429, code: 'rate_limited', message: DAILY_LIMIT_TEXT });
    expect(errorFromResponse(429, 'error code: 1027').message).toBe(DAILY_LIMIT_TEXT);
    expect(errorFromResponse(503, '<html>Error 1027 · This website has been temporarily rate limited</html>').message).toBe(DAILY_LIMIT_TEXT);
  });

  it('any other 429 without our body is a short block: the zone’s rate-limiting rule (1015), a proxy’s limit', () => {
    const page = '<!DOCTYPE html><html><head><title>You are being rate limited | Error 1015</title></head><body>…</body></html>';
    expect(errorFromResponse(429, page)).toMatchObject({ status: 429, code: 'rate_limited', message: TOO_MANY_REQUESTS_TEXT });
    expect(errorFromResponse(429, '<html><body><h1>429 Too Many Requests</h1></body></html>').message).toBe(TOO_MANY_REQUESTS_TEXT);
    expect(errorFromResponse(429, '').message).toBe(TOO_MANY_REQUESTS_TEXT);
    expect(errorMessage(errorFromResponse(429, page))).toBe(TOO_MANY_REQUESTS_TEXT);
  });

  it('the server’s own 429 keeps its message (a space’s daily write limit)', () => {
    const err = errorFromResponse(429, json('rate_limited', 'This space has reached today’s write limit on this instance. It resets at 00:00 UTC.'));
    expect(err.message).toBe('This space has reached today’s write limit on this instance. It resets at 00:00 UTC.');
  });

  it('a 503 says the server’s message, else that the instance is unavailable', () => {
    expect(errorFromResponse(503, json('unavailable', 'This Lyren Plan instance has reached its daily usage limit.')).message).toBe(
      'This Lyren Plan instance has reached its daily usage limit.',
    );
    expect(errorFromResponse(503, '<html>Service Unavailable</html>')).toMatchObject({ code: 'unavailable', message: UNAVAILABLE_TEXT });
    expect(errorFromResponse(503, '')).toMatchObject({ code: 'unavailable', message: UNAVAILABLE_TEXT });
  });

  it('other answers without our body', () => {
    expect(errorFromResponse(401, '')).toMatchObject({ code: 'unauthorized', message: 'Request failed (401)' });
    expect(errorFromResponse(502, '<html>Bad gateway</html>')).toMatchObject({ code: 'internal', message: 'Request failed (502)' });
    expect(errorFromResponse(500, '{"error":"plain"}')).toMatchObject({ code: 'internal' });
  });
});

describe('errorAction (§12.11)', () => {
  it('reauth_required opens the re-auth dialog', () => {
    expect(errorAction(new ApiError(403, 'reauth_required', 'Confirm it’s you to continue'))).toEqual({ kind: 'reauth', message: 'Confirm it’s you to continue' });
  });

  it('quota_exceeded, last_owner, last_credential and last_admin say the server’s message', () => {
    for (const code of ['quota_exceeded', 'last_owner', 'last_credential', 'last_admin'] as const) {
      expect(errorAction(new ApiError(409, code, `Server text for ${code}`))).toEqual({ kind: 'message', message: `Server text for ${code}` });
    }
  });

  it('space_unavailable says the space is being imported', () => {
    expect(errorAction(new ApiError(409, 'space_unavailable', 'This space is still being imported.'))).toEqual({ kind: 'message', message: SPACE_IMPORTING_TEXT });
  });

  it('unavailable says the server’s message, else that the instance is unavailable', () => {
    expect(errorAction(new ApiError(503, 'unavailable', 'Too many sign-ins at once. Try again in a moment.'))).toEqual({
      kind: 'message',
      message: 'Too many sign-ins at once. Try again in a moment.',
    });
    expect(errorAction(new ApiError(503, 'unavailable', ''))).toEqual({ kind: 'message', message: UNAVAILABLE_TEXT });
  });

  it('wrong_host moves to PUBLIC_URL with the same path, search and hash', () => {
    expect(errorAction(wrongHost('https://plan.example.com'), HERE)).toEqual({
      kind: 'redirect',
      url: 'https://plan.example.com/s/7k2m9q4w8x1c3v5b/tasks/WEB-1?task=3#c',
    });
    // Without a location (a toast's text) it is just the message.
    expect(errorAction(wrongHost('https://plan.example.com'))).toEqual({ kind: 'message', message: 'This Lyren Plan instance is at https://plan.example.com' });
  });

  it('errorMessage uses the mapping', () => {
    expect(errorMessage(new ApiError(409, 'space_unavailable', 'x'))).toBe(SPACE_IMPORTING_TEXT);
    expect(errorMessage(new ApiError(403, 'reauth_required', 'Confirm your password'))).toBe('Confirm your password');
    expect(errorMessage(new Error('plain'))).toBe('plain');
    expect(errorMessage('?')).toBe('Something went wrong');
  });
});

describe('wrongHostUrl', () => {
  it('follows only an http(s) PUBLIC_URL, by its origin', () => {
    expect(wrongHostUrl(wrongHost('https://plan.example.com/'), HERE)).toBe('https://plan.example.com/s/7k2m9q4w8x1c3v5b/tasks/WEB-1?task=3#c');
    expect(wrongHostUrl(wrongHost('http://192.0.2.4:8080'), { ...HERE, search: '', hash: '' })).toBe('http://192.0.2.4:8080/s/7k2m9q4w8x1c3v5b/tasks/WEB-1');
    expect(wrongHostUrl(wrongHost('https://user:secret@plan.example.com/x'), HERE)).toBe('https://plan.example.com/s/7k2m9q4w8x1c3v5b/tasks/WEB-1?task=3#c');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://plan.example.com', 'plan.example.com', '', '//plan.example.com']) {
      expect(wrongHostUrl(wrongHost(bad), HERE), bad).toBeNull();
    }
    expect(wrongHostUrl(new ApiError(421, 'wrong_host', 'x'), HERE)).toBeNull();
  });

  it('never to this origin (that would loop)', () => {
    expect(wrongHostUrl(wrongHost(HERE.origin), HERE)).toBeNull();
  });

  it('a path that looks like another host stays a path at PUBLIC_URL', () => {
    const url = wrongHostUrl(wrongHost('https://plan.example.com'), { ...HERE, pathname: '//evil.example/x', search: '', hash: '' });
    expect(new URL(url!).origin).toBe('https://plan.example.com');
    expect(new URL(url!).pathname).toBe('//evil.example/x');
  });
});

describe('lastOwnerSpaces', () => {
  it('lists the spaces a refused account deletion names (§5.8.17)', () => {
    const err = errorFromResponse(
      409,
      JSON.stringify({
        error: {
          code: 'last_owner',
          message: 'Transfer ownership or delete these spaces first',
          details: [
            { path: 'spaces.7k2m9q4w8x1c3v5b', message: 'Team' },
            { path: 'spaces.9q2w4e6r8t1y3v5b', message: 'Client work' },
          ],
        },
      }),
    );
    expect(lastOwnerSpaces(err)).toEqual([
      { id: '7k2m9q4w8x1c3v5b', name: 'Team' },
      { id: '9q2w4e6r8t1y3v5b', name: 'Client work' },
    ]);
  });

  it('is empty for any other refusal', () => {
    expect(lastOwnerSpaces(new ApiError(409, 'last_admin', 'This is the only account.', [{ path: 'spaces.x', message: 'X' }]))).toEqual([]);
    expect(lastOwnerSpaces(new ApiError(409, 'last_owner', 'A space needs at least one owner'))).toEqual([]);
  });
});
