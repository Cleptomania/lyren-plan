// Mail through the Node stack (runtime/node/stack.ts, design §5.10, §9.1): the transport MAIL_TRANSPORT
// names, built with Node's SMTP connector, answering POST /api/admin/mail/test against a fake SMTP server
// on 127.0.0.1: delivered over a plain local connection (SMTP_SECURITY=none), refused with the server's
// reply code, and refused when the server's certificate does not verify (the stack trusts only the
// system's authorities), with no credentials sent and no secret in the answer.

import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext } from '../helpers';
import { startFakeSmtp, type FakeSmtpServer } from '../support/fakeSmtp';
import { makeTestCerts, missingOpenssl, type TestCerts } from '../support/testCerts';

const SMTP_PASS = 'stack-Secret-pass';

const servers: FakeSmtpServer[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
});

/** A server whose configuration sends mail to `port` on this machine. */
function stackWithSmtp(vars: Record<string, string>) {
  vi.stubEnv('MAIL_TRANSPORT', 'smtp');
  vi.stubEnv('MAIL_FROM', 'no-reply@plan.example.com');
  vi.stubEnv('PUBLIC_URL', 'https://plan.example.com');
  vi.stubEnv('SMTP_HOST', 'localhost');
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  return createTestContext({ mail: 'configured' });
}

describe('POST /api/admin/mail/test on the Node stack', () => {
  it('delivers the test message with the configured transport (SMTP_SECURITY=none to this machine)', async () => {
    const server = await startFakeSmtp();
    servers.push(server);
    const ctx = stackWithSmtp({ SMTP_PORT: String(server.port), SMTP_SECURITY: 'none' });
    expect(ctx.stack.mail).toMatchObject({ kind: 'smtp', deliversMail: true });
    const { client } = await ctx.signedIn();
    expect((await client.get('/api/auth/status')).body.instance.mail).toBe(true);
    const res = await client.post('/api/admin/mail/test');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: expect.stringMatching(/^<[0-9a-f]{32}@plan\.example\.com>$/) });
    // Setup's verification link travels in a session of its own, maybe at the same time.
    const session = server.sessions.find((s) => s.messages.some((m) => m.includes(`Message-ID: ${res.body.messageId}\r\n`)))!;
    expect(session.commands.map((c) => c.line)).toContain('RCPT TO:<owner@example.com>');
    expect(session.messages[0]).toContain(`Message-ID: ${res.body.messageId}\r\n`);
    expect(session.messages[0]).toContain('Subject: Test message from Lyren Plan\r\n');
    expect(ctx.outbox).toEqual([]);
  });

  it('answers 502 with the reply code when the server refuses', async () => {
    const server = await startFakeSmtp({ replies: { RCPT: '550 5.7.1 Relaying denied' } });
    servers.push(server);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = stackWithSmtp({ SMTP_PORT: String(server.port), SMTP_SECURITY: 'none' });
    const { client } = await ctx.signedIn();
    expect(await client.post('/api/admin/mail/test')).toMatchObject({
      status: 502,
      body: { error: { code: 'unavailable', message: 'The SMTP server refused RCPT TO (550): 5.7.1 Relaying denied' } },
    });
  });

  const noOpenssl = missingOpenssl();
  describe.skipIf(noOpenssl !== null)(`a certificate the system does not trust${noOpenssl ? ` (skipped: ${noOpenssl})` : ''}`, () => {
    let certs: TestCerts;
    beforeAll(() => {
      certs = makeTestCerts();
    });
    afterAll(() => {
      if (certs) fs.rmSync(certs.dir, { recursive: true, force: true });
    });

    it.each(['starttls', 'tls'] as const)('SMTP_SECURITY=%s: refused before any credentials, and no secret in the answer', async (security) => {
      const server = await startFakeSmtp({ mode: security === 'tls' ? 'implicit' : 'plain', tls: { key: certs.key, cert: certs.cert } });
      servers.push(server);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const ctx = stackWithSmtp({ SMTP_PORT: String(server.port), SMTP_SECURITY: security, SMTP_USER: 'mailer', SMTP_PASS });
      const { client } = await ctx.signedIn();
      const res = await client.post('/api/admin/mail/test');
      expect(res.status).toBe(502);
      expect(res.body.error.message).toMatch(/certificate|self-signed|unable to (get local issuer|verify)/i);
      expect(JSON.stringify(res.body)).not.toContain(SMTP_PASS);
      expect(JSON.stringify((await client.get('/api/auth/status')).body)).not.toContain(SMTP_PASS);
      expect(server.sessions.every((s) => s.auth.length === 0)).toBe(true);
    });
  });
});
