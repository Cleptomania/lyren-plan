// WithSpaceDb on DoDb (server/test/contract/fixtures.ts): each body runs synchronously inside a fresh TestDbDO,
// on a DoDb over that object's storage made a space database, and the folds and tag lists are checked there
// before the body's result comes back. The service contracts and the equivalence test use it.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { DoDb } from '../src/runtime/cloudflare/doDb';
import { checkSpaceDb, initTestSpace, type WithSpaceDb } from '../test/contract/fixtures';

let objects = 0;

export const withDoSpaceDb: WithSpaceDb = (body) =>
  runInDurableObject(env.TEST_DB.getByName(`space-db-${++objects}`), (_instance, state) => {
    const db = new DoDb(state.storage);
    const result = body(initTestSpace(db));
    checkSpaceDb(db);
    return result;
  });
