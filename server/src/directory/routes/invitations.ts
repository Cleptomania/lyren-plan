// Invitations (design §5.8.8, §7.2), mounted at /api:
// - a space's: GET/POST /spaces/:spaceId/invitations, POST …/:invitationId/resend, DELETE …/:invitationId
//   (admins and owners; an admin invitation is an owner's, and creating or resending one needs the re-auth
//   window, since its link grants admin rights);
// - the invitation page's: POST /invitations/inspect and POST /invitations/accept, which work signed out
//   (a new account) and signed in (the account joins), and POST /invitations/accept/passkey/options and
//   /invitations/accept/passkey, a new account with a passkey instead of a password;
// - the account's own: GET /invitations, POST /invitations/:invitationId/accept and …/decline, on instances
//   with mail and for a verified address only (otherwise there are none).
// The rules are directory/invitations.ts's. Instance invitations are the admin routes'. Each write reads
// the session and the actor's role after its body (freshSession) and acts on them before another await.

import { Hono, type Context } from 'hono';
import { atLeast, canInviteRole, inviteNeedsReauth } from '@shared/roles';
import { invitationAcceptInput, invitationCreateInput, invitationPasskeyAcceptInput, invitationPasskeyOptionsInput, tokenInput } from '@shared/schemas';
import type {
  CeremonyDTO,
  InvitationAcceptedDTO,
  InvitationCreatedDTO,
  InvitationDTO,
  InvitationPreviewDTO,
  PendingInvitationDTO,
} from '@shared/types';
import { randomToken } from '../../core/crypto';
import type { TrustedMeta } from '../../core/ports';
import { badRequest, conflict, forbidden, HttpError, notFound, passkeyError } from '../../http/errors';
import { findByCredentialId } from '../../passkeys/credentials';
import { readBody, readId, readJson } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import type { DirectoryContext } from '../context';
import { readDeviceToken } from '../devices';
import {
  assertMemberRoom,
  consumeInvitation,
  createInvitation,
  findAcceptable,
  findOpenInvitation,
  findPendingFor,
  listInvitations,
  listPendingInvitations,
  previewInvitation,
  resendInvitation,
  revokeInvitation,
  type AcceptableInvitation,
} from '../invitations';
import { currentMeta, currentUser, freshSession, requireRecent } from '../middleware';
import { beginRegistration, finishRegistration, PASSKEY_REGISTERED_ALREADY, requireRelyingParty } from '../passkeys';
import { getInstanceSettings } from '../settings';
import { pushInvalidate, requireMemberSpace, type MemberSpace } from '../spaces';
import { createAccount, findUserByEmailKey, toUserDTO, type UserRow } from '../users';
import { assertLinkAttempts, checkPasswordLength, invalidLink, signIn } from './auth';

type C = Context<DirectoryEnv>;

export const INVITED_ACCOUNT_EXISTS = 'An account with this email exists. Sign in to accept.';

export function invitationRoutes(ctx: DirectoryContext) {
  const { db, config, mailer } = ctx;
  const r = new Hono<DirectoryEnv>();

  /** The route's space, when the actor may manage its invitations (admin or owner); 404 for non-members. */
  const managedSpace = (c: C, userId: number): MemberSpace => {
    const space = requireMemberSpace(db, c.req.param('spaceId') ?? '', userId);
    if (!atLeast(space.role, 'admin')) throw forbidden('Only admins and owners can manage invitations');
    return space;
  };

  /** The route's open invitation, when the actor may act on it (an admin invitation: owners only). */
  const managedInvitation = (c: C, space: MemberSpace) => {
    const invitation = findOpenInvitation(db, space.id, readId(c, 'invitationId'));
    if (!invitation) throw notFound('Invitation');
    if (invitation.role === null || !canInviteRole(space.role, invitation.role)) throw forbidden('Only owners can manage invitations of admins');
    return invitation;
  };

  r.get('/spaces/:spaceId/invitations', (c) => {
    const space = managedSpace(c, currentUser(c).id);
    return c.json<InvitationDTO[]>(listInvitations(db, space.id, ctx.now()));
  });

  r.post('/spaces/:spaceId/invitations', async (c) => {
    const input = await readJson(c, invitationCreateInput);
    const { user } = freshSession(c, ctx);
    const space = managedSpace(c, user.id);
    // Permission first, so an invitation that is refused anyway does not ask for a password.
    if (!canInviteRole(space.role, input.role)) throw forbidden('Only owners can invite admins');
    if (inviteNeedsReauth(input.role)) requireRecent(c, ctx);
    const created = await createInvitation(ctx, { inviter: user, space, email: input.email, role: input.role, meta: currentMeta(c) });
    return c.json<InvitationCreatedDTO>(created, 201);
  });

  r.post('/spaces/:spaceId/invitations/:invitationId/resend', async (c) => {
    // No input, but the body is read before acting (Appendix D 21).
    await readBody(c);
    const { user } = freshSession(c, ctx);
    const space = managedSpace(c, user.id);
    const invitation = managedInvitation(c, space);
    // A new link of an admin invitation grants admin rights as the first one did (§5.4.4).
    if (invitation.role !== null && inviteNeedsReauth(invitation.role)) requireRecent(c, ctx);
    return c.json<InvitationCreatedDTO>(await resendInvitation(ctx, { inviter: user, invitation, space, meta: currentMeta(c) }));
  });

  r.delete('/spaces/:spaceId/invitations/:invitationId', (c) => {
    const { user } = freshSession(c, ctx);
    const space = managedSpace(c, user.id);
    const invitation = managedInvitation(c, space);
    revokeInvitation(db, { invitationId: invitation.id, byUserId: user.id, nowMs: ctx.now() });
    return c.json({ ok: true });
  });

  r.post('/invitations/inspect', async (c) => {
    const { token } = await readJson(c, tokenInput);
    assertLinkAttempts(ctx, c);
    const found = findAcceptable(db, token, ctx.now());
    if (!found) throw invalidLink(ctx, c);
    return c.json<InvitationPreviewDTO>(previewInvitation(db, found, c.get('user')));
  });

  /**
   * The signed-in account joins the invitation's space (§5.8.8 "Accept with an existing account"); the
   * caller has matched the invited address. Returns the space's public id.
   */
  async function join(found: AcceptableInvitation, user: UserRow, meta: TrustedMeta): Promise<string> {
    if (mailer.deliversMail && user.email_verified_at === null) throw forbidden('Verify your email address first');
    if (found.invitation.space_id === null) throw conflict('You already have an account.');
    assertMemberRoom(ctx, found, user.id);
    const spaceId = consumeInvitation(db, found, { userId: user.id, meta, nowMs: ctx.now() })!;
    await pushInvalidate(ctx, [spaceId], 'defer');
    return spaceId;
  }

  /** §5.8.8 "Accept as a new account", checks 3-5: the policy, the address still free, room in the space. */
  function assertMayCreateAccount(found: AcceptableInvitation): void {
    // §5.3: under closed only an instance admin's invitation creates an account (an instance invitation is one).
    if (getInstanceSettings(db, config).signupPolicy === 'closed' && found.inviter.is_instance_admin !== 1) {
      throw new HttpError(403, 'signup_disabled', 'Sign-up is closed.');
    }
    if (findUserByEmailKey(db, found.invitation.email_key)) throw conflict(INVITED_ACCOUNT_EXISTS);
    assertMemberRoom(ctx, found, null);
  }

  r.post('/invitations/accept', async (c) => {
    const input = await readJson(c, invitationAcceptInput);
    const meta = currentMeta(c);
    assertLinkAttempts(ctx, c);

    if (c.get('session')) {
      const { user } = freshSession(c, ctx);
      const found = findAcceptable(db, input.token, ctx.now());
      if (!found) throw invalidLink(ctx, c);
      if (user.email_key !== found.invitation.email_key) {
        throw forbidden(`This invitation was sent to ${found.invitation.email}. Sign in with that account to accept it.`);
      }
      return c.json<InvitationAcceptedDTO>({ ok: true, spaceId: await join(found, user, meta) });
    }

    const missing = (['displayName', 'password'] as const).filter((field) => input[field] === undefined);
    if (missing.length > 0) throw badRequest(`${missing[0]}: Required`, missing.map((path) => ({ path, message: 'Required' })));
    const { displayName, password } = input as { displayName: string; password: string };
    // Cheapest checks first: no hash for a request that cannot succeed.
    const found = findAcceptable(db, input.token, ctx.now());
    if (!found) throw invalidLink(ctx, c);
    assertMayCreateAccount(found);
    checkPasswordLength(ctx, password, 'password');
    const passwordHash = await ctx.passwords.hash(password);
    // Other requests ran during the hash: every check again, then the account and the membership at once.
    const again = findAcceptable(db, input.token, ctx.now());
    if (!again) throw invalidLink(ctx, c);
    assertMayCreateAccount(again);
    let spaceId: string | null = null;
    const created = await createAccount(ctx, {
      email: { address: again.invitation.email, key: again.invitation.email_key },
      // The holder of a mailed invitation has proved the address (§5.1).
      emailVerified: again.invitation.delivery === 'mail',
      displayName,
      passwordHash,
      isInstanceAdmin: false,
      authMethod: 'invite',
      sampleData: null,
      meta,
      deviceToken: readDeviceToken(c.req.header('cookie'), meta.secure),
      takenMessage: INVITED_ACCOUNT_EXISTS,
      within: (user, nowMs) => {
        spaceId = consumeInvitation(db, again, { userId: user.id, meta, nowMs });
      },
    });
    signIn(c, ctx, created.session.token, created.session.row, created.deviceToken);
    if (spaceId !== null) await pushInvalidate(ctx, [spaceId], 'defer');
    return c.json<InvitationAcceptedDTO>({ user: toUserDTO(db, created.user), spaceId }, 201);
  });

  r.post('/invitations/accept/passkey/options', async (c) => {
    const input = await readJson(c, invitationPasskeyOptionsInput);
    const rp = requireRelyingParty(ctx);
    assertLinkAttempts(ctx, c);
    const found = findAcceptable(db, input.token, ctx.now());
    if (!found) throw invalidLink(ctx, c);
    assertMayCreateAccount(found);
    // The new account's WebAuthn user handle, made now: the passkey is registered with it.
    const handle = randomToken(32);
    const ceremony = await beginRegistration(ctx, c, rp, {
      binding: { purpose: 'invite', invitationId: found.invitation.id },
      user: { handle, name: found.invitation.email, displayName: input.displayName },
      exclude: [],
      pendingUserHandle: handle,
    });
    return c.json<CeremonyDTO>(ceremony);
  });

  r.post('/invitations/accept/passkey', async (c) => {
    const input = await readJson(c, invitationPasskeyAcceptInput);
    const meta = currentMeta(c);
    const rp = requireRelyingParty(ctx);
    assertLinkAttempts(ctx, c);
    // Cheapest checks first: no verification for a request that cannot succeed.
    const found = findAcceptable(db, input.token, ctx.now());
    if (!found) throw invalidLink(ctx, c);
    assertMayCreateAccount(found);
    const { credential, ceremony } = await finishRegistration(ctx, rp, {
      ceremonyId: input.ceremonyId,
      binding: { purpose: 'invite', invitationId: found.invitation.id },
      response: input.response,
    });
    // Other requests ran during the verification: every check again, then the account and the membership at once.
    const again = findAcceptable(db, input.token, ctx.now());
    if (!again) throw invalidLink(ctx, c);
    assertMayCreateAccount(again);
    if (findByCredentialId(db, credential.credentialId)) throw passkeyError(PASSKEY_REGISTERED_ALREADY);
    let spaceId: string | null = null;
    const created = await createAccount(ctx, {
      email: { address: again.invitation.email, key: again.invitation.email_key },
      // The holder of a mailed invitation has proved the address (§5.1).
      emailVerified: again.invitation.delivery === 'mail',
      displayName: input.displayName,
      passwordHash: null,
      passkey: { credential, rpId: rp.rpId, name: input.passkeyName ?? 'Passkey 1' },
      userHandle: ceremony.pending_user_handle!,
      isInstanceAdmin: false,
      authMethod: 'invite',
      sampleData: null,
      meta,
      deviceToken: readDeviceToken(c.req.header('cookie'), meta.secure),
      takenMessage: INVITED_ACCOUNT_EXISTS,
      within: (user, nowMs) => {
        spaceId = consumeInvitation(db, again, { userId: user.id, meta, nowMs });
      },
    });
    signIn(c, ctx, created.session.token, created.session.row, created.deviceToken);
    if (spaceId !== null) await pushInvalidate(ctx, [spaceId], 'defer');
    return c.json<InvitationAcceptedDTO>({ user: toUserDTO(db, created.user), spaceId }, 201);
  });

  /** The account's own invitations exist only with mail and for its verified address (§5.8.8). */
  const seesPending = (user: UserRow) => mailer.deliversMail && user.email_verified_at !== null;

  r.get('/invitations', (c) => {
    const user = currentUser(c);
    return c.json<PendingInvitationDTO[]>(seesPending(user) ? listPendingInvitations(db, user, ctx.now()) : []);
  });

  r.post('/invitations/:invitationId/accept', async (c) => {
    await readBody(c);
    const meta = currentMeta(c);
    const { user } = freshSession(c, ctx);
    const found = seesPending(user) ? findPendingFor(db, user, readId(c, 'invitationId'), ctx.now()) : null;
    if (!found) throw notFound('Invitation');
    return c.json<InvitationAcceptedDTO>({ ok: true, spaceId: await join(found, user, meta) });
  });

  r.post('/invitations/:invitationId/decline', async (c) => {
    await readBody(c);
    const { user } = freshSession(c, ctx);
    const found = seesPending(user) ? findPendingFor(db, user, readId(c, 'invitationId'), ctx.now()) : null;
    if (!found) throw notFound('Invitation');
    revokeInvitation(db, { invitationId: found.invitation.id, byUserId: user.id, nowMs: ctx.now() });
    return c.json({ ok: true });
  });

  return r;
}
