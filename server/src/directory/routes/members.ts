// /api/spaces/:spaceId/{members,leave,transfer} (design §6.3, §7.2): the member list, role changes,
// removing members, leaving and transferring ownership. Who may do what: shared/src/roles.ts and
// directory/members.ts. Removals and demotions wait for the space to forget cached identities (§3.5).
// Each write reads the session and the actor's role after its body (freshSession) and makes its change
// without another await (§5): a role read before a slow body may have been taken away meanwhile.

import { Hono, type Context } from 'hono';
import { canChangeRole, roleChangeNeedsReauth } from '@shared/roles';
import { memberRoleInput, transferInput } from '@shared/schemas';
import type { MemberDTO } from '@shared/types';
import { forbidden } from '../../http/errors';
import { readId, readJson } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import type { DirectoryContext } from '../context';
import { currentMeta, currentUser, freshSession, requireRecent } from '../middleware';
import { changeRole, getMember, leaveSpace, listMembers, removeMember, transferOwnership } from '../members';
import { pushInvalidate, requireMemberSpace } from '../spaces';

type C = Context<DirectoryEnv>;

export function memberRoutes(ctx: DirectoryContext) {
  const { db } = ctx;
  const r = new Hono<DirectoryEnv>();

  /** The actor's membership of the route's space (404 for non-members). */
  const memberSpace = (c: C, userId: number) => requireMemberSpace(db, c.req.param('spaceId') ?? '', userId);

  r.get('/:spaceId/members', (c) => {
    const user = currentUser(c);
    const space = memberSpace(c, user.id);
    return c.json<MemberDTO[]>(listMembers(db, space.id, user.id));
  });

  r.patch('/:spaceId/members/:userId', async (c) => {
    const targetId = readId(c, 'userId');
    const { role } = await readJson(c, memberRoleInput);
    const { user } = freshSession(c, ctx);
    const space = memberSpace(c, user.id);
    const current = getMember(db, space.id, targetId, user.id).role;
    // Permission first, so a change that is refused anyway does not ask for a password.
    if (canChangeRole(space.role, current, role, targetId === user.id) && roleChangeNeedsReauth(current, role)) {
      requireRecent(c, ctx);
    }
    const { member, demoted } = changeRole(db, { space, actorId: user.id, targetId, role, meta: currentMeta(c), nowMs: ctx.now() });
    await pushInvalidate(ctx, [space.public_id], demoted ? 'await' : 'defer');
    return c.json<MemberDTO>(member);
  });

  r.delete('/:spaceId/members/:userId', async (c) => {
    const { user } = freshSession(c, ctx);
    const space = memberSpace(c, user.id);
    const targetId = readId(c, 'userId');
    removeMember(db, { space, actorId: user.id, targetId, nowMs: ctx.now() });
    await pushInvalidate(ctx, [space.public_id], 'await');
    return c.json({ ok: true });
  });

  r.post('/:spaceId/leave', async (c) => {
    const { user } = freshSession(c, ctx);
    const space = memberSpace(c, user.id);
    leaveSpace(db, { space, userId: user.id, nowMs: ctx.now() });
    await pushInvalidate(ctx, [space.public_id], 'await');
    return c.json({ ok: true });
  });

  r.post('/:spaceId/transfer', async (c) => {
    const input = await readJson(c, transferInput);
    const { user } = freshSession(c, ctx);
    const space = memberSpace(c, user.id);
    if (space.role !== 'owner') throw forbidden('Only an owner can transfer ownership');
    if (input.userId !== user.id) getMember(db, space.id, input.userId, user.id); // 404 for a non-member
    requireRecent(c, ctx);
    const { demoted } = transferOwnership(db, {
      space,
      actorId: user.id,
      targetId: input.userId,
      demoteSelfTo: input.demoteSelfTo,
      meta: currentMeta(c),
      nowMs: ctx.now(),
    });
    await pushInvalidate(ctx, [space.public_id], demoted ? 'await' : 'defer');
    return c.json({ ok: true });
  });

  return r;
}
