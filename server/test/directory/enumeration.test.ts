// Account enumeration (design §13.6, §5.8.5, §5.8.8-§5.8.10): the flows an anonymous visitor or another
// account can start with someone's address answer the same, byte for byte, whether or not the address has
// an account, and do the same work inside the request: every statement the request runs is the same (the
// lookup and the mail come after the answer, through one deferred task on both paths) and no path hashes.
// The time of each path is measured too (printed as `[timing] …`; the default reporter hides a passing
// test's output, --reporter=verbose shows it). What the requests leave behind for the caller to see later
// is the same too: the mail budgets they count on (a full one would drop the caller's next message) and the
// requester's own security log when a message is dropped or fails. Invitation inspect tells whether the
// address has an account only for a mailed invitation; a copied link answers the same both ways.

import { describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type { InvitationCreatedDTO } from '@shared/types';
import type { SqlParams } from '../../src/core/db';
import { migrate } from '../../src/core/migrate';
import { APP_VERSION } from '../../src/core/version';
import { mailBudgets } from '../../src/directory/mailer';
import { PasswordHasher } from '../../src/directory/passwords';
import { POLICIES } from '../../src/directory/throttle';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import { createLogTransport } from '../../src/mail/log';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { createDirectoryHarness, insertAccount, PASSWORD, testMeta } from '../support/directoryHarness';
import { linkToken, tokenOfLink } from '../support/mail';

/** A directory database that records the statements it runs while `trace` is set. */
class TracingDb extends NodeDb {
  trace: string[] | null = null;

  override all<T = Record<string, unknown>>(sql: string, params?: SqlParams): T[] {
    this.trace?.push(sql);
    return super.all<T>(sql, params);
  }

  override get<T = Record<string, unknown>>(sql: string, params?: SqlParams): T | undefined {
    this.trace?.push(sql);
    return super.get<T>(sql, params);
  }

  override run(sql: string, params?: SqlParams) {
    this.trace?.push(sql);
    return super.run(sql, params);
  }
}

interface Observed {
  status: number;
  /** The answer's body, as sent. */
  text: string;
  headers: Array<[string, string]>;
  /** The statements the request ran before it was answered. */
  sql: string[];
  /** Tasks handed to defer before it was answered. */
  deferred: number;
  /** Wall time of the request, in ms. */
  ms: number;
}

async function instance(o: { mail?: 'log'; signup?: boolean } = {}) {
  const db = new TracingDb(':memory:');
  migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
  const h = createDirectoryHarness({
    db,
    vars: { PUBLIC_URL: 'https://plan.example.com' },
    config: o.signup ? { seed: { signupPolicy: 'open', passwordMinLength: 8 } } : {},
    ...(o.mail === 'log' ? { mail: createLogTransport({ logBodies: false }, () => {}) } : {}),
  });
  const owner = await h.setup();
  db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
  let deferred = 0;
  const defer = h.deps.defer;
  h.deps.defer = (task) => {
    deferred++;
    defer(task);
  };
  const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: h.clock });

  /**
   * One request straight through the app, so that nothing but the request runs until it is answered (the
   * deferred work waits for a timer, and the trace stops before one can fire).
   */
  async function observe(path: string, body: unknown, o: { ip: string; cookie?: string }): Promise<Observed> {
    const headers: Record<string, string> = { [CSRF_HEADER]: '1', 'Content-Type': 'application/json' };
    if (o.cookie) headers.Cookie = o.cookie;
    const request = new Request(`http://127.0.0.1:19610${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const before = deferred;
    db.trace = [];
    const started = performance.now();
    const res = await h.app.fetch(request, { meta: testMeta({ clientIp: o.ip }) });
    const ms = performance.now() - started;
    const sql = db.trace;
    db.trace = null;
    return { status: res.status, text: await res.text(), headers: [...res.headers], sql, deferred: deferred - before, ms };
  }

  /** `n` accounts with addresses <prefix><i>@example.com. */
  async function accounts(prefix: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) await insertAccount(db, hasher, { email: `${prefix}${i}@example.com` }, h.clock.now());
  }

  return { h, db, owner, observe, accounts };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/**
 * The two kinds of address answer alike: status, headers and body byte for byte, the same statements and
 * deferred tasks in the request; and their medians over `rounds` interleaved requests (in turn first, each
 * after the deferred work of the ones before, which would otherwise land in the next request's time) are close.
 */
async function expectAlike(
  label: string,
  rounds: number,
  t: { h: { settle(): Promise<void> } },
  run: (kind: 'exists' | 'missing', i: number) => Promise<Observed>,
): Promise<void> {
  const times: Record<'exists' | 'missing', number[]> = { exists: [], missing: [] };
  let reference: Record<'exists' | 'missing', Observed> | null = null;
  const observe = async (kind: 'exists' | 'missing', i: number) => {
    await t.h.settle();
    return run(kind, i);
  };
  for (let i = 0; i < rounds; i++) {
    let exists: Observed;
    let missing: Observed;
    if (i % 2 === 0) {
      exists = await observe('exists', i);
      missing = await observe('missing', i);
    } else {
      missing = await observe('missing', i);
      exists = await observe('exists', i);
    }
    expect({ status: exists.status, text: exists.text, headers: exists.headers }).toEqual({ status: missing.status, text: missing.text, headers: missing.headers });
    expect(exists.sql).toEqual(missing.sql);
    expect(exists.deferred).toBe(missing.deferred);
    times.exists.push(exists.ms);
    times.missing.push(missing.ms);
    reference ??= { exists, missing };
  }
  expect(reference!.exists.deferred).toBe(1);
  const a = median(times.exists);
  const b = median(times.missing);
  console.log(`[timing] ${label}: with an account ${a.toFixed(2)} ms, without ${b.toFixed(2)} ms (medians of ${rounds})`);
  // A hash on one path alone (about 15 ms at the tests' scrypt p = 1) would stand out; noise does not.
  expect(Math.abs(a - b)).toBeLessThan(5);
}

describe('the same answer and the same work for addresses with and without an account', () => {
  it('sign-up', async () => {
    const t = await instance({ signup: true });
    await t.accounts('signup', 30);
    await expectAlike('POST /api/auth/signup', 30, t, (kind, i) =>
      t.observe('/api/auth/signup', { email: `${kind === 'exists' ? 'signup' : 'nobody'}${i}@example.com` }, { ip: `198.51.${kind === 'exists' ? 1 : 2}.${i}` }),
    );
    await t.h.settle();
    expect(t.h.outbox.filter((m) => m.template === 'signup_existing')).toHaveLength(30);
    expect(t.h.outbox.filter((m) => m.template === 'signup_verify')).toHaveLength(30);
  });

  it('forgot password (an active account, and a missing or a disabled one)', async () => {
    const t = await instance();
    await t.accounts('forgot', 30);
    await t.accounts('disabled', 30);
    t.db.run("UPDATE users SET status = 'disabled' WHERE email LIKE 'disabled%'");
    await expectAlike('POST /api/auth/password/forgot', 30, t, (kind, i) =>
      t.observe('/api/auth/password/forgot', { email: `${kind === 'exists' ? 'forgot' : 'nobody'}${i}@example.com` }, { ip: `198.51.${kind === 'exists' ? 3 : 4}.${i}` }),
    );
    await expectAlike('POST /api/auth/password/forgot (disabled)', 10, t, (kind, i) =>
      t.observe('/api/auth/password/forgot', { email: `${kind === 'exists' ? 'disabled' : 'missing'}${i}@example.com` }, { ip: `198.51.${kind === 'exists' ? 5 : 6}.${i}` }),
    );
    await t.h.settle();
    expect(t.h.outbox.filter((m) => m.template === 'password_reset')).toHaveLength(30);
  });

  it('an email change with mail (taken, and free)', async () => {
    const t = await instance();
    await t.accounts('taken', 30);
    const cookie = t.owner.client.cookieHeader();
    await expectAlike('POST /api/account/email', 30, t, (kind, i) =>
      t.observe('/api/account/email', { email: `${kind === 'exists' ? 'taken' : 'free'}${i}@example.com` }, { ip: '198.51.100.7', cookie }),
    );
    await t.h.settle();
    expect(t.h.outbox.filter((m) => m.template === 'email_change_taken')).toHaveLength(30);
    expect(t.h.outbox.filter((m) => m.template === 'email_change_confirm')).toHaveLength(30);
  });

  it('inviting with mail: the same answer and the same message (apart from the address and the id)', async () => {
    const t = await instance();
    await t.accounts('member', 1);
    const path = `/api/spaces/${t.owner.spaceId}/invitations`;
    const cookie = t.owner.client.cookieHeader();
    const exists = await t.observe(path, { email: 'member0@example.com', role: 'member' }, { ip: '198.51.100.7', cookie });
    const missing = await t.observe(path, { email: 'nobody0@example.com', role: 'member' }, { ip: '198.51.100.7', cookie });
    expect(exists.status).toBe(201);
    expect(exists.sql).toEqual(missing.sql);
    const neutral = (text: string) => text.replace(/member0|nobody0/g, 'X').replace(/"id":\d+/g, '"id":0');
    expect(neutral(exists.text)).toBe(neutral(missing.text));
    const [a, b] = t.h.outbox.filter((m) => m.template === 'invitation');
    const strip = (s: string) => s.replace(/member0|nobody0/g, 'X').replace(/#t=[A-Za-z0-9_-]{43}/g, '#t=T');
    expect([strip(a!.subject), strip(a!.text), strip(a!.html)]).toEqual([strip(b!.subject), strip(b!.text), strip(b!.html)]);
  });
});

describe('the daily lock of failed sign-ins (lda, §5.8.2)', () => {
  it('locks a missing address after as many failures as an existing one, so the lock tells nothing', async () => {
    const h = createDirectoryHarness();
    await h.setup();
    /** One past the daily limit of failures from browsers without a device token, each from a new network. */
    const statuses = async (identifier: string) => {
      const seen: number[] = [];
      for (let i = 0; i <= POLICIES.lda.limit; i++) {
        // Past the 15-minute windows every 19 attempts, so lg, li, ln and lid never refuse: only lda can.
        if (i % 19 === 0) h.clock.advance(16 * 60_000);
        const res = await h.client({ ip: `10.0.${i}.7` }).post('/api/auth/login', { identifier, password: 'wrong password' });
        seen.push(res.status);
      }
      return seen;
    };
    const existing = await statuses('owner@example.com');
    const missing = await statuses('nobody@example.com');
    expect(existing.at(-1)).toBe(429);
    expect(missing).toEqual(existing);
  }, 60_000);
});

describe('what the requests leave behind', () => {
  /** The mail budget rows: the day's and the anonymous share as they are, mr:<key> with the address left out. */
  const budgets = (t: Awaited<ReturnType<typeof instance>>) =>
    t.db
      .all<{ key: string; count: number }>("SELECT key, count FROM auth_throttle WHERE key LIKE 'mail:%' OR key LIKE 'ma:%' OR key LIKE 'mr:%' ORDER BY key")
      .map((r) => [r.key.replace(/^mr:.*$/, 'mr:<address>'), r.count]);

  it('forgot password counts the same mail budgets for an active account, a disabled one and none', async () => {
    const after: unknown[] = [];
    for (const email of ['forgot0@example.com', 'disabled0@example.com', 'nobody0@example.com']) {
      const t = await instance();
      await t.accounts('forgot', 1);
      await t.accounts('disabled', 1);
      t.db.run("UPDATE users SET status = 'disabled' WHERE email LIKE 'disabled%'");
      await t.h.settle();
      t.db.run("DELETE FROM auth_throttle WHERE key LIKE 'mr:%'");
      await t.observe('/api/auth/password/forgot', { email }, { ip: '198.51.100.20' });
      await t.h.settle();
      after.push(budgets(t));
    }
    expect(after[0]).toEqual([
      ['ma:2026-10-17', 1],
      ['mail:2026-10-17', 2],
      ['mr:<address>', 1],
    ]);
    expect(after[1]).toEqual(after[0]);
    expect(after[2]).toEqual(after[0]);
  });

  it('an email change: the requester’s log is the same, taken or free, when the message is dropped or fails', async () => {
    const logs: unknown[] = [];
    for (const email of ['taken0@example.com', 'free0@example.com']) {
      const t = await instance();
      await t.accounts('taken', 1);
      const policy = mailBudgets(t.h.config.mail.dailyCap).recipient;
      for (let i = 0; i < policy.limit; i++) t.h.ctx.throttle.hit(`mr:${email}`, policy);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await t.owner.client.post('/api/account/email', { email })).status).toBe(202);
      await t.h.settle();
      t.db.run("DELETE FROM auth_throttle WHERE key LIKE 'mr:%'");
      t.h.recording.failWith = new Error('The SMTP server refused RCPT TO (550): no such user');
      t.h.clock.advance(61 * 60_000);
      await t.owner.client.post('/api/account/reauth/password', { password: PASSWORD });
      expect((await t.owner.client.post('/api/account/email', { email })).status).toBe(202);
      await t.h.settle();
      expect(errors).toHaveBeenCalledTimes(2);
      errors.mockRestore();
      const log = (await t.owner.client.get<Array<{ type: string; data: unknown }>>('/api/account/security-events')).body;
      logs.push(log.map((e) => [e.type, e.type === 'email_change_requested' ? null : e.data]));
    }
    expect(logs[0]).toEqual(logs[1]);
    expect((logs[0] as Array<[string]>).map(([type]) => type)).not.toContain('mail_failed');
  });
});

describe('POST /api/invitations/inspect', () => {
  it('a copied link (no mail) answers the same, byte for byte, before and after its address has an account', async () => {
    const t = await instance({ mail: 'log' });
    const created = await t.owner.client.post<InvitationCreatedDTO>(`/api/spaces/${t.owner.spaceId}/invitations`, { email: 'later@example.com', role: 'member' });
    const token = tokenOfLink(created.body.link!);
    const before = await t.observe('/api/invitations/inspect', { token }, { ip: '198.51.100.8' });
    await t.accounts('later', 1);
    t.db.run("UPDATE users SET email = 'later@example.com', email_key = 'later@example.com' WHERE email = 'later0@example.com'");
    const after = await t.observe('/api/invitations/inspect', { token }, { ip: '198.51.100.8' });
    expect(before.status).toBe(200);
    expect({ text: after.text, headers: after.headers, sql: after.sql }).toEqual({ text: before.text, headers: before.headers, sql: before.sql });
    expect(JSON.parse(before.text).account).toBe('unknown');
  });

  it('a mailed invitation tells its holder (who controls the address): new, then exists', async () => {
    const t = await instance();
    await t.owner.client.post(`/api/spaces/${t.owner.spaceId}/invitations`, { email: 'later@example.com', role: 'member' });
    const token = linkToken(t.h.outbox.find((m) => m.template === 'invitation'));
    const before = await t.observe('/api/invitations/inspect', { token }, { ip: '198.51.100.9' });
    await t.accounts('later', 1);
    t.db.run("UPDATE users SET email = 'later@example.com', email_key = 'later@example.com' WHERE email = 'later0@example.com'");
    const after = await t.observe('/api/invitations/inspect', { token }, { ip: '198.51.100.9' });
    expect([JSON.parse(before.text).account, JSON.parse(after.text).account]).toEqual(['new', 'exists']);
  });
});
