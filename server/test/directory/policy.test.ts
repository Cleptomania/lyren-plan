// The signup policy (design §5.3): which paths create an account under open, invite_only and closed, every
// cell of the table, plus the rows around it: existing accounts can always accept space invitations, and a
// policy change applies to pending invitations at their acceptance.
//
// | Path                                                   | open | invite_only | closed                              |
// | First-run setup                                        | yes  | yes         | yes                                 |
// | Self-signup with email verification                    | yes  | 403         | 403                                 |
// | Accepting a space invitation from a space owner/admin  | yes  | yes         | only from an instance admin, now     |
// | Accepting an instance invitation                       | yes  | yes         | yes                                 |

import { describe, expect, it } from 'vitest';
import { SIGNUP_POLICIES, type SignupPolicy } from '@shared/constants';
import type { InvitationCreatedDTO } from '@shared/types';
import { createInvitation } from '../../src/directory/invitations';
import { setSignupPolicy } from '../../src/directory/settings';
import { findUser } from '../../src/directory/users';
import { createDirectoryHarness, PASSWORD, testMeta } from '../support/directoryHarness';
import { linkToken } from '../support/mail';

const PUBLIC = { PUBLIC_URL: 'https://plan.example.com' };

/** An instance with mail, the given policy, a verified admin owner, and a verified space admin who is no instance admin. */
async function instance(policy: SignupPolicy) {
  const h = createDirectoryHarness({ vars: PUBLIC, config: { seed: { signupPolicy: policy, passwordMinLength: 8 } } });
  const owner = await h.setup();
  const spaceAdmin = await h.addUser({ email: 'space-admin@example.com', spaceId: owner.spaceId, role: 'admin' });
  h.db.run('UPDATE users SET email_verified_at = :now', { now: new Date(h.clock.now()).toISOString() });
  await h.settle();
  h.outbox.length = 0;
  return { h, owner, spaceAdmin };
}

type Instance = Awaited<ReturnType<typeof instance>>;

const lastToken = (t: Instance) => linkToken(t.h.outbox.filter((m) => m.template === 'invitation').at(-1));

async function acceptNew(t: Instance, token: string, displayName: string) {
  return t.h.client().post('/api/invitations/accept', { token, displayName, password: PASSWORD });
}

describe('§5.3: who can create an account under each policy', () => {
  it.each(SIGNUP_POLICIES)('first-run setup works under %s', async (policy) => {
    const h = createDirectoryHarness({ config: { seed: { signupPolicy: policy, passwordMinLength: 8 } } });
    const { user } = await h.setup();
    expect(user.isInstanceAdmin).toBe(true);
    expect((await h.client().get('/api/auth/status')).body.instance.signupPolicy).toBe(policy);
  });

  it.each([
    ['open', 202],
    ['invite_only', 403],
    ['closed', 403],
  ] as const)('self-signup under %s: %i', async (policy, status) => {
    const t = await instance(policy);
    const res = await t.h.client().post('/api/auth/signup', { email: 'new@example.com' });
    expect(res.status).toBe(status);
    if (status === 403) expect(res.body.error.code).toBe('signup_disabled');
    await t.h.settle();
    if (policy === 'open') {
      const token = linkToken(t.h.outbox.find((m) => m.template === 'signup_verify'));
      expect((await t.h.client().post('/api/auth/signup/complete', { token, displayName: 'New', password: PASSWORD })).status).toBe(201);
    } else {
      expect(t.h.outbox).toEqual([]);
    }
  });

  it.each([
    ['open', 201, 201],
    ['invite_only', 201, 201],
    ['closed', 403, 201],
  ] as const)('a space invitation under %s: from a space admin %i, from an instance admin %i', async (policy, fromSpaceAdmin, fromInstanceAdmin) => {
    const t = await instance(policy);
    await t.spaceAdmin.client.post(`/api/spaces/${t.owner.spaceId}/invitations`, { email: 'a@example.com', role: 'member' });
    const viaSpaceAdmin = await acceptNew(t, lastToken(t), 'A');
    expect(viaSpaceAdmin.status).toBe(fromSpaceAdmin);
    if (fromSpaceAdmin === 403) expect(viaSpaceAdmin.body.error).toEqual({ code: 'signup_disabled', message: 'Sign-up is closed.' });
    await t.owner.client.post(`/api/spaces/${t.owner.spaceId}/invitations`, { email: 'b@example.com', role: 'member' });
    expect((await acceptNew(t, lastToken(t), 'B')).status).toBe(fromInstanceAdmin);
  });

  it.each(SIGNUP_POLICIES)('an instance invitation under %s', async (policy) => {
    const t = await instance(policy);
    await createInvitation(t.h.ctx, {
      inviter: findUser(t.h.db, t.owner.user.id)!,
      space: null,
      email: { address: 'c@example.com', key: 'c@example.com' },
      role: null,
      meta: testMeta(),
    });
    expect(await acceptNew(t, lastToken(t), 'C')).toMatchObject({ status: 201, body: { spaceId: null } });
  });
});

describe('around the table', () => {
  it('existing accounts can always accept space invitations, under closed from any inviter too', async () => {
    const t = await instance('closed');
    const member = await t.h.addUser({ email: 'member@example.com' });
    t.h.db.run('UPDATE users SET email_verified_at = :now WHERE id = :id', { id: member.user.id, now: new Date(t.h.clock.now()).toISOString() });
    await t.spaceAdmin.client.post(`/api/spaces/${t.owner.spaceId}/invitations`, { email: 'member@example.com', role: 'viewer' });
    expect(await member.client.post('/api/invitations/accept', { token: lastToken(t) })).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('a policy change applies to pending invitations when they are accepted, not when they were sent', async () => {
    const t = await instance('invite_only');
    const created = await t.spaceAdmin.client.post<InvitationCreatedDTO>(`/api/spaces/${t.owner.spaceId}/invitations`, { email: 'late@example.com', role: 'member' });
    const token = lastToken(t);
    setSignupPolicy(t.h.db, 'closed', true);
    // Still pending (not revoked), refused while closed, accepted once the policy allows it again.
    expect((await t.h.client().post('/api/invitations/inspect', { token })).status).toBe(200);
    expect((await acceptNew(t, token, 'Late')).status).toBe(403);
    setSignupPolicy(t.h.db, 'invite_only', true);
    expect(await acceptNew(t, token, 'Late')).toMatchObject({ status: 201, body: { spaceId: t.owner.spaceId } });
    expect(created.body.invitation.id).toBe(1);
  });

  it('under closed the inviter must be an instance admin at acceptance: a demoted one’s space invitations create no account', async () => {
    const t = await instance('closed');
    const second = await t.h.addUser({ email: 'second-admin@example.com', spaceId: t.owner.spaceId, role: 'admin', isInstanceAdmin: true });
    t.h.db.run('UPDATE users SET email_verified_at = :now WHERE id = :id', { id: second.user.id, now: new Date(t.h.clock.now()).toISOString() });
    await second.client.post(`/api/spaces/${t.owner.spaceId}/invitations`, { email: 'd@example.com', role: 'member' });
    const token = lastToken(t);
    t.h.db.run('UPDATE users SET is_instance_admin = 0 WHERE id = :id', { id: second.user.id });
    expect((await acceptNew(t, token, 'D')).body.error.code).toBe('signup_disabled');
    t.h.db.run('UPDATE users SET is_instance_admin = 1 WHERE id = :id', { id: second.user.id });
    expect((await acceptNew(t, token, 'D')).status).toBe(201);
  });
});
