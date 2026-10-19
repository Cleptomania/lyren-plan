// Open sign-up (design §5.8.5): POST /api/auth/signup answers 202 for every address and mails, after the
// answer, a sign-up link to a new address or signup_existing to one with an account; /signup/inspect and
// /signup/complete turn the link into a verified account with its default space and a session. Under
// invite_only and closed every request answers 403 signup_disabled. With the log transport no token is
// minted. The policy matrix of §5.3 is policy.test.ts's, enumeration and timing enumeration.test.ts's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusDTO, SpaceSummaryDTO } from '@shared/types';
import { createLogTransport } from '../../src/mail/log';
import { setSignupPolicy } from '../../src/directory/settings';
import { createDirectoryHarness, PASSWORD } from '../support/directoryHarness';
import { linkToken } from '../support/mail';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };

/** An instance with an account (the admin) and open sign-up. */
async function openInstance(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const admin = await h.setup();
  setSignupPolicy(h.db, 'open', true);
  await h.settle();
  h.outbox.length = 0;
  return { h, admin };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/auth/signup', () => {
  it('is refused under invite_only and closed: 403 signup_disabled for every address, even an invalid one', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    for (const [policy, message] of [
      ['invite_only', 'Sign-up is by invitation only.'],
      ['closed', 'Sign-up is closed.'],
    ] as const) {
      setSignupPolicy(h.db, policy, true);
      for (const email of ['owner@example.com', 'new@example.com', 'not an address']) {
        const res = await h.client().post('/api/auth/signup', { email });
        expect(res).toMatchObject({ status: 403, body: { error: { code: 'signup_disabled', message } } });
      }
    }
    await h.settle();
    expect(h.outbox.filter((m) => m.template !== 'verify_email')).toEqual([]);
    expect(h.db.all("SELECT id FROM email_tokens WHERE purpose = 'signup'")).toEqual([]);
  });

  it('a new address: 202, then a sign-up link; inspect shows the address; complete creates a verified account with its space', async () => {
    const { h } = await openInstance();
    const visitor = h.client({ ip: '198.51.100.20' });
    const res = await visitor.post('/api/auth/signup', { email: '  Alice@Example.COM ' });
    expect(res).toMatchObject({ status: 202, body: { ok: true } });
    // Nothing is looked up or minted inside the request.
    expect(h.db.all("SELECT id FROM email_tokens WHERE purpose = 'signup'")).toEqual([]);
    await h.settle();
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['signup_verify', 'Alice@example.com']]);
    const message = h.outbox[0]!;
    expect(message.text).toContain('https://plan.example.com/signup/complete#t=');
    const token = linkToken(message);
    const row = h.db.get<{ purpose: string; email: string; email_key: string; user_id: number | null; request_ip: string; expires_at: string }>(
      "SELECT * FROM email_tokens WHERE purpose = 'signup'",
    )!;
    expect(row).toMatchObject({ purpose: 'signup', email: 'Alice@example.com', email_key: 'alice@example.com', user_id: null, request_ip: '198.51.100.20' });
    expect(Date.parse(row.expires_at) - h.clock.now()).toBe(24 * 3600_000);

    expect(await visitor.post('/api/auth/signup/inspect', { token })).toMatchObject({ status: 200, body: { email: 'Alice@example.com' } });
    const done = await visitor.post('/api/auth/signup/complete', { token, displayName: 'Alice', password: PASSWORD });
    expect(done.status).toBe(201);
    expect(done.body.user).toMatchObject({ email: 'Alice@example.com', emailVerified: true, displayName: 'Alice', isInstanceAdmin: false, hasPassword: true });
    const status = await visitor.get<AuthStatusDTO>('/api/auth/status');
    expect(status.body.user?.id).toBe(done.body.user.id);
    expect(status.body.spaces.map((s: SpaceSummaryDTO) => [s.name, s.role])).toEqual([["Alice's space", 'owner']]);
    const session = h.db.get<{ auth_method: string }>('SELECT auth_method FROM sessions WHERE user_id = :id', { id: done.body.user.id })!;
    expect(session.auth_method).toBe('signup');
    // Signed in by the sign-up, as a sign-in records it (Administration → Users' "Last sign-in").
    const signedIn = h.db.get<{ last_login_at: string | null; created_at: string }>(
      'SELECT u.last_login_at, s.created_at FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.id = :id',
      { id: done.body.user.id },
    )!;
    expect(signedIn.last_login_at).toBe(signedIn.created_at);
    expect(h.db.get<{ data: string }>("SELECT data FROM security_events WHERE type = 'account_created' AND user_id = :id", { id: done.body.user.id })!.data).toBe(
      '{"authMethod":"signup"}',
    );
    // Once only.
    expect((await h.client().post('/api/auth/signup/complete', { token, displayName: 'Again', password: PASSWORD })).body.error.code).toBe('invalid_token');
    expect((await h.client().post('/api/auth/signup/inspect', { token })).body.error.code).toBe('invalid_token');
  });

  it('an address with an account: the same 202, then signup_existing (sign in, or reset) and no token', async () => {
    const { h } = await openInstance();
    const res = await h.client().post('/api/auth/signup', { email: 'OWNER@example.com' });
    expect(res).toMatchObject({ status: 202, body: { ok: true } });
    await h.settle();
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['signup_existing', 'owner@example.com']]);
    expect(h.outbox[0]!.text).toContain('https://plan.example.com/login');
    expect(h.outbox[0]!.text).toContain('https://plan.example.com/forgot');
    expect(h.outbox[0]!.text).not.toContain('#t=');
    expect(h.db.all("SELECT id FROM email_tokens WHERE purpose = 'signup'")).toEqual([]);
  });

  it('an invalid address is a validation error at email', async () => {
    const { h } = await openInstance();
    const res = await h.client().post('/api/auth/signup', { email: 'alice@localhost' });
    expect(res).toMatchObject({ status: 400, body: { error: { code: 'validation_error', details: [{ path: 'email', message: 'Enter a valid email address' }] } } });
  });

  it('limits: 3 requests an hour and 10 a day per address, 10 an hour per client, whether or not the address has an account', async () => {
    const { h } = await openInstance();
    for (const email of ['owner@example.com', 'nobody@example.com']) {
      const client = h.client({ ip: email.startsWith('owner') ? '198.51.100.30' : '198.51.100.31' });
      const answers = [];
      for (let i = 0; i < 4; i++) answers.push((await client.post('/api/auth/signup', { email })).status);
      expect(answers).toEqual([202, 202, 202, 429]);
    }
    // md: a day's 10, an hour apart.
    for (let i = 0; i < 3; i++) {
      h.clock.advance(3600_000);
      for (let j = 0; j < 3; j++) await h.client({ ip: `198.51.100.${40 + i}` }).post('/api/auth/signup', { email: 'daily@example.com' });
    }
    h.clock.advance(3600_000);
    const day = h.client({ ip: '198.51.100.50' });
    expect((await day.post('/api/auth/signup', { email: 'daily@example.com' })).status).toBe(202);
    const blocked = await day.post('/api/auth/signup', { email: 'daily@example.com' });
    expect(blocked).toMatchObject({ status: 429, body: { error: { code: 'rate_limited' } } });
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(3600);
    // mi: one client, many addresses.
    const spray = h.client({ ip: '203.0.113.9' });
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await spray.post('/api/auth/signup', { email: `spray${i}@example.com` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('with the log transport no token is minted; with MAIL_LOG_BODIES the link is printed (development)', async () => {
    const lines: string[] = [];
    const quiet = createLogTransport({ logBodies: false }, (line) => lines.push(line));
    const { h } = await openInstance({ mail: quiet });
    expect((await h.client().post('/api/auth/signup', { email: 'new@example.com' })).status).toBe(202);
    await h.settle();
    expect(h.db.all('SELECT id FROM email_tokens')).toEqual([]);
    expect(lines.join('\n')).not.toContain('#t=');

    const printed: string[] = [];
    const bodies = createLogTransport({ logBodies: true }, (line) => printed.push(line));
    const { h: dev } = await openInstance({ mail: bodies, vars: { ...PUBLIC, MAIL_LOG_BODIES: '1' } });
    expect((await dev.client().post('/api/auth/signup', { email: 'new@example.com' })).status).toBe(202);
    await dev.settle();
    expect(dev.db.all("SELECT id FROM email_tokens WHERE purpose = 'signup'")).toHaveLength(1);
    expect(printed.join('\n')).toMatch(/signup\/complete#t=[A-Za-z0-9_-]{43}/);
  });
});

describe('POST /api/auth/signup/complete', () => {
  async function linkFor(h: Awaited<ReturnType<typeof openInstance>>['h'], email: string): Promise<string> {
    await h.client({ ip: `198.51.100.${60 + h.outbox.length}` }).post('/api/auth/signup', { email });
    await h.settle();
    return linkToken(h.outbox.filter((m) => m.template === 'signup_verify').at(-1));
  }

  it('the newest link replaces the older one; a link works for 24 hours', async () => {
    const { h } = await openInstance();
    const first = await linkFor(h, 'carol@example.com');
    const second = await linkFor(h, 'carol@example.com');
    expect((await h.client().post('/api/auth/signup/inspect', { token: first })).body.error.code).toBe('invalid_token');
    expect((await h.client().post('/api/auth/signup/inspect', { token: second })).status).toBe(200);
    h.clock.advance(24 * 3600_000);
    expect((await h.client().post('/api/auth/signup/complete', { token: second, displayName: 'Carol', password: PASSWORD })).body).toEqual({
      error: { code: 'invalid_token', message: 'This link is invalid or has expired.' },
    });
  });

  it('the policy and the address are asked again: closed meanwhile → 403, an account meanwhile → 409, and a short password leaves the link working', async () => {
    const { h } = await openInstance({ vars: { ...PUBLIC, PASSWORD_MIN_LENGTH: '12' } });
    const token = await linkFor(h, 'dave@example.com');
    const short = await h.client().post('/api/auth/signup/complete', { token, displayName: 'Dave', password: 'eleven char' });
    expect(short).toMatchObject({ status: 400, body: { error: { code: 'validation_error', details: [{ path: 'password' }] } } });
    setSignupPolicy(h.db, 'closed', true);
    expect((await h.client().post('/api/auth/signup/complete', { token, displayName: 'Dave', password: PASSWORD })).body.error).toEqual({
      code: 'signup_disabled',
      message: 'Sign-up is closed.',
    });
    setSignupPolicy(h.db, 'open', true);
    await h.addUser({ email: 'dave@example.com' });
    expect((await h.client().post('/api/auth/signup/complete', { token, displayName: 'Dave', password: PASSWORD })).body.error).toEqual({
      code: 'conflict',
      message: 'An account with this email already exists. Sign in instead.',
    });
  });

  it('a sign-in token is no sign-up token, and a malformed one is refused alike (counted on tk)', async () => {
    const { h } = await openInstance();
    const visitor = h.client({ ip: '198.51.100.99' });
    for (const token of ['x'.repeat(43), 'not-a-token-at-all-but-long-enough', `${'a'.repeat(42)}!`]) {
      expect((await visitor.post('/api/auth/signup/inspect', { token })).body.error.code).toBe('invalid_token');
    }
    // 20 invalid tokens, then the client is refused for a while, a valid link included.
    const token = await linkFor(h, 'erin@example.com');
    for (let i = 0; i < 17; i++) await visitor.post('/api/auth/signup/inspect', { token: 'y'.repeat(43) });
    expect((await visitor.post('/api/auth/signup/inspect', { token })).status).toBe(429);
    expect((await h.client({ ip: '198.51.100.98' }).post('/api/auth/signup/inspect', { token })).status).toBe(200);
  });
});
