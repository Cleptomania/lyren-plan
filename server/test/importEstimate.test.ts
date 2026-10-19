// The weights of estimateRowWrites (design §8.9, §14.2; space/archive/estimate.ts) against the space schema: a
// table's weight is 1 plus its indexes as PRAGMA index_list lists them (a WITHOUT ROWID table's primary key is
// the table itself), the sequenced tables are those with AUTOINCREMENT, and the triggers the commit's order
// keeps from writing are all the schema has. A schema change that adds an index, a sequence or a trigger fails
// here until the estimate is looked at again; how close it comes to what a Durable Object bills is
// server/test-workers/importCost.test.ts's.

import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/core/version';
import { migrate } from '../src/core/migrate';
import { NodeDb } from '../src/runtime/node/nodeDb';
import { estimateRowWrites, INSERT_BATCH_ROWS, noRows, ROW_WEIGHTS, SEQUENCED_TABLES } from '../src/space/archive/estimate';
import { SPACE_MIGRATIONS } from '../src/space/schema';

function spaceSchema(): NodeDb {
  const db = new NodeDb(':memory:');
  migrate(db, SPACE_MIGRATIONS, { appVersion: APP_VERSION });
  return db;
}

describe('estimateRowWrites', () => {
  it('weighs each table with 1 + its indexes (PRAGMA index_list)', () => {
    const db = spaceSchema();
    for (const table of Object.keys(ROW_WEIGHTS)) {
      const sql = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
      const withoutRowid = /WITHOUT ROWID\s*$/i.test(sql.sql);
      const indexes = db.raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; origin: string }>;
      const written = indexes.filter((i) => !(withoutRowid && i.origin === 'pk'));
      expect(ROW_WEIGHTS[table as keyof typeof ROW_WEIGHTS], `${table}: ${written.map((i) => i.name).join(', ')}`).toBe(1 + written.length);
    }
    db.close();
  });

  it('knows every table the commit writes and which of them have a sequence', () => {
    const db = spaceSchema();
    const tables = (db.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%'").all() as Array<{ name: string; sql: string }>);
    expect(tables.map((t) => t.name).sort()).toEqual(Object.keys(ROW_WEIGHTS).sort());
    expect(tables.filter((t) => /AUTOINCREMENT/i.test(t.sql)).map((t) => t.name).sort()).toEqual([...SEQUENCED_TABLES].sort());
    db.close();
  });

  it('the triggers are the derived task columns', () => {
    const db = spaceSchema();
    const triggers = db.raw.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    expect(triggers.map((t) => ({ ...(t as object) }))).toEqual([
      { name: 'comments_deleted', tbl_name: 'comments' },
      { name: 'comments_inserted', tbl_name: 'comments' },
      { name: 'comments_moved', tbl_name: 'comments' },
      { name: 'task_tags_deleted', tbl_name: 'task_tags' },
      { name: 'task_tags_inserted', tbl_name: 'task_tags' },
      { name: 'task_tags_updated', tbl_name: 'task_tags' },
      { name: 'work_logs_deleted', tbl_name: 'work_logs' },
      { name: 'work_logs_inserted', tbl_name: 'work_logs' },
      { name: 'work_logs_updated', tbl_name: 'work_logs' },
    ]);
    db.close();
  });

  it('counts inserts by weight and deletes by row, one sequence write per insert statement, and the write generation', () => {
    expect(estimateRowWrites(noRows(), noRows())).toBe(1);
    const inserted = { ...noRows(), tasks: 1001, task_tags: 10, settings: 2 };
    const deleted = { ...noRows(), tasks: 3, comments: 5 };
    expect(estimateRowWrites(inserted, deleted)).toBe(
      1 + 1001 * ROW_WEIGHTS.tasks + 10 * ROW_WEIGHTS.task_tags + 2 * ROW_WEIGHTS.settings + 3 + 5 + Math.ceil(1001 / INSERT_BATCH_ROWS),
    );
  });
});
