// The mailer's sending policy (directory/mailer.ts, design §5.10.5, §5.9) with the recording transport:
// deferred sending (nothing during the request; a transport error never reaches the response), the three
// budgets (mail:<day>, ma:<day> at 40% of the cap, mr:<email_key> at 5 a day, notices exempt), the
// mail_failed events, notices to verified addresses only, the grants password_changed lists, the
// synchronous invitation (its 10 s) and test messages, and the wiring of the flows that exist already:
// a password change (§5.8.12) and the first lda block of a day (§5.8.2 step 5).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAppConfig, type DirectoryConfig } from '../../src/core/config';
import { migrate } from '../../src/core/migrate';
import type { TrustedMeta } from '../../src/core/ports';
import { APP_VERSION } from '../../src/core/version';
import { createMailer, INVITATION_SEND_TIMEOUT_MS, type MailUser } from '../../src/directory/mailer';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import { POLICIES, Throttle } from '../../src/directory/throttle';
import { MailError } from '../../src/mail/errors';
import { createLogTransport } from '../../src/mail/log';
import type { MailTransport } from '../../src/mail/transport';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { createDirectoryHarness, fakeClock, PASSWORD, testMeta } from '../support/directoryHarness';
import { createRecordingTransport } from '../support/mail';

const ORIGIN = 'https://plan.example.com';
const TOKEN = 'T'.repeat(43);
const meta: TrustedMeta = testMeta();

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A mailer on a fresh directory database, its deferred sends collected. */
function setup(o: { dailyCap?: number; transport?: MailTransport; publicUrl?: string | null; shareOrigins?: string[]; logBodies?: boolean } = {}) {
  const db = new NodeDb(':memory:');
  migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
  const clock = fakeClock();
  const parsed = parseAppConfig({ PUBLIC_URL: ORIGIN }, 'node').directory;
  const config: DirectoryConfig = {
    ...parsed,
    publicUrl: o.publicUrl === undefined ? ORIGIN : o.publicUrl,
    mail: { ...parsed.mail, dailyCap: o.dailyCap ?? 200, logBodies: o.logBodies ?? false },
  };
  const recording = createRecordingTransport();
  const pending: Array<Promise<unknown>> = [];
  const mailer = createMailer({
    db,
    config,
    throttle: new Throttle(db, clock),
    transport: o.transport ?? recording,
    defer: (task) => {
      pending.push(task);
    },
    now: () => clock.now(),
    shareOrigins: () => o.shareOrigins ?? [],
  });
  const settle = async () => {
    while (pending.length > 0) await Promise.all(pending.splice(0));
  };
  const events = () =>
    db.all<{ user_id: number | null; type: string; data: string }>('SELECT user_id, type, data FROM security_events ORDER BY id').map((e) => ({
      userId: e.user_id,
      type: e.type,
      data: JSON.parse(e.data) as Record<string, unknown>,
    }));
  /** A new account (security events need its row); a null email makes a username-only account. */
  let accounts = 0;
  const user = (email: string | null, verified = true): MailUser => {
    const n = ++accounts;
    const key = email === null ? null : email.toLowerCase();
    const row = db.get<MailUser>(
      `INSERT INTO users (email, email_key, email_verified_at, username, display_name, webauthn_user_id, created_at, updated_at)
       VALUES (:email, :key, :verified, :username, :name, :handle, :now, :now)
       RETURNING id, email, email_verified_at, display_name, username`,
      {
        email,
        key: key === null ? null : `${n}.${key}`,
        verified: verified ? '2026-10-01T00:00:00.000Z' : null,
        username: email === null ? `user${n}` : null,
        name: `User ${n}`,
        handle: `handle-${n}`,
        now: '2026-10-01T00:00:00.000Z',
      },
    )!;
    return row;
  };
  return { db, clock, mailer, recording, outbox: recording.outbox, settle, events, user };
}

describe('deferred messages', () => {
  it('are written at the call and sent after it, through defer', async () => {
    const t = setup();
    t.mailer.verifyEmail({ user: t.user('alice@example.com'), token: TOKEN, meta });
    expect(t.outbox).toEqual([]);
    await t.settle();
    expect(t.outbox).toHaveLength(1);
    expect(t.outbox[0]).toMatchObject({ to: 'alice@example.com', subject: 'Confirm your email address', template: 'verify_email' });
    expect(t.outbox[0]!.text).toContain(`${ORIGIN}/email/confirm#t=${TOKEN}`);
  });

  it('a transport error is logged and recorded as mail_failed, and never thrown', async () => {
    const t = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.recording.failWith = new MailError('The SMTP server refused RCPT TO (550): no such user', 550);
    const alice = t.user('alice@example.com');
    expect(() => t.mailer.passwordReset({ user: alice, token: TOKEN, anonymous: true, meta })).not.toThrow();
    await t.settle();
    expect(t.outbox).toEqual([]);
    expect(errors).toHaveBeenCalledWith(
      '[lyren] Mail not sent: password_reset to an address at example.com: The SMTP server refused RCPT TO (550): no such user',
    );
    expect(t.events()).toEqual([{ userId: alice.id, type: 'mail_failed', data: { template: 'password_reset', reason: 'transport', status: 550 } }]);
  });

  it('an account without an address gets nothing; a notice needs a verified address', async () => {
    const t = setup();
    t.mailer.verifyEmail({ user: t.user(null), token: TOKEN, meta });
    t.mailer.loginAttempts({ user: t.user('unverified@example.com', false), meta });
    t.mailer.passwordChanged({ user: t.user('unverified@example.com', false), via: 'change', meta });
    t.mailer.emailChangedNotice({ user: t.user('old@example.com', false), meta });
    // Not notices: an unverified address gets them (verification, reset by the forgot form).
    t.mailer.verifyEmail({ user: t.user('new@example.com', false), token: TOKEN, meta });
    t.mailer.loginAttempts({ user: t.user('verified@example.com'), meta });
    await t.settle();
    expect(t.outbox.map((m) => `${m.template} ${m.to}`)).toEqual(['verify_email new@example.com', 'login_attempts verified@example.com']);
  });
});

/** An invitation's mail (sent at once). */
const invitation = (to = 'invitee@example.com') => ({
  to,
  token: TOKEN,
  inviter: { displayName: 'Owner', email: 'owner@example.com' },
  spaceName: 'Garden',
  role: 'member' as const,
  expiresAt: '2026-10-24T12:00:00.000Z',
  meta,
});

describe('budgets (§5.9)', () => {
  it('mr:<email_key>: 5 messages a day to one address (any case); the security notices are exempt', async () => {
    const t = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const alice = t.user('Alice@example.com');
    for (let i = 0; i < 5; i++) t.mailer.verifyEmail({ user: alice, token: TOKEN, meta });
    t.mailer.verifyEmail({ user: { ...alice, email: 'alice@example.com' }, token: TOKEN, meta });
    t.mailer.passwordChanged({ user: alice, via: 'change', meta });
    t.mailer.verifyEmail({ user: t.user('bob@example.com'), token: TOKEN, meta });
    await t.settle();
    expect(t.outbox.map((m) => `${m.template} ${m.to}`)).toEqual([
      ...Array(5).fill('verify_email Alice@example.com'),
      'password_changed Alice@example.com',
      'verify_email bob@example.com',
    ]);
    expect(t.events()).toEqual([{ userId: alice.id, type: 'mail_failed', data: { template: 'verify_email', reason: 'cap', budget: 'mr' } }]);
    // A day later the address gets mail again.
    t.clock.advance(25 * 3_600_000);
    t.mailer.verifyEmail({ user: alice, token: TOKEN, meta });
    await t.settle();
    expect(t.outbox).toHaveLength(8);
  });

  it('ma:<day>: anonymous requests get 40% of MAIL_DAILY_CAP; other messages are not held back by it', async () => {
    const t = setup({ dailyCap: 10 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 5; i++) t.mailer.signupVerify({ to: `new${i}@example.com`, token: TOKEN, meta });
    t.mailer.signupExisting({ user: t.user('member@example.com'), meta });
    t.mailer.passwordReset({ user: t.user('forgot@example.com'), token: TOKEN, anonymous: true, meta });
    t.mailer.passwordReset({ user: t.user('admin-sent@example.com'), token: TOKEN, anonymous: false, byAdmin: true, meta });
    t.mailer.verifyEmail({ user: t.user('signed-in@example.com'), token: TOKEN, meta });
    await t.settle();
    expect(t.outbox.map((m) => m.to)).toEqual(['new0@example.com', 'new1@example.com', 'new2@example.com', 'new3@example.com', 'admin-sent@example.com', 'signed-in@example.com']);
    expect(t.events().map((e) => e.data)).toEqual([
      { template: 'signup_verify', reason: 'cap', budget: 'ma' },
      { template: 'signup_existing', reason: 'cap', budget: 'ma' },
      { template: 'password_reset', reason: 'cap', budget: 'ma' },
    ]);
    expect(errors).toHaveBeenCalledWith(
      '[lyren] Mail not sent: signup_verify to an address at example.com: the daily limit of 4 messages caused by anonymous requests (40% of MAIL_DAILY_CAP) is used up',
    );
  });

  it('ma:<day> holds login_attempts too (anyone’s failed sign-ins cause it), so they cannot crowd out an invitation', async () => {
    const t = setup({ dailyCap: 10 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 6; i++) t.mailer.loginAttempts({ user: t.user(`target${i}@example.com`), meta });
    await t.settle();
    expect(t.outbox).toHaveLength(4);
    expect(t.events().map((e) => e.data)).toEqual(Array(2).fill({ template: 'login_attempts', reason: 'cap', budget: 'ma' }));
    expect(await t.mailer.invitation(invitation())).toMatchObject({ sent: true });
    for (let i = 0; i < 5; i++) t.mailer.verifyEmail({ user: t.user(`verify${i}@example.com`), token: TOKEN, meta });
    await t.settle();
    expect(t.outbox).toHaveLength(10);
  });

  it('mail:<day>: MAIL_DAILY_CAP messages a UTC day, notices included; the next day starts afresh', async () => {
    const t = setup({ dailyCap: 3 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.clock.set(Date.parse('2026-10-18T23:00:00Z'));
    for (let i = 0; i < 3; i++) t.mailer.verifyEmail({ user: t.user(`u${i}@example.com`), token: TOKEN, meta });
    t.mailer.loginAttempts({ user: t.user('notice@example.com'), meta });
    await t.settle();
    expect(t.outbox).toHaveLength(3);
    expect(t.events().map((e) => e.data)).toEqual([{ template: 'login_attempts', reason: 'cap', budget: 'mail' }]);
    expect(t.db.get<{ count: number }>("SELECT count FROM auth_throttle WHERE key = 'mail:2026-10-18'")!.count).toBe(3);
    t.clock.set(Date.parse('2026-10-19T00:00:01Z'));
    t.mailer.loginAttempts({ user: t.user('notice@example.com'), meta });
    await t.settle();
    expect(t.outbox).toHaveLength(4);
  });

  it('a dropped message is not counted, and a cap of 1 leaves anonymous requests nothing', async () => {
    const t = setup({ dailyCap: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.mailer.signupVerify({ to: 'new@example.com', token: TOKEN, meta });
    t.mailer.verifyEmail({ user: t.user('alice@example.com'), token: TOKEN, meta });
    await t.settle();
    expect(t.outbox.map((m) => m.to)).toEqual(['alice@example.com']);
    expect(t.events().map((e) => e.data.budget)).toEqual(['ma']);
  });

  it('the log transport sends nothing, so it counts nothing', async () => {
    const lines: string[] = [];
    const t = setup({ transport: createLogTransport({ logBodies: false }, (line) => lines.push(line)), dailyCap: 1 });
    for (let i = 0; i < 3; i++) t.mailer.loginAttempts({ user: t.user('alice@example.com'), meta });
    await t.settle();
    expect(lines).toEqual(Array(3).fill('[lyren] Mail not sent (MAIL_TRANSPORT=log): login_attempts to an address at example.com (suppressed)'));
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_throttle')!.n).toBe(0);
    expect(t.events()).toEqual([]);
  });
});

describe('messages sent at once', () => {

  it('an invitation reports its outcome, with a 10 s timeout for the transport', async () => {
    const t = setup();
    expect(await t.mailer.invitation(invitation())).toEqual({ sent: true, messageId: '<test-1@example.com>' });
    expect(t.recording.options).toEqual([{ timeoutMs: INVITATION_SEND_TIMEOUT_MS }]);
    expect(t.outbox[0]).toMatchObject({ to: 'invitee@example.com', subject: "You're invited to a space on Lyren Plan", template: 'invitation' });
    expect(t.outbox[0]!.text).toContain(`${ORIGIN}/invite#t=${TOKEN}`);
  });

  it('a failed or capped invitation says so, for the caller to answer 503', async () => {
    const t = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    t.recording.failWith = new MailError('Resend refused the message (422): bad', 422);
    expect(await t.mailer.invitation(invitation())).toEqual({ sent: false, reason: 'failed', message: 'Resend refused the message (422): bad' });
    t.recording.failWith = null;
    for (let i = 0; i < 4; i++) await t.mailer.invitation(invitation());
    expect(await t.mailer.invitation(invitation())).toEqual({
      sent: false,
      reason: 'cap',
      message: 'Mail was not sent: the daily limit of 5 messages to one address is used up for today (UTC).',
    });
    expect(t.events().map((e) => [e.userId, e.data.reason])).toEqual([
      [null, 'transport'],
      [null, 'cap'],
    ]);
  });

  it('an invitation whose transport takes longer than 10 s fails', async () => {
    const t = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    t.recording.hold = new Promise(() => {});
    const result = t.mailer.invitation(invitation());
    await vi.advanceTimersByTimeAsync(INVITATION_SEND_TIMEOUT_MS);
    expect(await result).toEqual({ sent: false, reason: 'failed', message: 'The mail transport did not finish within 10 s' });
  });

  it("the admin's test message goes to their own address and counts on mail:<day> only", async () => {
    const t = setup();
    const admin = t.user('admin@example.com', false);
    for (let i = 0; i < 7; i++) expect(await t.mailer.test({ user: admin, meta })).toMatchObject({ sent: true });
    expect(t.outbox[0]).toMatchObject({ to: 'admin@example.com', subject: 'Test message from Lyren Plan', template: 'mail_test' });
    expect(t.outbox[0]!.text).toContain('It was sent with MAIL_TRANSPORT=smtp.');
    expect(t.db.all<{ key: string }>('SELECT key FROM auth_throttle').map((r) => r.key)).toEqual(['mail:2026-10-17']);
    expect(await t.mailer.test({ user: t.user(null), meta })).toMatchObject({ sent: false });
  });
});

describe('links and flags', () => {
  it('links come from PUBLIC_URL, else the first share origin, else the path alone', () => {
    expect(setup().mailer.link('/reset#t=x')).toBe(`${ORIGIN}/reset#t=x`);
    expect(setup({ publicUrl: null, shareOrigins: ['http://192.168.1.5:43770'] }).mailer.link('/x')).toBe('http://192.168.1.5:43770/x');
    expect(setup({ publicUrl: null }).mailer.link('/x')).toBe('/x');
  });

  it('sendsTokens: a delivering transport, or the log transport with MAIL_LOG_BODIES', () => {
    expect(setup().mailer).toMatchObject({ deliversMail: true, sendsTokens: true });
    const log = createLogTransport({ logBodies: false }, () => {});
    expect(setup({ transport: log }).mailer).toMatchObject({ deliversMail: false, sendsTokens: false });
    expect(setup({ transport: log, logBodies: true }).mailer).toMatchObject({ deliversMail: false, sendsTokens: true });
  });
});

describe('the flows that send mail today', () => {
  /** Mark the account's address verified (as its verification link would), and forget setup's message with that link. */
  const verify = async (h: ReturnType<typeof createDirectoryHarness>, id: number) => {
    h.db.run('UPDATE users SET email_verified_at = :now WHERE id = :id', { id, now: new Date(h.clock.now()).toISOString() });
    await h.settle();
    h.outbox.length = 0;
  };

  it('a password change sends a deferred password_changed listing the week’s grants; a transport error leaves the answer alone', async () => {
    const h = createDirectoryHarness();
    const { client, user: owner, spaceId } = await h.setup();
    await verify(h, owner.id);
    const bob = await h.addUser({ email: 'bob@example.com', displayName: 'Bob', spaceId, role: 'member' });
    expect((await client.patch(`/api/spaces/${spaceId}/members/${bob.user.id}`, { role: 'admin' })).status).toBe(200);
    const res = await client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new password' });
    expect(res).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.outbox).toEqual([]);
    await h.settle();
    expect(h.outbox.map((m) => m.template)).toEqual(['password_changed']);
    expect(h.outbox[0]!.text).toContain("- Space Owner's space: Bob as an admin\n");

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.recording.failWith = new MailError('The SMTP server did not answer in time (DATA)');
    const again = await client.post('/api/account/password', { currentPassword: 'a brand new password', newPassword: 'yet another password' });
    expect(again).toMatchObject({ status: 200, body: { ok: true } });
    await h.settle();
    expect(errors).toHaveBeenCalledWith('[lyren] Mail not sent: password_changed to an address at example.com: The SMTP server did not answer in time (DATA)');
    const events = await client.get('/api/account/security-events');
    expect(events.body[0]).toMatchObject({ type: 'mail_failed', data: { template: 'password_changed', reason: 'transport' } });
  });

  it('the failure that starts the day’s lda block sends one login_attempts notice', async () => {
    const h = createDirectoryHarness();
    const { user: owner } = await h.setup();
    await verify(h, owner.id);
    const windowStart = new Date(h.clock.now()).toISOString();
    h.db.run('INSERT INTO auth_throttle (key, window_start, count) VALUES (:key, :start, :count)', {
      key: `lda:${owner.id}`,
      start: windowStart,
      count: POLICIES.lda.limit - 2,
    });
    const stranger = h.client({ ip: '198.51.100.7' });
    for (let i = 0; i < 3; i++) {
      const res = await stranger.post('/api/auth/login', { identifier: 'owner@example.com', password: 'wrong password' });
      expect(res.status).toBe(i < 2 ? 401 : 429);
    }
    await h.settle();
    expect(h.outbox.map((m) => `${m.template} ${m.to}`)).toEqual(['login_attempts owner@example.com']);
    expect(h.outbox[0]!.text).toContain(`/settings/security`);
  });
});
