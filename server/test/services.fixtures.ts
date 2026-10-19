// Direct-database fixtures for the service tests (no HTTP): an in-memory space database on NodeDb (design
// §14.3). The helpers themselves are in contract/fixtures.ts, which the contract suites share with the
// workers project; after each test the database's folds and tag lists are checked (support/folds.ts).

import type { Db } from '../src/db';
import { NodeDb } from '../src/runtime/node/nodeDb';
import { checkSpaceDb, initTestSpace, type WithSpaceDb } from './contract/fixtures';
import { checkFoldsAfterTest } from './support/folds';

export * from './contract/fixtures';

/** A space database (migrate(SPACE)) with the owner's mirror row (id 1) and the defaults. */
export function createDb(): { db: Db; userId: number } {
  const space = initTestSpace(new NodeDb(':memory:'));
  checkFoldsAfterTest(space.db);
  return space;
}

/** WithSpaceDb on NodeDb: a fresh in-memory database per body, closed afterwards. */
export const withNodeSpaceDb: WithSpaceDb = async (body) => {
  const db = new NodeDb(':memory:');
  try {
    const result = body(initTestSpace(db));
    checkSpaceDb(db);
    return result;
  } finally {
    db.close();
  }
};
