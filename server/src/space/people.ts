// The people of a space's content after an import (design §8.6, §6.5): moving the rows of a former member or a
// placeholder to a member (reassign, admins and owners), and giving up the imported rows attributed to oneself
// (disown, anyone, viewers included). Both change authorship only, in one transaction, and record no activity
// (an indirect change, SPEC §5.8).
//
// Reassign: `personId` is a placeholder or an account row of the mirror that is no member (is_member = 0);
// `toUserId` a member's. Its tasks (created_by), comments, work logs and activity move; the moved comments, work
// logs and activity get imported_by = the acting admin and imported_at = now, also those an import had labelled
// already: the reassignment is the attribution now, so their label says who made it (Appendix D 62); a
// placeholder's row is deleted afterwards.
//
// Disown: every comment, work log and activity entry that has a provenance (imported_by set) and is attributed
// to the actor goes to the space's placeholder named "Unknown (imported)", made by the first disown (a second
// one of the same name would be indistinguishable in Former members, Appendix D 62); the provenance stays.

import { Hono } from 'hono';
import { peopleReassignInput } from '@shared/schemas';
import type { PeopleDisownedDTO, PeopleReassignedDTO } from '@shared/types';
import type { Db } from '../core/db';
import type { AppEnv, Deps } from '../env';
import { badRequest, conflict, notFound } from '../http/errors';
import { readJson } from '../http/validate';
import type { MirrorUserRow } from '../services/rows';
import { nowIso } from '../services/sql';
import { currentUser } from './context';

/** The name of the placeholder disowned rows go to. */
export const DISOWNED_NAME = 'Unknown (imported)';

/** A mirror row id of a route (a placeholder's is negative); 404 for anything else. */
function readPersonId(value: string | undefined): number {
  const id = /^-?[1-9]\d{0,15}$/.test(value ?? '') ? Number(value) : NaN;
  if (!Number.isSafeInteger(id)) throw notFound('Person');
  return id;
}

/** A new placeholder (§8.6): its id below every other row's (and below 0). */
export function insertPlaceholder(db: Db, displayName: string, now: string): number {
  const { low } = db.get<{ low: number }>('SELECT min(coalesce(min(id), 0), 0) AS low FROM users')!;
  const id = low - 1;
  db.run(
    `INSERT INTO users (id, kind, display_name, email, is_member, deleted, updated_at)
     VALUES (:id, 'placeholder', :name, NULL, 0, 0, :now)`,
    { id, name: displayName, now },
  );
  return id;
}

/** Move `fromId`'s rows to `toId` (see the header); returns what moved. */
export function reassignPerson(db: Db, o: { fromId: number; toId: number; byId: number; now: string }): PeopleReassignedDTO['counts'] {
  return db.tx(() => {
    const person = db.get<MirrorUserRow>('SELECT * FROM users WHERE id = :id', { id: o.fromId });
    if (!person) throw notFound('Person');
    if (person.is_member === 1) {
      throw conflict(`${person.display_name} is a member of this space: only a former member's rows can be reassigned`);
    }
    const target = db.get<MirrorUserRow>('SELECT * FROM users WHERE id = :id AND is_member = 1', { id: o.toId });
    if (!target) throw badRequest('Choose a member of this space', [{ path: 'toUserId', message: 'Not a member of this space' }]);
    const params = { from: o.fromId, to: o.toId, by: o.byId, now: o.now };
    const moved = (table: string) =>
      db.run(`UPDATE ${table} SET user_id = :to, imported_by = :by, imported_at = :now WHERE user_id = :from`, params).changes;
    const counts = {
      tasks: db.run('UPDATE tasks SET created_by = :to WHERE created_by = :from', params).changes,
      comments: moved('comments'),
      worklogs: moved('work_logs'),
      activity: moved('activity'),
    };
    if (person.kind === 'placeholder') db.run('DELETE FROM users WHERE id = :id', { id: o.fromId });
    return counts;
  });
}

/** Move the imported rows attributed to `userId` to the "Unknown (imported)" placeholder; returns what moved. */
export function disownImported(db: Db, o: { userId: number; now: string }): PeopleDisownedDTO['counts'] {
  return db.tx(() => {
    const owned = db.get<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM comments WHERE user_id = :me AND imported_by IS NOT NULL)
            + (SELECT COUNT(*) FROM work_logs WHERE user_id = :me AND imported_by IS NOT NULL)
            + (SELECT COUNT(*) FROM activity WHERE user_id = :me AND imported_by IS NOT NULL) AS n`,
      { me: o.userId },
    )!.n;
    if (owned === 0) return { comments: 0, worklogs: 0, activity: 0 };
    const to =
      db.get<{ id: number }>("SELECT id FROM users WHERE kind = 'placeholder' AND display_name = :name ORDER BY id DESC LIMIT 1", {
        name: DISOWNED_NAME,
      })?.id ?? insertPlaceholder(db, DISOWNED_NAME, o.now);
    const moved = (table: string) =>
      db.run(`UPDATE ${table} SET user_id = :to WHERE user_id = :me AND imported_by IS NOT NULL`, { me: o.userId, to }).changes;
    return { comments: moved('comments'), worklogs: moved('work_logs'), activity: moved('activity') };
  });
}

export function peopleRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/me/disown', (c) => {
    const user = currentUser(c);
    return c.json<PeopleDisownedDTO>({ ok: true, counts: disownImported(db, { userId: user.id, now: nowIso() }) });
  });

  r.post('/:personId/reassign', async (c) => {
    const fromId = readPersonId(c.req.param('personId'));
    const input = await readJson(c, peopleReassignInput);
    const user = currentUser(c);
    const counts = reassignPerson(db, { fromId, toId: input.toUserId, byId: user.id, now: nowIso() });
    return c.json<PeopleReassignedDTO>({ ok: true, counts });
  });

  return r;
}
