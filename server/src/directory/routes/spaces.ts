// /api/spaces: the signed-in user's spaces (design §5.8.16): list, create, the recently deleted ones,
// detail, rename, delete and restore. A space the user is not a member of answers 404 (its existence
// is not revealed). Members are in routes/members.ts. As there, each write reads the session and the
// user's role after its body (freshSession) and changes nothing across another await (§5).

import { Hono, type Context } from 'hono';
import { spaceCreateInput, spaceDeleteInput, spaceUpdateInput } from '@shared/schemas';
import type { DeletedSpaceDTO, SpaceDetailDTO, SpaceSummaryDTO } from '@shared/types';
import { badRequest, conflict, forbidden, notFound, quotaExceeded, unavailable } from '../../http/errors';
import { readJson } from '../../http/validate';
import type { DirectoryEnv } from '../app';
import type { DirectoryContext } from '../context';
import { currentUser, freshSession, requireRecent } from '../middleware';
import {
  createSpace,
  isRestorable,
  listDeletedSpaces,
  listSpaces,
  ownedSpaceCount,
  purgeSpace,
  pushInvalidate,
  renameSpace,
  requireMemberSpace,
  restoreSpace,
  softDeleteSpace,
  spaceSummary,
} from '../spaces';
import { toUserRef } from '../users';

type C = Context<DirectoryEnv>;

export function spaceRoutes(ctx: DirectoryContext) {
  const { db, config } = ctx;
  const r = new Hono<DirectoryEnv>();

  const spaceParam = (c: C) => c.req.param('spaceId') ?? '';

  /** The route's space, read now with the session, when the user owns it: 404 for non-members, else 403. */
  const ownedSpace = (c: C, refusal: string) => {
    const { user } = freshSession(c, ctx);
    const space = requireMemberSpace(db, spaceParam(c), user.id);
    if (space.role !== 'owner') throw forbidden(refusal);
    return { user, space };
  };

  r.get('/', (c) => c.json<SpaceSummaryDTO[]>(listSpaces(db, currentUser(c).id)));

  r.post('/', async (c) => {
    const input = await readJson(c, spaceCreateInput);
    const { user } = freshSession(c, ctx);
    const summary = await createSpace(ctx, {
      owner: { userId: user.id, displayName: user.display_name, email: user.email },
      name: input.name,
      sampleData: input.createSampleData && !input.forImport ? (input.today ? { today: input.today } : {}) : null,
      forImport: input.forImport ?? false,
    });
    return c.json<SpaceSummaryDTO>(summary, 201);
  });

  r.get('/deleted', (c) => c.json<DeletedSpaceDTO[]>(listDeletedSpaces(db, currentUser(c).id, ctx.now())));

  r.get('/:spaceId', (c) => {
    const user = currentUser(c);
    const space = requireMemberSpace(db, spaceParam(c), user.id);
    const owners = db.all<{ id: number; display_name: string }>(
      `SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.space_id = :spaceId AND m.role = 'owner' ORDER BY m.created_at, u.id`,
      { spaceId: space.id },
    );
    const body: SpaceDetailDTO = { ...spaceSummary(db, space.id, user.id), owners: owners.map(toUserRef) };
    return c.json(body);
  });

  r.patch('/:spaceId', async (c) => {
    const input = await readJson(c, spaceUpdateInput);
    const { user, space } = ownedSpace(c, 'Only an owner can rename the space');
    if (input.name !== space.name) {
      renameSpace(db, space.id, input.name, ctx.now());
      await pushInvalidate(ctx, [space.public_id], 'defer');
    }
    return c.json<SpaceSummaryDTO>(spaceSummary(db, space.id, user.id));
  });

  r.delete('/:spaceId', async (c) => {
    const refusal = 'Only an owner can delete the space';
    let { user, space } = ownedSpace(c, refusal);
    // A space created for an import that did not finish goes at once, without confirmation (§8.4). Its body is
    // read first all the same, as every write's (Appendix D 55), and the space again after it (§5).
    if (space.status === 'importing') {
      await c.req.text();
      ({ user, space } = ownedSpace(c, refusal));
    }
    if (space.status === 'importing') {
      await purgeSpace(ctx, space).catch((err) => {
        console.error(`[lyren] Could not purge space ${space.public_id}:`, err);
        throw unavailable('The space could not be deleted. Try again later.');
      });
      return c.json({ ok: true, purgeAfter: new Date(ctx.now()).toISOString() });
    }
    requireRecent(c, ctx);
    const input = await readJson(c, spaceDeleteInput);
    // Checked before the body, so that a refusal asks for no confirmation, and again after it.
    ({ user, space } = ownedSpace(c, refusal));
    requireRecent(c, ctx);
    if (input.confirmName !== space.name) {
      throw badRequest('Type the name of the space to confirm', [{ path: 'confirmName', message: 'Does not match the name of the space' }]);
    }
    const purgeAfter = db.tx(() =>
      softDeleteSpace(db, { spaceId: space.id, byUserId: user.id, graceDays: config.spaceDeleteGraceDays, nowMs: ctx.now() }),
    );
    // Deleting ends everyone's access: the space forgets cached identities before this answers.
    await pushInvalidate(ctx, [space.public_id], 'await');
    if (config.spaceDeleteGraceDays === 0) {
      // A purge that fails now is retried by maintenance (the space is soft-deleted, purge_after has passed).
      await purgeSpace(ctx, space).catch((err) => console.error(`[lyren] Could not purge space ${space.public_id}:`, err));
    }
    return c.json({ ok: true, purgeAfter });
  });

  r.post('/:spaceId/restore', async (c) => {
    const { user } = freshSession(c, ctx);
    const space = requireMemberSpace(db, spaceParam(c), user.id, { deleted: true });
    if (space.role !== 'owner') throw notFound('Space');
    if (space.deleted_at === null) throw conflict('This space is not deleted');
    // Too late once the grace period is over: the purge may be under way (Appendix D 20).
    if (!isRestorable(space, ctx.now())) throw conflict('This space is being removed and can no longer be restored');
    // Deleted spaces count towards the quota already; this catches a quota lowered since.
    const max = config.quotas.maxSpacesPerUser;
    if (max > 0 && ownedSpaceCount(db, user.id) > max) throw quotaExceeded(`You can own at most ${max} spaces`);
    restoreSpace(db, space.id, ctx.now());
    await pushInvalidate(ctx, [space.public_id], 'defer');
    return c.json<SpaceSummaryDTO>(spaceSummary(db, space.id, user.id));
  });

  return r;
}
