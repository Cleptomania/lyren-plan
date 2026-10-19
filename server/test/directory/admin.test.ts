// /api/admin/backup (design §9.5): instance admins with the re-auth window, through DirectoryDeps.backup;
// 404 when the runtime cannot offer it; HEAD answers with the headers only and writes no set.
// /api/admin/mail/test (§5.10.5, §7.2): a test message to the admin's own address, sent at once; 502 with
// the transport's error. The same through the Node stack with its SMTP connector: server/test/runtime/mail.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { MailError } from '../../src/mail/errors';
import { createLogTransport } from '../../src/mail/log';
import { createDirectoryHarness, PASSWORD } from '../support/directoryHarness';

function fakeBackup() {
  let created = 0;
  return {
    get created() {
      return created;
    },
    async create() {
      created++;
      const bytes = new TextEncoder().encode('tar bytes');
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        size: bytes.length,
        filename: 'lyren-backup-2026-10-17.tar',
      };
    },
  };
}

describe('GET /api/admin/backup', () => {
  it('streams the set to an instance admin, and records the download', async () => {
    const backup = fakeBackup();
    const h = createDirectoryHarness({ backup });
    const { client, user } = await h.setup();
    expect((await client.get('/api/auth/status')).body.instance.features.backupDownload).toBe(true);
    const res = await client.get('/api/admin/backup');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-tar');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="lyren-backup-2026-10-17.tar"');
    expect(res.headers.get('content-length')).toBe('9');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toBe('tar bytes');
    expect(h.db.get('SELECT user_id, actor_id FROM security_events WHERE type = :t', { t: 'admin_backup_downloaded' })).toEqual({
      user_id: user.id,
      actor_id: user.id,
    });
  });

  it('HEAD answers with the headers only and writes no set', async () => {
    const backup = fakeBackup();
    const h = createDirectoryHarness({ backup });
    const { client } = await h.setup();
    const res = await client.head('/api/admin/backup');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-tar');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="lyren-backup-2026-10-17.tar"');
    expect(backup.created).toBe(0);
  });

  it('needs an instance admin and the re-auth window', async () => {
    const backup = fakeBackup();
    const h = createDirectoryHarness({ backup });
    const { client, spaceId } = await h.setup();
    const member = await h.addUser({ email: 'member@example.com', spaceId });
    expect((await member.client.get('/api/admin/backup')).status).toBe(403);
    expect((await h.client().get('/api/admin/backup')).status).toBe(401);
    h.clock.advance(11 * 60_000);
    expect((await client.get('/api/admin/backup')).body.error.code).toBe('reauth_required');
    await client.post('/api/account/reauth/password', { password: PASSWORD });
    expect((await client.get('/api/admin/backup')).status).toBe(200);
    expect(backup.created).toBe(1);
  });

  it('answers 404 when the runtime offers no backup download', async () => {
    const off = createDirectoryHarness({ backup: fakeBackup(), capabilities: { backupDownload: false } });
    const { client } = await off.setup();
    expect((await client.get('/api/admin/backup')).status).toBe(404);
    expect((await client.get('/api/auth/status')).body.instance.features.backupDownload).toBe(false);
    const none = createDirectoryHarness();
    expect((await (await none.setup()).client.get('/api/admin/backup')).status).toBe(404);
  });
});

describe('POST /api/admin/mail/test', () => {
  it("sends a test message to the admin's own address at once and answers { ok, messageId }", async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    const res = await client.post('/api/admin/mail/test');
    expect(res).toMatchObject({ status: 200, body: { ok: true, messageId: '<test-1@example.com>' } });
    expect(h.outbox).toHaveLength(1);
    expect(h.outbox[0]).toMatchObject({ to: 'owner@example.com', subject: 'Test message from Lyren Plan', template: 'mail_test' });
  });

  it('answers 502 unavailable with the transport’s error, and records it', async () => {
    const h = createDirectoryHarness();
    const { client } = await h.setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.recording.failWith = new MailError('The SMTP server refused AUTH (535): 5.7.8 Authentication credentials invalid', 535);
    const res = await client.post('/api/admin/mail/test');
    expect(res).toMatchObject({
      status: 502,
      body: { error: { code: 'unavailable', message: 'The SMTP server refused AUTH (535): 5.7.8 Authentication credentials invalid' } },
    });
    const events = await client.get('/api/account/security-events');
    expect(events.body[0]).toMatchObject({ type: 'mail_failed', data: { template: 'mail_test', reason: 'transport', status: 535 } });
    vi.restoreAllMocks();
  });

  it('with the log transport the message goes to the log, { ok: true }', async () => {
    const lines: string[] = [];
    const h = createDirectoryHarness({ mail: createLogTransport({ logBodies: false }, (line) => lines.push(line)) });
    const { client } = await h.setup();
    expect(await client.post('/api/admin/mail/test')).toMatchObject({ status: 200, body: { ok: true } });
    expect(lines).toEqual(['[lyren] Mail not sent (MAIL_TRANSPORT=log): mail_test to an address at example.com (suppressed)']);
  });

  it('needs an instance admin with an email address', async () => {
    const h = createDirectoryHarness();
    const { spaceId } = await h.setup();
    expect((await h.client().post('/api/admin/mail/test')).status).toBe(401);
    const member = await h.addUser({ email: 'member@example.com', spaceId });
    expect(await member.client.post('/api/admin/mail/test')).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    // An admin from before email addresses (a legacy username only).
    const legacy = await h.addUser({ email: 'legacy@example.com', isInstanceAdmin: true });
    h.db.run("UPDATE users SET email = NULL, email_key = NULL, username = 'legacy' WHERE id = :id", { id: legacy.user.id });
    expect(await legacy.client.post('/api/admin/mail/test')).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: 'Your account has no email address to send the test message to. Add one first.' } },
    });
    // Setup's verification link is the only message.
    await h.settle();
    expect(h.outbox.map((m) => m.template)).toEqual(['verify_email']);
  });
});
