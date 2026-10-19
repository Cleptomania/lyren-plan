// The acting user inside space route handlers. The gate (space/gate.ts) sets both before any handler
// runs, from the identity the space host handed over (§10.5); route bodies never read cookies or headers.

import type { Context } from 'hono';
import type { SpaceIdentity } from '../core/ports';
import type { AppEnv, SpaceActor } from '../env';

/** The acting user: `.id` is the directory user id, which is also their row in the users mirror. */
export function currentUser(c: Context<AppEnv>): SpaceActor {
  return c.get('user');
}

/** The full identity (role, re-auth time, the space) the gate judged this request by. */
export function currentIdentity(c: Context<AppEnv>): SpaceIdentity {
  return c.get('identity');
}

export function spaceActor(identity: SpaceIdentity): SpaceActor {
  return { id: identity.userId, display_name: identity.displayName };
}
