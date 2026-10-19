// Invitations (design §5.8.8): creating, listing, resending and revoking a space's invitations with the
// role rules of §6.2; the synchronous mail (a failed send answers 503 and leaves no row and no token) and
// the link delivery without mail; inspecting; accepting as a new account or as the signed-in one; the
// account's own pending invitations; the quotas of §11.4 and the iv/ir limits; the checks at acceptance and
// the revocations of the lifecycle; instance invitations through the service. The policy matrix of §5.3 is
// policy.test.ts's, enumeration enumeration.test.ts's.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusDTO, InvitationCreatedDTO, InvitationDTO, InvitationPreviewDTO, PendingInvitationDTO } from '@shared/types';
import { createInvitation, revokeInvitationsSentBy } from '../../src/directory/invitations';
import { findUser } from '../../src/directory/users';
import { MailError } from '../../src/mail/errors';
import { createLogTransport } from '../../src/mail/log';
import { createTestContext } from '../helpers';
import { addMembership, createDirectoryHarness, OWNER_EMAIL, PASSWORD, testMeta, type DirectoryTestClient } from '../support/directoryHarness';
import { linkToken, tokenOfLink } from '../support/mail';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };
const DAY_MS = 86_400_000;

type Harness = ReturnType<typeof createDirectoryHarness>;

/** An instance with mail whose owner (an instance admin) has a verified address. */
async function instance(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const h = createDirectoryHarness({ vars: PUBLIC, ...o });
  const owner = await h.setup();
  h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
  await h.settle();
  h.outbox.length = 0;
  return { h, owner };
}

/** An instance without mail (MAIL_TRANSPORT=log): invitations are links. */
async function mailless(o: Parameters<typeof createDirectoryHarness>[0] = {}) {
  const lines: string[] = [];
  const h = createDirectoryHarness({ vars: PUBLIC, mail: createLogTransport({ logBodies: false }, (line) => lines.push(line)), ...o });
  const owner = await h.setup();
  return { h, owner, lines };
}

/** POST /api/spaces/:spaceId/invitations (the body is an InvitationCreatedDTO on 201, an error otherwise). */
const invite = (client: DirectoryTestClient, spaceId: string, email: string, role = 'member') =>
  client.post(`/api/spaces/${spaceId}/invitations`, { email, role });

/** The token of the last invitation mailed to `to`. */
const mailedToken = (h: Harness, to: string) => linkToken(h.outbox.filter((m) => m.template === 'invitation' && m.to === to).at(-1));

const verify = (h: Harness, userId: number) =>
  h.db.run('UPDATE users SET email_verified_at = :now WHERE id = :id', { id: userId, now: new Date(h.clock.now()).toISOString() });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('creating a space invitation', () => {
  it('with mail: sent at once (10 s), 201 with no link; the inviter must have a verified address', async () => {
    const { h, owner } = await instance();
    const res = await invite(owner.client, owner.spaceId, 'Alice@Example.com');
    expect(res.status).toBe(201);
    expect(res.body.link).toBeNull();
    expect(res.body.invitation).toMatchObject({
      email: 'Alice@example.com',
      role: 'member',
      invitedBy: { id: owner.user.id, displayName: 'Owner' },
      sendCount: 1,
      delivery: 'mail',
      status: 'pending',
    });
    expect(Date.parse(res.body.invitation.expiresAt) - h.clock.now()).toBe(7 * DAY_MS);
    // Synchronous: in the outbox before anything deferred ran.
    expect(h.outbox.map((m) => [m.template, m.to])).toEqual([['invitation', 'Alice@example.com']]);
    expect(h.recording.options.at(-1)).toEqual({ timeoutMs: 10_000 });
    const message = h.outbox[0]!;
    expect(message.text).toContain('https://plan.example.com/invite#t=');
    expect(message.text).toContain('Invited by: Owner (owner@example.com)');
    expect(message.subject).toBe("You're invited to a space on Lyren Plan");

    h.db.run('UPDATE users SET email_verified_at = NULL');
    expect(await invite(owner.client, owner.spaceId, 'bob@example.com')).toMatchObject({
      status: 403,
      body: { error: { code: 'forbidden', message: 'Verify your email address before inviting people' } },
    });
  });

  it('who may invite: admins members and viewers, owners admins too (with the re-auth window); nobody an owner', async () => {
    const { h, owner } = await instance();
    const admin = await h.addUser({ email: 'admin@example.com', spaceId: owner.spaceId, role: 'admin' });
    const member = await h.addUser({ email: 'member@example.com', spaceId: owner.spaceId, role: 'member' });
    const viewer = await h.addUser({ email: 'viewer@example.com', spaceId: owner.spaceId, role: 'viewer' });
    for (const u of [admin, member, viewer]) verify(h, u.user.id);
    const refused = { status: 403, body: { error: { code: 'forbidden', message: 'Only admins and owners can manage invitations' } } };
    expect(await invite(member.client, owner.spaceId, 'x@example.com')).toMatchObject(refused);
    expect(await invite(viewer.client, owner.spaceId, 'x@example.com')).toMatchObject(refused);
    expect((await member.client.get(`/api/spaces/${owner.spaceId}/invitations`)).status).toBe(403);
    expect((await invite(admin.client, owner.spaceId, 'x@example.com', 'viewer')).status).toBe(201);
    expect(await invite(admin.client, owner.spaceId, 'y@example.com', 'admin')).toMatchObject({
      status: 403,
      body: { error: { message: 'Only owners can invite admins' } },
    });
    expect((await invite(owner.client, owner.spaceId, 'z@example.com', 'owner')).body.error.code).toBe('validation_error');
    h.clock.advance(11 * 60_000);
    expect((await invite(owner.client, owner.spaceId, 'y@example.com', 'admin')).body.error.code).toBe('reauth_required');
    // A member and viewer invitation needs no re-auth.
    expect((await invite(owner.client, owner.spaceId, 'w@example.com', 'member')).status).toBe(201);
    await owner.client.post('/api/account/reauth/password', { password: PASSWORD });
    expect((await invite(owner.client, owner.spaceId, 'y@example.com', 'admin')).status).toBe(201);
    // A non-member learns nothing about the space.
    const stranger = await h.addUser({ email: 'stranger@example.com' });
    expect((await invite(stranger.client, owner.spaceId, 'v@example.com')).status).toBe(404);
  });

  it('a member is refused (409); a pending invitation is refused (409); an expired one is replaced', async () => {
    const { h, owner } = await instance();
    await h.addUser({ email: 'member@example.com', spaceId: owner.spaceId, role: 'member' });
    expect(await invite(owner.client, owner.spaceId, 'MEMBER@example.com')).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: 'MEMBER@example.com is already a member' } },
    });
    const first = await invite(owner.client, owner.spaceId, 'carol@example.com');
    expect(await invite(owner.client, owner.spaceId, 'carol@example.com')).toMatchObject({
      status: 409,
      body: { error: { message: 'An invitation to this address is pending' } },
    });
    const oldToken = mailedToken(h, 'carol@example.com');
    h.clock.advance(7 * DAY_MS);
    const list = await owner.client.get<InvitationDTO[]>(`/api/spaces/${owner.spaceId}/invitations`);
    expect(list.body.map((i) => [i.email, i.status])).toEqual([['carol@example.com', 'expired']]);
    const second = await invite(owner.client, owner.spaceId, 'carol@example.com');
    expect(second.status).toBe(201);
    expect(second.body.invitation.id).not.toBe(first.body.invitation.id);
    expect(h.db.get<{ revoked_at: string | null; revoked_by: number | null }>('SELECT * FROM invitations WHERE id = :id', { id: first.body.invitation.id })).toMatchObject({
      revoked_by: null,
    });
    expect((await h.client().post('/api/invitations/inspect', { token: oldToken })).body.error.code).toBe('invalid_token');
  });

  it('a send that fails answers 503 and leaves no row, no token in the answer or the logs; the limits are given back', async () => {
    const { h, owner } = await instance();
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => logged.push(args.join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...args) => logged.push(args.join(' ')));
    h.recording.failWith = new MailError('The SMTP server refused RCPT TO (550): no such user', 550);
    const res = await invite(owner.client, owner.spaceId, 'alice@example.com');
    expect(res).toMatchObject({ status: 503, body: { error: { code: 'unavailable', message: 'The invitation email could not be sent. Try again later.' } } });
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(h.db.all('SELECT id FROM invitations')).toEqual([]);
    expect(logged.join('\n')).not.toContain('#t=');
    expect(logged.join('\n')).toContain('[lyren] Mail not sent: invitation to an address at example.com: The SMTP server refused RCPT TO (550)');
    expect(h.db.get<{ count: number }>("SELECT count FROM auth_throttle WHERE key = 'ir:alice@example.com'")).toMatchObject({ count: 0 });
    // A budget used up is the same 503 (MAIL_DAILY_CAP).
    h.recording.failWith = null;
    // Setup's verification message took one of the two.
    const capped = await instance({ vars: { ...PUBLIC, MAIL_DAILY_CAP: '2' } });
    expect((await invite(capped.owner.client, capped.owner.spaceId, 'one@example.com')).status).toBe(201);
    expect((await invite(capped.owner.client, capped.owner.spaceId, 'two@example.com')).status).toBe(503);
    expect(capped.h.db.all('SELECT email FROM invitations')).toEqual([{ email: 'one@example.com' }]);
  });

  it('without mail: a link for the inviter (absolute from PUBLIC_URL, else a share origin, else a path), in no log', async () => {
    const { h, owner, lines } = await mailless();
    const res = await invite(owner.client, owner.spaceId, 'alice@example.com');
    expect(res.status).toBe(201);
    expect(res.body.invitation.delivery).toBe('link');
    expect(res.body.link).toMatch(/^https:\/\/plan\.example\.com\/invite#t=[A-Za-z0-9_-]{43}$/);
    expect(lines.join('\n')).not.toContain(tokenOfLink(res.body.link!));
    expect(lines.join('\n')).not.toContain('invitation');

    const lan = await mailless({ vars: {}, shareOrigins: ['http://192.168.1.20:43770', 'http://10.0.0.5:43770'] });
    expect((await invite(lan.owner.client, lan.owner.spaceId, 'bob@example.com')).body.link).toMatch(/^http:\/\/192\.168\.1\.20:43770\/invite#t=/);
    const local = await mailless({ vars: {} });
    expect((await invite(local.owner.client, local.owner.spaceId, 'bob@example.com')).body.link).toMatch(/^\/invite#t=/);
    // No address needs verifying where nothing can be verified.
    expect(h.db.get<{ email_verified_at: string | null }>('SELECT email_verified_at FROM users')!.email_verified_at).toBeNull();
  });
});

describe('list, resend and revoke', () => {
  it('lists open invitations without tokens; resend waits 10 minutes, rotates the token, sends at most 5 times', async () => {
    const { h, owner } = await instance();
    const created = await invite(owner.client, owner.spaceId, 'alice@example.com');
    const id = created.body.invitation.id;
    const list = await owner.client.get<InvitationDTO[]>(`/api/spaces/${owner.spaceId}/invitations`);
    expect(list.body).toEqual([created.body.invitation]);
    expect(JSON.stringify(list.body)).not.toContain('token');
    const resend = (c = owner.client) => c.post<InvitationCreatedDTO>(`/api/spaces/${owner.spaceId}/invitations/${id}/resend`);
    const soon = await resend();
    expect(soon.status).toBe(429);
    expect(Number(soon.headers.get('Retry-After'))).toBe(600);
    const first = mailedToken(h, 'alice@example.com');
    // A day apart: at most 3 invitation mails reach one address a day (ir).
    for (let send = 2; send <= 5; send++) {
      h.clock.advance(DAY_MS);
      const res = await resend();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ link: null, invitation: { sendCount: send } });
    }
    expect((await h.client().post('/api/invitations/inspect', { token: first })).body.error.code).toBe('invalid_token');
    expect((await h.client().post('/api/invitations/inspect', { token: mailedToken(h, 'alice@example.com') })).status).toBe(200);
    h.clock.advance(10 * 60_000);
    expect(await resend()).toMatchObject({ status: 409, body: { error: { code: 'quota_exceeded', message: 'This invitation was sent 5 times. Revoke it and invite again.' } } });
  });

  it('a failed resend leaves the earlier link working; without mail a resend rotates the link', async () => {
    const { h, owner } = await instance();
    const id = (await invite(owner.client, owner.spaceId, 'alice@example.com')).body.invitation.id;
    const token = mailedToken(h, 'alice@example.com');
    h.clock.advance(10 * 60_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.recording.failWith = new MailError('The SMTP server did not answer in time (DATA)');
    expect((await owner.client.post(`/api/spaces/${owner.spaceId}/invitations/${id}/resend`)).status).toBe(503);
    expect((await h.client().post('/api/invitations/inspect', { token })).status).toBe(200);
    expect(h.db.get<{ send_count: number }>('SELECT send_count FROM invitations')!.send_count).toBe(1);

    const quiet = await mailless();
    const made = await invite(quiet.owner.client, quiet.owner.spaceId, 'bob@example.com');
    quiet.h.clock.advance(10 * 60_000);
    const again = await quiet.owner.client.post<InvitationCreatedDTO>(`/api/spaces/${quiet.owner.spaceId}/invitations/${made.body.invitation.id}/resend`);
    expect(again.status).toBe(200);
    expect(again.body.link).not.toBe(made.body.link);
    expect((await quiet.h.client().post('/api/invitations/inspect', { token: tokenOfLink(made.body.link!) })).body.error.code).toBe('invalid_token');
    expect((await quiet.h.client().post('/api/invitations/inspect', { token: tokenOfLink(again.body.link!) })).status).toBe(200);
  });

  it('an admin invitation is the owners’ to resend (with re-auth) and revoke; the one who resends becomes the inviter', async () => {
    const { h, owner } = await instance();
    const admin = await h.addUser({ email: 'admin@example.com', displayName: 'Ada', spaceId: owner.spaceId, role: 'admin' });
    verify(h, admin.user.id);
    const adminInvite = (await invite(owner.client, owner.spaceId, 'boss@example.com', 'admin')).body.invitation.id;
    const memberInvite = (await invite(owner.client, owner.spaceId, 'staff@example.com', 'member')).body.invitation.id;
    h.clock.advance(10 * 60_000);
    const path = (id: number, tail = '') => `/api/spaces/${owner.spaceId}/invitations/${id}${tail}`;
    expect((await admin.client.post(path(adminInvite, '/resend'))).body.error.message).toBe('Only owners can manage invitations of admins');
    expect((await admin.client.delete(path(adminInvite))).status).toBe(403);
    expect((await owner.client.post(path(adminInvite, '/resend'))).body.error.code).toBe('reauth_required');
    const resent = await admin.client.post<InvitationCreatedDTO>(path(memberInvite, '/resend'));
    expect(resent.body.invitation.invitedBy).toEqual({ id: admin.user.id, displayName: 'Ada' });
    expect(h.outbox.at(-1)!.text).toContain('Invited by: Ada (admin@example.com)');
    expect(await admin.client.delete(path(memberInvite))).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.db.get<{ revoked_by: number }>('SELECT revoked_by FROM invitations WHERE id = :id', { id: memberInvite })!.revoked_by).toBe(admin.user.id);
    expect((await owner.client.delete(path(memberInvite))).status).toBe(404);
    expect((await owner.client.delete(path(999))).status).toBe(404);
    expect((await h.client().post('/api/invitations/inspect', { token: mailedToken(h, 'staff@example.com') })).body.error.code).toBe('invalid_token');
  });
});

describe('quotas and limits (§11.4, §5.9)', () => {
  it('MAX_OPEN_INVITATIONS_PER_SPACE and MAX_MEMBERS_PER_SPACE (members plus open invitations); expired ones count for neither', async () => {
    const { h, owner } = await instance({ vars: { ...PUBLIC, MAX_OPEN_INVITATIONS_PER_SPACE: '2', MAX_MEMBERS_PER_SPACE: '4' } });
    expect((await invite(owner.client, owner.spaceId, 'a@example.com')).status).toBe(201);
    expect((await invite(owner.client, owner.spaceId, 'b@example.com')).status).toBe(201);
    expect(await invite(owner.client, owner.spaceId, 'c@example.com')).toMatchObject({
      status: 409,
      body: { error: { code: 'quota_exceeded', message: 'A space can have at most 2 open invitations' } },
    });
    await h.addUser({ email: 'm@example.com', spaceId: owner.spaceId, role: 'member' });
    h.db.run("UPDATE invitations SET expires_at = :past WHERE email = 'b@example.com'", { past: new Date(h.clock.now() - 1).toISOString() });
    // Members 2 + open 1 = 3: one more fits, then the space is full.
    expect((await invite(owner.client, owner.spaceId, 'c@example.com')).status).toBe(201);
    h.db.run("UPDATE invitations SET expires_at = :past WHERE email = 'a@example.com'", { past: new Date(h.clock.now() - 1).toISOString() });
    await h.addUser({ email: 'n@example.com', spaceId: owner.spaceId, role: 'member' });
    expect(await invite(owner.client, owner.spaceId, 'd@example.com')).toMatchObject({
      status: 409,
      body: { error: { message: 'A space can have at most 4 members, open invitations included' } },
    });
  });

  it('INVITATIONS_PER_DAY per inviter (5 for an account younger than a day, but an instance admin), counted on create and resend', async () => {
    const { h, owner } = await instance({ vars: { ...PUBLIC, INVITATIONS_PER_DAY: '7' } });
    const young = await h.addUser({ email: 'young@example.com', spaceId: owner.spaceId, role: 'admin' });
    verify(h, young.user.id);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await invite(young.client, owner.spaceId, `young${i}@example.com`)).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect(await invite(young.client, owner.spaceId, 'young6@example.com')).toMatchObject({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'A new account can send 5 invitations on its first day' } },
    });
    // The first admin of a new instance is minutes old too, and invites its people.
    const first = [];
    for (let i = 0; i < 8; i++) first.push((await invite(owner.client, owner.spaceId, `first${i}@example.com`)).status);
    expect(first).toEqual([201, 201, 201, 201, 201, 201, 201, 429]);
    h.db.run("UPDATE invitations SET revoked_at = :now WHERE revoked_at IS NULL", { now: new Date(h.clock.now()).toISOString() });
    h.clock.advance(DAY_MS);
    const later = [];
    for (let i = 0; i < 8; i++) later.push((await invite(owner.client, owner.spaceId, `old${i}@example.com`)).status);
    expect(later).toEqual([201, 201, 201, 201, 201, 201, 201, 429]);
    // Resends count as well.
    h.clock.advance(DAY_MS);
    const id = h.db.get<{ id: number }>("SELECT id FROM invitations WHERE email = 'old0@example.com'")!.id;
    h.db.run('INSERT OR REPLACE INTO auth_throttle (key, window_start, count, blocked_until) VALUES (:key, :now, 7, NULL)', {
      key: `iv:${owner.user.id}`,
      now: new Date(h.clock.now()).toISOString(),
    });
    expect((await owner.client.post(`/api/spaces/${owner.spaceId}/invitations/${id}/resend`)).status).toBe(429);
  });

  it('ir: 3 invitation mails to one address a day across the instance, whoever sends them', async () => {
    const { h, owner } = await instance();
    const other = await h.addUser({ email: 'other@example.com' });
    verify(h, other.user.id);
    const otherSpace = (await other.client.post('/api/spaces', { name: 'Other' })).body.id as string;
    expect((await invite(owner.client, owner.spaceId, 'target@example.com')).status).toBe(201);
    expect((await invite(other.client, otherSpace, 'target@example.com')).status).toBe(201);
    await owner.client.delete(`/api/spaces/${owner.spaceId}/invitations/${h.db.get<{ id: number }>("SELECT id FROM invitations WHERE space_id = 1")!.id}`);
    expect((await invite(owner.client, owner.spaceId, 'target@example.com')).status).toBe(201);
    expect(await invite(owner.client, owner.spaceId, 'second@example.com')).toMatchObject({ status: 201 });
    await owner.client.delete(`/api/spaces/${owner.spaceId}/invitations/${h.db.get<{ id: number }>("SELECT id FROM invitations WHERE email = 'target@example.com' AND space_id = 1 AND revoked_at IS NULL")!.id}`);
    expect(await invite(owner.client, owner.spaceId, 'target@example.com')).toMatchObject({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'Too many invitations were sent to this address today' } },
    });
  });
});

describe('inspecting an invitation', () => {
  it('a mailed invitation tells whether the address has an account; a copied link does not, unless its owner is signed in', async () => {
    const { h, owner } = await instance();
    await invite(owner.client, owner.spaceId, 'new@example.com', 'viewer');
    const preview = await h.client().post<InvitationPreviewDTO>('/api/invitations/inspect', { token: mailedToken(h, 'new@example.com') });
    expect(preview.body).toEqual({
      kind: 'space',
      spaceName: "Owner's space",
      inviterName: 'Owner',
      inviterEmail: OWNER_EMAIL,
      role: 'viewer',
      email: 'new@example.com',
      expiresAt: new Date(h.clock.now() + 7 * DAY_MS).toISOString(),
      account: 'new',
      signedIn: null,
    });
    const existing = await h.addUser({ email: 'old@example.com' });
    await invite(owner.client, owner.spaceId, 'old@example.com');
    expect((await h.client().post('/api/invitations/inspect', { token: mailedToken(h, 'old@example.com') })).body.account).toBe('exists');
    expect((await existing.client.post('/api/invitations/inspect', { token: mailedToken(h, 'old@example.com') })).body.signedIn).toEqual({
      email: 'old@example.com',
      matches: true,
      memberRole: null,
    });

    const quiet = await mailless();
    const someone = await quiet.h.addUser({ email: 'someone@example.com' });
    const link = (await invite(quiet.owner.client, quiet.owner.spaceId, 'someone@example.com')).body.link!;
    const token = tokenOfLink(link);
    expect((await quiet.h.client().post('/api/invitations/inspect', { token })).body).toMatchObject({ account: 'unknown', signedIn: null });
    expect((await quiet.owner.client.post('/api/invitations/inspect', { token })).body).toMatchObject({
      account: 'unknown',
      signedIn: { email: OWNER_EMAIL, matches: false, memberRole: null },
    });
    expect((await someone.client.post('/api/invitations/inspect', { token })).body).toMatchObject({ account: 'exists', signedIn: { matches: true } });
  });

  it('tells the invited account its role in the space when it is a member already, and nobody else', async () => {
    const { h, owner } = await instance();
    const invited = await h.addUser({ email: 'member@example.com' });
    expect((await invite(owner.client, owner.spaceId, 'member@example.com', 'admin')).status).toBe(201);
    const token = mailedToken(h, 'member@example.com');
    expect((await invited.client.post('/api/invitations/inspect', { token })).body.signedIn).toEqual({
      email: 'member@example.com',
      matches: true,
      memberRole: null,
    });
    // It joined meanwhile (another invitation, accepted): accepting this one would raise its role.
    addMembership(h.db, { spaceId: owner.spaceId, userId: invited.user.id, role: 'viewer', nowMs: h.clock.now() });
    expect((await invited.client.post('/api/invitations/inspect', { token })).body.signedIn).toEqual({
      email: 'member@example.com',
      matches: true,
      memberRole: 'viewer',
    });
    expect((await owner.client.post('/api/invitations/inspect', { token })).body.signedIn).toEqual({
      email: OWNER_EMAIL,
      matches: false,
      memberRole: null,
    });
    expect((await h.client().post('/api/invitations/inspect', { token })).body.signedIn).toBeNull();
  });

  it('unknown, revoked, accepted, expired, a deleted space or an inviter without the right: one answer, invalid_token', async () => {
    const { h, owner } = await instance();
    const admin = await h.addUser({ email: 'admin@example.com', spaceId: owner.spaceId, role: 'admin' });
    verify(h, admin.user.id);
    await invite(admin.client, owner.spaceId, 'a@example.com');
    const token = mailedToken(h, 'a@example.com');
    const inspect = () => h.client().post('/api/invitations/inspect', { token });
    expect((await inspect()).status).toBe(200);
    // The admin is made a member without the lifecycle (a direct change): acceptance asks again.
    h.db.run("UPDATE memberships SET role = 'member' WHERE user_id = :id", { id: admin.user.id });
    expect((await inspect()).body).toEqual({ error: { code: 'invalid_token', message: 'This link is invalid or has expired.' } });
    h.db.run("UPDATE memberships SET role = 'admin' WHERE user_id = :id", { id: admin.user.id });
    h.db.run("UPDATE users SET status = 'disabled' WHERE id = :id", { id: admin.user.id });
    expect((await inspect()).body.error.code).toBe('invalid_token');
    h.db.run("UPDATE users SET status = 'active' WHERE id = :id", { id: admin.user.id });
    h.db.run("UPDATE spaces SET status = 'importing'");
    expect((await inspect()).body.error.code).toBe('invalid_token');
    h.db.run("UPDATE spaces SET status = 'active'");
    h.clock.advance(7 * DAY_MS);
    expect((await inspect()).body.error.code).toBe('invalid_token');
    expect((await h.client().post('/api/invitations/inspect', { token: 'z'.repeat(43) })).body.error.code).toBe('invalid_token');
    expect((await h.client().post('/api/invitations/inspect', { token: 'short' })).body.error.code).toBe('validation_error');
  });
});

describe('accepting', () => {
  it('as a new account (mailed): verified, a member with the role, its own space too; the grant is the inviter’s event', async () => {
    const { h, owner } = await instance();
    await invite(owner.client, owner.spaceId, 'Alice@Example.com', 'viewer');
    const token = mailedToken(h, 'Alice@example.com');
    const browser = h.client({ ip: '198.51.100.140' });
    expect((await browser.post('/api/invitations/accept', { token })).body.error).toMatchObject({
      code: 'validation_error',
      details: [
        { path: 'displayName', message: 'Required' },
        { path: 'password', message: 'Required' },
      ],
    });
    const res = await browser.post('/api/invitations/accept', { token, displayName: 'Alice', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ user: { email: 'Alice@example.com', emailVerified: true, displayName: 'Alice' }, spaceId: owner.spaceId });
    const status = await browser.get<AuthStatusDTO>('/api/auth/status');
    expect(status.body.spaces.map((s) => [s.name, s.role]).sort()).toEqual([
      ["Alice's space", 'owner'],
      ["Owner's space", 'viewer'],
    ]);
    const aliceId = res.body.user.id as number;
    expect(h.db.get<{ auth_method: string }>('SELECT auth_method FROM sessions WHERE user_id = :id', { id: aliceId })!.auth_method).toBe('invite');
    // Signed in by the acceptance, as a sign-in records it (Administration → Users' "Last sign-in").
    const signedIn = h.db.get<{ last_login_at: string | null; created_at: string }>(
      'SELECT u.last_login_at, s.created_at FROM users u JOIN sessions s ON s.user_id = u.id WHERE u.id = :id',
      { id: aliceId },
    )!;
    expect(signedIn.last_login_at).toBe(signedIn.created_at);
    expect(h.db.get('SELECT accepted_by FROM invitations')).toEqual({ accepted_by: aliceId });
    const events = h.db.all<{ type: string; user_id: number; data: string }>(
      "SELECT type, user_id, data FROM security_events WHERE type IN ('member_added', 'invitation_accepted', 'account_created') ORDER BY id",
    );
    expect(events.map((e) => [e.type, e.user_id])).toEqual([
      ['account_created', owner.user.id],
      ['invitation_accepted', aliceId],
      ['member_added', owner.user.id],
      ['account_created', aliceId],
    ]);
    expect(JSON.parse(events[2]!.data)).toEqual({ space: owner.spaceId, userId: aliceId, role: 'viewer', invitationId: 1 });
    await h.settle();
    expect(h.spaces.ids('invalidate')).toContain(owner.spaceId);
    // Once only.
    expect((await h.client().post('/api/invitations/accept', { token, displayName: 'Again', password: PASSWORD })).body.error.code).toBe('invalid_token');
  });

  it('as a new account (copied link): unverified; an address with an account is told to sign in (409)', async () => {
    const { h, owner } = await mailless();
    const link = (await invite(owner.client, owner.spaceId, 'bob@example.com')).body.link!;
    const res = await h.client().post('/api/invitations/accept', { token: tokenOfLink(link), displayName: 'Bob', password: PASSWORD });
    expect(res.body.user).toMatchObject({ emailVerified: false });
    await h.addUser({ email: 'carol@example.com' });
    const carol = (await invite(owner.client, owner.spaceId, 'carol@example.com')).body.link!;
    expect(await h.client().post('/api/invitations/accept', { token: tokenOfLink(carol), displayName: 'Carol', password: PASSWORD })).toMatchObject({
      status: 409,
      body: { error: { code: 'conflict', message: 'An account with this email exists. Sign in to accept.' } },
    });
  });

  it('signed in: the invited account joins (verified with mail); another account and an unverified one are refused', async () => {
    const { h, owner } = await instance();
    const bob = await h.addUser({ email: 'bob@example.com' });
    const carol = await h.addUser({ email: 'carol@example.com' });
    await invite(owner.client, owner.spaceId, 'bob@example.com');
    const token = mailedToken(h, 'bob@example.com');
    expect(await carol.client.post('/api/invitations/accept', { token })).toMatchObject({
      status: 403,
      body: { error: { message: 'This invitation was sent to bob@example.com. Sign in with that account to accept it.' } },
    });
    expect(await bob.client.post('/api/invitations/accept', { token })).toMatchObject({
      status: 403,
      body: { error: { message: 'Verify your email address first' } },
    });
    verify(h, bob.user.id);
    expect(await bob.client.post('/api/invitations/accept', { token })).toMatchObject({ status: 200, body: { ok: true, spaceId: owner.spaceId } });
    expect((await bob.client.get<AuthStatusDTO>('/api/auth/status')).body.spaces.map((s) => s.id)).toEqual([owner.spaceId]);
    expect((await bob.client.post('/api/invitations/accept', { token })).body.error.code).toBe('invalid_token');
  });

  it('a member already keeps the higher of the two roles; an instance invitation needs no account (409)', async () => {
    const { h, owner } = await instance();
    const viewer = await h.addUser({ email: 'viewer@example.com', spaceId: owner.spaceId, role: 'viewer' });
    const admin = await h.addUser({ email: 'admin@example.com', spaceId: owner.spaceId, role: 'admin' });
    verify(h, viewer.user.id);
    verify(h, admin.user.id);
    // Rows of a member's invitation, as if sent before they joined.
    for (const [email, role] of [
      ['viewer@example.com', 'member'],
      ['admin@example.com', 'viewer'],
    ]) {
      h.db.run('DELETE FROM memberships WHERE user_id = (SELECT id FROM users WHERE email = :email)', { email });
      await invite(owner.client, owner.spaceId, email!, role);
      h.db.run(
        `INSERT INTO memberships (space_id, user_id, role, created_at, updated_at)
         SELECT 1, id, :role, :now, :now FROM users WHERE email = :email`,
        { email, role: email === 'viewer@example.com' ? 'viewer' : 'admin', now: new Date(h.clock.now()).toISOString() },
      );
    }
    expect((await viewer.client.post('/api/invitations/accept', { token: mailedToken(h, 'viewer@example.com') })).status).toBe(200);
    expect((await admin.client.post('/api/invitations/accept', { token: mailedToken(h, 'admin@example.com') })).status).toBe(200);
    const roles = h.db.all<{ email: string; role: string }>('SELECT u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id ORDER BY u.id');
    expect(roles).toEqual([
      { email: OWNER_EMAIL, role: 'owner' },
      { email: 'viewer@example.com', role: 'member' },
      { email: 'admin@example.com', role: 'admin' },
    ]);
    expect(h.db.all("SELECT type FROM security_events WHERE type = 'member_role_changed'")).toHaveLength(1);

    const created = await createInvitation(h.ctx, {
      inviter: findUser(h.db, owner.user.id)!,
      space: null,
      email: { address: 'later@example.com', key: 'later@example.com' },
      role: null,
      meta: testMeta(),
    });
    expect(created.invitation).toMatchObject({ role: null, delivery: 'mail' });
    const later = await h.addUser({ email: 'later2@example.com' });
    h.db.run("UPDATE users SET email = 'later@example.com', email_key = 'later@example.com', email_verified_at = :now WHERE id = :id", {
      id: later.user.id,
      now: new Date(h.clock.now()).toISOString(),
    });
    expect(await later.client.post('/api/invitations/accept', { token: mailedToken(h, 'later@example.com') })).toMatchObject({
      status: 409,
      body: { error: { message: 'You already have an account.' } },
    });
  });

  it('the member quota is asked again at acceptance', async () => {
    const { h, owner } = await instance({ vars: { ...PUBLIC, MAX_MEMBERS_PER_SPACE: '3' } });
    await invite(owner.client, owner.spaceId, 'a@example.com');
    await invite(owner.client, owner.spaceId, 'b@example.com');
    await h.addUser({ email: 'c@example.com', spaceId: owner.spaceId, role: 'member' });
    expect(await h.client().post('/api/invitations/accept', { token: mailedToken(h, 'a@example.com'), displayName: 'A', password: PASSWORD })).toMatchObject({
      status: 409,
      body: { error: { code: 'quota_exceeded', message: 'This space has reached its limit of 3 members' } },
    });
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = 'a@example.com'")!.n).toBe(0);
  });
});

describe('the account’s own pending invitations', () => {
  it('listed for a verified address on an instance with mail, accepted or declined by id; nobody else’s', async () => {
    const { h, owner } = await instance();
    const bob = await h.addUser({ email: 'bob@example.com' });
    const carol = await h.addUser({ email: 'carol@example.com' });
    const first = (await invite(owner.client, owner.spaceId, 'bob@example.com')).body.invitation.id;
    expect((await bob.client.get('/api/invitations')).body).toEqual([]);
    verify(h, bob.user.id);
    verify(h, carol.user.id);
    expect((await bob.client.get<PendingInvitationDTO[]>('/api/invitations')).body).toEqual([
      { id: first, spaceName: "Owner's space", inviterName: 'Owner', role: 'member', expiresAt: new Date(h.clock.now() + 7 * DAY_MS).toISOString() },
    ]);
    expect((await carol.client.post(`/api/invitations/${first}/accept`)).status).toBe(404);
    expect((await carol.client.post(`/api/invitations/${first}/decline`)).status).toBe(404);
    expect(await bob.client.post(`/api/invitations/${first}/decline`)).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.db.get('SELECT revoked_by FROM invitations WHERE id = :id', { id: first })).toEqual({ revoked_by: bob.user.id });
    expect((await bob.client.get('/api/invitations')).body).toEqual([]);
    const other = await owner.client.post<InvitationCreatedDTO>(`/api/spaces/${owner.spaceId}/invitations`, { email: 'carol@example.com', role: 'viewer' });
    expect(await carol.client.post(`/api/invitations/${other.body.invitation.id}/accept`)).toMatchObject({ status: 200, body: { ok: true, spaceId: owner.spaceId } });
    expect((await carol.client.get('/api/invitations')).body).toEqual([]);
  });

  it('none on an instance without mail', async () => {
    const { h, owner } = await mailless();
    const bob = await h.addUser({ email: 'bob@example.com' });
    const id = (await invite(owner.client, owner.spaceId, 'bob@example.com')).body.invitation.id;
    verify(h, bob.user.id);
    expect((await bob.client.get('/api/invitations')).body).toEqual([]);
    expect((await bob.client.post(`/api/invitations/${id}/accept`)).status).toBe(404);
  });
});

describe('lifecycle revocations (§5.8.8)', () => {
  const open = (h: Harness) => h.db.all<{ email: string }>('SELECT email FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY id').map((r) => r.email);

  it('an inviter that loses the role (demoted, removed, leaving) loses the invitations it may no longer send', async () => {
    const { h, owner } = await instance();
    const co = await h.addUser({ email: 'co@example.com', spaceId: owner.spaceId, role: 'owner' });
    const admin = await h.addUser({ email: 'admin@example.com', spaceId: owner.spaceId, role: 'admin' });
    verify(h, co.user.id);
    verify(h, admin.user.id);
    await invite(co.client, owner.spaceId, 'co-admin@example.com', 'admin');
    await invite(co.client, owner.spaceId, 'co-member@example.com', 'member');
    await invite(admin.client, owner.spaceId, 'admin-member@example.com', 'member');
    // The co-owner becomes an admin: its admin invitation goes.
    await owner.client.patch(`/api/spaces/${owner.spaceId}/members/${co.user.id}`, { role: 'admin' });
    expect(open(h)).toEqual(['co-member@example.com', 'admin-member@example.com']);
    await owner.client.patch(`/api/spaces/${owner.spaceId}/members/${admin.user.id}`, { role: 'member' });
    expect(open(h)).toEqual(['co-member@example.com']);
    await co.client.post(`/api/spaces/${owner.spaceId}/leave`);
    expect(open(h)).toEqual([]);
    expect(h.db.all('SELECT DISTINCT revoked_by FROM invitations')).toEqual([{ revoked_by: null }]);
  });

  it('a disabled or deleted inviter, an inviter no longer an instance admin, and a deleted space', async () => {
    const { h, owner } = await instance();
    const admin = await h.addUser({ email: 'admin@example.com', spaceId: owner.spaceId, role: 'admin', isInstanceAdmin: true });
    verify(h, admin.user.id);
    await invite(admin.client, owner.spaceId, 'one@example.com');
    await createInvitation(h.ctx, {
      inviter: findUser(h.db, admin.user.id)!,
      space: null,
      email: { address: 'two@example.com', key: 'two@example.com' },
      role: null,
      meta: testMeta(),
    });
    expect(revokeInvitationsSentBy(h.db, admin.user.id, h.clock.now(), { instanceOnly: true })).toBe(1);
    expect(open(h)).toEqual(['one@example.com']);
    expect(revokeInvitationsSentBy(h.db, admin.user.id, h.clock.now())).toBe(1);
    expect(open(h)).toEqual([]);

    const deleted = await h.addUser({ email: 'gone@example.com', spaceId: owner.spaceId, role: 'admin' });
    verify(h, deleted.user.id);
    await invite(deleted.client, owner.spaceId, 'three@example.com');
    expect(open(h)).toEqual(['three@example.com']);
    await deleted.client.delete('/api/account', { confirm: 'gone@example.com' });
    expect(open(h)).toEqual([]);

    // A deletion that is refused (the only owner of a shared space) revokes nothing.
    const sole = await h.addUser({ email: 'sole@example.com' });
    verify(h, sole.user.id);
    const soleSpace = (await sole.client.post('/api/spaces', { name: 'Sole' })).body.id as string;
    await h.addUser({ email: 'guest@example.com', spaceId: soleSpace, role: 'viewer' });
    await invite(sole.client, soleSpace, 'five@example.com');
    expect((await sole.client.delete('/api/account', { confirm: 'sole@example.com' })).body.error.code).toBe('last_owner');
    expect(open(h)).toEqual(['five@example.com']);
    h.db.run("UPDATE invitations SET revoked_at = :now WHERE email = 'five@example.com'", { now: new Date(h.clock.now()).toISOString() });

    await invite(owner.client, owner.spaceId, 'four@example.com');
    const token = mailedToken(h, 'four@example.com');
    expect((await owner.client.delete(`/api/spaces/${owner.spaceId}`, { confirmName: "Owner's space" })).status).toBe(200);
    expect(open(h)).toEqual([]);
    await owner.client.post(`/api/spaces/${owner.spaceId}/restore`);
    expect((await h.client().post('/api/invitations/inspect', { token })).body.error.code).toBe('invalid_token');
  });
});

describe('through the Node stack', () => {
  it('the new member reads the space with the invited role at once, and its mirror holds the account', async () => {
    const ctx = createTestContext();
    const { client, spaceId } = await ctx.signedIn();
    ctx.directoryDb.run('UPDATE users SET email_verified_at = :now', { now: new Date().toISOString() });
    await client.post('/api/projects', { name: 'Plans', key: 'PLN' });
    const created = await client.post<InvitationCreatedDTO>(`/api/spaces/${spaceId}/invitations`, { email: 'new@example.com', role: 'viewer' });
    expect(created.status).toBe(201);
    const token = linkToken(ctx.outbox.find((m) => m.template === 'invitation'));
    const browser = ctx.client();
    const accepted = await browser.post('/api/invitations/accept', { token, displayName: 'Newcomer', password: PASSWORD });
    expect(accepted.status).toBe(201);
    const boot = await browser.get(`/api/s/${spaceId}/bootstrap`);
    expect(boot.status).toBe(200);
    expect(boot.body.space).toMatchObject({ id: spaceId, role: 'viewer' });
    expect(boot.body.projects.map((p: { key: string }) => p.key)).toEqual(['PLN']);
    expect(boot.body.people.map((p: { displayName: string }) => p.displayName)).toEqual(['Newcomer', 'Owner']);
    expect((await browser.post(`/api/s/${spaceId}/projects`, { name: 'No', key: 'NOPE' })).status).toBe(403);
  });
});

describe('instance invitations (the service the admin routes use)', () => {
  it('an account without a space: refused for an address with an account; accepted as a new account under any policy', async () => {
    const { h, owner } = await instance();
    const admin = findUser(h.db, owner.user.id)!;
    await expect(
      createInvitation(h.ctx, { inviter: admin, space: null, email: { address: OWNER_EMAIL, key: OWNER_EMAIL }, role: null, meta: testMeta() }),
    ).rejects.toMatchObject({ status: 409, message: 'owner@example.com already has an account' });
    h.db.run("UPDATE instance_settings SET value = '\"closed\"' WHERE key = 'signupPolicy'");
    const created = await createInvitation(h.ctx, { inviter: admin, space: null, email: { address: 'new@example.com', key: 'new@example.com' }, role: null, meta: testMeta() });
    expect(created).toMatchObject({ link: null, invitation: { email: 'new@example.com', role: null } });
    expect(h.outbox.at(-1)!.subject).toBe("You're invited to Lyren Plan");
    const token = mailedToken(h, 'new@example.com');
    expect((await h.client().post('/api/invitations/inspect', { token })).body).toMatchObject({ kind: 'instance', spaceName: null, role: null, account: 'new' });
    const res = await h.client().post('/api/invitations/accept', { token, displayName: 'New', password: PASSWORD });
    expect(res).toMatchObject({ status: 201, body: { spaceId: null, user: { email: 'new@example.com', emailVerified: true } } });
    expect(h.db.all('SELECT space_id FROM memberships WHERE user_id = :id', { id: res.body.user.id })).toHaveLength(1);
  });
});
