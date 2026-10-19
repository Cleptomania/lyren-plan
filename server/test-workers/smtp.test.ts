// The SMTP client in workerd (design §5.10.4, §14.4) over the Cloudflare connector
// (runtime/cloudflare/smtpConnector.ts, cloudflare:sockets), against the fake servers the global setup
// started in Node on 127.0.0.1 (server/test/support/smtpGlobalSetup.ts): plain, multi-line and split
// replies, a slow reply, a 5xx on RCPT and STARTTLS missing with the platform's own connect(); STARTTLS and
// implicit TLS with AUTH, a refused AUTH, bytes injected after STARTTLS and a certificate for another host
// through SMTP_TLS, a network service that trusts the test authority (vitest.config.ts), since the
// platform's connect() trusts only the public ones, which the last case shows. Then POST
// /api/admin/mail/test through the Worker (the log transport of wrangler.test.jsonc), through a
// DirectoryDO configured for SMTP, and through one with MAIL_TRANSPORT=cloudflare and a stub EMAIL binding
// (without one, the directory answers 503 with the reason).

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, inject, it } from 'vitest';
import type { SmtpConfig } from '../src/core/config';
import { encodeMeta, META_HEADER } from '../src/core/meta';
import type { TrustedMeta } from '../src/core/ports';
import { MailError } from '../src/mail/errors';
import { sendSmtp, STARTTLS_MISSING, type SmtpTimeouts } from '../src/mail/smtp/client';
import { DirectoryDO as WorkerDirectoryDO } from '../src/runtime/cloudflare/directoryDo';
import type { Env } from '../src/runtime/cloudflare/env';
import { createCloudflareSmtpConnector } from '../src/runtime/cloudflare/smtpConnector';
import { settle } from '../test/support/heldBody';
import { FIXTURE_PASS, FIXTURE_USER, type FakeSmtpSession, type SmtpScenario } from '../test/support/smtpFixture';
import { ORIGIN, PASSWORD, setupOwner } from './support';

const fixture = inject('smtp');
const FAST: SmtpTimeouts = { replyMs: 500, totalMs: 5_000 };
const envelope = { from: { address: 'no-reply@plan.example.com', name: 'Lyren Plan' }, replyTo: null };
const message = { to: 'alice@example.com', subject: 'Grüße aus workerd', text: 'Hello from workerd\n.dot line', html: '<p>Hello</p>', template: 'mail_test' };
const B64_PASS = btoa(FIXTURE_PASS);
const B64_PLAIN = btoa(`\0${FIXTURE_USER}\0${FIXTURE_PASS}`);

declare global {
  namespace Cloudflare {
    interface Env {
      /** vitest.config.ts: a network service that trusts the test authority (absent without openssl). */
      SMTP_TLS?: Fetcher;
    }
  }
}

const port = (scenario: SmtpScenario): number => {
  const p = fixture.ports[scenario];
  if (p === undefined) throw new Error(`no fake SMTP server for ${scenario}`);
  return p;
};

const smtp = (scenario: SmtpScenario, o: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: 'localhost',
  port: port(scenario),
  security: 'none',
  user: null,
  pass: null,
  ehloName: 'plan.example.com',
  ...o,
});

/** What the fake server of `scenario` received, newest connection last. */
async function sessions(scenario: SmtpScenario): Promise<FakeSmtpSession[]> {
  const res = await fetch(`http://127.0.0.1:${fixture.control}/${scenario}`);
  return (await res.json()) as FakeSmtpSession[];
}

/** The MailError a send rejects with (read in place: workerd reports rejections vitest leaves unhandled, Appendix D 43). */
async function failure(p: Promise<unknown>): Promise<MailError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailError);
  for (const secret of [FIXTURE_PASS, B64_PASS, B64_PLAIN]) expect((err as Error).message).not.toContain(secret);
  return err as MailError;
}

const platform = createCloudflareSmtpConnector();

describe('cloudflare:sockets to 127.0.0.1', () => {
  it('plain: sends one message, every step in order', async () => {
    const before = (await sessions('plain')).length;
    const { messageId } = await sendSmtp(smtp('plain'), platform, envelope, message, { timeouts: FAST });
    const all = await sessions('plain');
    expect(all).toHaveLength(before + 1);
    const session = all.at(-1)!;
    expect(session.commands.map((c) => c.line)).toEqual([
      'EHLO plan.example.com',
      'MAIL FROM:<no-reply@plan.example.com>',
      'RCPT TO:<alice@example.com>',
      'DATA',
      'QUIT',
    ]);
    expect(session.messages[0]).toContain(`Message-ID: ${messageId}\r\n`);
    expect(session.messages[0]).toContain('Subject: =?UTF-8?B?');
  });

  it('parses a 61-line EHLO reply sent 3 bytes at a time', async () => {
    await sendSmtp(smtp('split'), platform, envelope, message, { timeouts: { replyMs: 3_000, totalMs: 20_000 } });
    expect((await sessions('split')).at(-1)!.messages).toHaveLength(1);
  });

  it('times out a slow reply', async () => {
    const err = await failure(sendSmtp(smtp('slow'), platform, envelope, message, { timeouts: { replyMs: 200, totalMs: 5_000 } }));
    expect(err.message).toBe('The SMTP server did not answer in time (the connection (greeting))');
  });

  it('stops at a 5xx to RCPT TO, with its code, before DATA', async () => {
    const err = await failure(sendSmtp(smtp('rcpt550'), platform, envelope, message, { timeouts: FAST }));
    expect(err.status).toBe(550);
    expect(err.message).toBe('The SMTP server refused RCPT TO (550): 5.1.1 <alice@example.com>: Recipient address rejected');
    expect((await sessions('rcpt550')).at(-1)!.commands.map((c) => c.line)).not.toContain('DATA');
  });

  it('refuses STARTTLS that is not offered, before any AUTH', async () => {
    const err = await failure(sendSmtp(smtp('plain', { security: 'starttls', user: FIXTURE_USER, pass: FIXTURE_PASS }), platform, envelope, message, { timeouts: FAST }));
    expect(err.message).toBe(STARTTLS_MISSING);
    const session = (await sessions('plain')).at(-1)!;
    expect(session.commands.map((c) => c.line)).toEqual(['EHLO plan.example.com']);
    expect(session.auth).toEqual([]);
  });

  it('reports a port where nothing listens', async () => {
    const err = await failure(sendSmtp(smtp('plain', { port: 1 }), platform, envelope, message, { timeouts: FAST }));
    expect(err.message).toMatch(/^Could not connect to the SMTP server localhost:1: /);
  });
});

describe.skipIf(fixture.skipTls !== null)(`TLS in workerd${fixture.skipTls ? ` (skipped: ${fixture.skipTls})` : ''}`, () => {
  const trusted = () => {
    const binding = env.SMTP_TLS!;
    return createCloudflareSmtpConnector({ connect: (address, options) => binding.connect(address, options) });
  };
  const auth = { user: FIXTURE_USER, pass: FIXTURE_PASS };

  it('STARTTLS: startTls(), EHLO again, AUTH PLAIN, the message, all over TLS', async () => {
    await sendSmtp(smtp('starttls', { security: 'starttls', ...auth }), trusted(), envelope, message, { timeouts: FAST });
    const session = (await sessions('starttls')).at(-1)!;
    expect(session.commands.map((c) => `${c.secure ? 'tls ' : ''}${c.line.split(' ')[0]}`)).toEqual([
      'EHLO', 'STARTTLS', 'tls EHLO', 'tls AUTH', 'tls MAIL', 'tls RCPT', 'tls DATA', 'tls QUIT',
    ]);
    expect(session.auth).toEqual([{ mechanism: 'PLAIN', user: FIXTURE_USER, pass: FIXTURE_PASS }]);
    expect(session.messages).toHaveLength(1);
  });

  it('implicit TLS (secureTransport on) with AUTH LOGIN', async () => {
    await sendSmtp(smtp('implicit', { security: 'tls', ...auth }), trusted(), envelope, message, { timeouts: FAST });
    const session = (await sessions('implicit')).at(-1)!;
    expect(session.commands.every((c) => c.secure)).toBe(true);
    expect(session.auth).toEqual([{ mechanism: 'LOGIN', user: FIXTURE_USER, pass: FIXTURE_PASS }]);
  });

  it('a refused AUTH (535) carries the code, with the password the server repeated redacted', async () => {
    const err = await failure(sendSmtp(smtp('auth535', { security: 'starttls', ...auth }), trusted(), envelope, message, { timeouts: FAST }));
    expect(err.status).toBe(535);
    expect(err.message).toBe('The SMTP server refused AUTH (535): 5.7.8 Bad credentials [redacted]');
  });

  it('refuses bytes injected after the STARTTLS reply, before the handshake', async () => {
    const err = await failure(sendSmtp(smtp('inject', { security: 'starttls', ...auth }), trusted(), envelope, message, { timeouts: FAST }));
    expect(err.message).toBe('The SMTP server sent data after its STARTTLS reply; refusing to go on');
    expect((await sessions('inject')).at(-1)!.auth).toEqual([]);
  });

  it('refuses a trusted certificate for another host name', async () => {
    const err = await failure(sendSmtp(smtp('otherHost', { security: 'tls', ...auth }), trusted(), envelope, message, { timeouts: FAST }));
    expect(err.message).toMatch(/^(Could not connect to the SMTP server localhost:\d+ with TLS|The SMTP connection to localhost:\d+ failed)/);
    expect((await sessions('otherHost')).every((s) => s.auth.length === 0)).toBe(true);
  });

  it("the platform's own connect() refuses the test authority (implicit TLS and STARTTLS), and no credentials are sent", async () => {
    const implicit = await failure(sendSmtp(smtp('implicit', { security: 'tls', ...auth }), platform, envelope, message, { timeouts: FAST }));
    expect(implicit.message).toMatch(/^(Could not connect to the SMTP server localhost:\d+ with TLS|The SMTP connection to localhost:\d+ failed)/);
    const before = (await sessions('starttls')).length;
    const starttls = await failure(sendSmtp(smtp('starttls', { security: 'starttls', ...auth }), platform, envelope, message, { timeouts: FAST }));
    expect(starttls.message).toMatch(/^The TLS handshake with localhost:\d+ failed \(its certificate must be valid for localhost\): /);
    const tried = (await sessions('starttls')).slice(before);
    expect(tried.length).toBeGreaterThan(0);
    for (const session of tried) {
      expect(session.auth).toEqual([]);
      expect(session.commands.map((c) => c.line)).toEqual(['EHLO plan.example.com', 'STARTTLS']);
    }
  });
});

describe('POST /api/admin/mail/test in workerd', () => {
  it('through the Worker: the log transport of wrangler.test.jsonc answers { ok: true }', async () => {
    const { client } = await setupOwner();
    expect(await client.post('/api/admin/mail/test')).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('through a DirectoryDO configured for SMTP: delivered with cloudflare:sockets, and 502 when refused', async () => {
    // A directory request's meta, as the Worker writes it (the session travels in the Cookie header).
    const meta = (): TrustedMeta => ({
      clientIp: '192.0.2.10',
      secure: true,
      requestId: crypto.randomUUID(),
      userAgent: 'vitest',
      sessionTokenHash: null,
      sessionCookie: null,
    });
    const vars = (scenario: SmtpScenario) => ({
      ...(env as unknown as Env),
      MAIL_TRANSPORT: 'smtp',
      MAIL_FROM: 'no-reply@plan.example.com',
      SMTP_HOST: 'localhost',
      SMTP_PORT: String(port(scenario)),
      SMTP_SECURITY: 'none',
    });
    for (const [scenario, expected] of [
      ['plain', 200],
      ['rcpt550', 502],
    ] as const) {
      await runInDurableObject(env.TEST_DB.getByName(`mail-directory-${scenario}`), async (_instance, state) => {
        const directory = new WorkerDirectoryDO(state, vars(scenario));
        await settle();
        let cookie = '';
        const call = async (method: string, path: string, body?: unknown) => {
          const res = await directory.fetch(
            new Request(`${ORIGIN}${path}`, {
              method,
              headers: { [META_HEADER]: encodeMeta(meta()), 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          );
          const session = res.headers.getSetCookie().find((c) => c.startsWith('__Host-lyren_session=') && !c.includes('Max-Age=0'));
          if (session) cookie = session.split(';')[0]!;
          return { status: res.status, body: (await res.json()) as any };
        };
        const setup = await call('POST', '/api/auth/setup', { email: 'owner@example.com', password: PASSWORD, displayName: 'Owner', setupCode: 'test' });
        expect(setup.status).toBe(201);
        expect((await call('GET', '/api/auth/status')).body.instance.mail).toBe(true);
        const res = await call('POST', '/api/admin/mail/test');
        expect(res.status, JSON.stringify(res.body)).toBe(expected);
        if (expected === 200) {
          expect(res.body.messageId).toMatch(/^<[0-9a-f]{32}@plan\.example\.com>$/);
          // Setup's verification link travels in a session of its own, maybe at the same time.
          const session = (await sessions('plain')).find((s) => s.messages.some((m) => m.includes(`Message-ID: ${res.body.messageId}\r\n`)))!;
          expect(session.commands.map((c) => c.line)).toContain('RCPT TO:<owner@example.com>');
          expect(session.messages[0]).toContain(`Message-ID: ${res.body.messageId}\r\n`);
        } else {
          expect(res.body).toEqual({ error: { code: 'unavailable', message: 'The SMTP server refused RCPT TO (550): 5.1.1 <alice@example.com>: Recipient address rejected' } });
        }
        // The directory set its first maintenance alarm on this bare object, which has no alarm handler.
        await state.storage.deleteAlarm();
      });
    }
  });

  it('MAIL_TRANSPORT=cloudflare sends through the EMAIL binding, and without one the directory answers 503 with the reason', async () => {
    const sent: unknown[] = [];
    const email = { send: async (m: unknown) => (sent.push(m), { messageId: 'cf-message-1' }) };
    const base = { ...(env as unknown as Env), MAIL_TRANSPORT: 'cloudflare', MAIL_FROM: 'no-reply@plan.example.com' };
    const headers = (cookie = '') => ({
      [META_HEADER]: encodeMeta({ clientIp: '192.0.2.10', secure: true, requestId: crypto.randomUUID(), userAgent: 'vitest', sessionTokenHash: null, sessionCookie: null }),
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    });
    await runInDurableObject(env.TEST_DB.getByName('mail-directory-binding'), async (_instance, state) => {
      const directory = new WorkerDirectoryDO(state, { ...base, EMAIL: email as unknown as SendEmail });
      await settle();
      const setup = await directory.fetch(
        new Request(`${ORIGIN}/api/auth/setup`, { method: 'POST', headers: headers(), body: JSON.stringify({ email: 'owner@example.com', password: PASSWORD, displayName: 'Owner', setupCode: 'test' }) }),
      );
      expect(setup.status).toBe(201);
      const cookie = setup.headers.getSetCookie().find((c) => c.startsWith('__Host-lyren_session='))!.split(';')[0]!;
      const res = await directory.fetch(new Request(`${ORIGIN}/api/admin/mail/test`, { method: 'POST', headers: headers(cookie), body: '{}' }));
      expect(await res.json()).toEqual({ ok: true, messageId: 'cf-message-1' });
      expect(sent).toEqual([
        expect.objectContaining({ from: { name: 'Lyren Plan', email: 'no-reply@plan.example.com' }, to: 'owner@example.com', subject: 'Test message from Lyren Plan' }),
      ]);
      await state.storage.deleteAlarm();
    });
    await runInDurableObject(env.TEST_DB.getByName('mail-directory-no-binding'), async (_instance, state) => {
      const directory = new WorkerDirectoryDO(state, base);
      await settle();
      const res = await directory.fetch(new Request(`${ORIGIN}/api/auth/status`, { headers: headers() }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: {
          code: 'unavailable',
          message:
            'Configuration error: MAIL_TRANSPORT=cloudflare needs a send_email binding named EMAIL in the Worker\'s configuration ("send_email": [{ "name": "EMAIL" }], Workers Paid)',
        },
      });
    });
  });
});
