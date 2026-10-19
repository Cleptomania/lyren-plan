// assertFoldsConsistent (design §3.4): every *_fold column holds fold() of its column, in every row of
// every folded table; assertTagListsConsistent (Appendix D 42): every task's tag_ids is its task_tags
// rows; assertTaskCountsConsistent (Appendix D 46): every task's comment_count and worklog_minutes are its
// comments' and work logs'. The space suites run all three after each test, so a write that forgets a fold,
// or a path the triggers miss, fails: the space harness and the service fixtures register their databases
// with checkFoldsAfterTest, and the Node test harness checks the spaces of its stacks (helpers.ts).

import { afterEach } from 'vitest';
import { fold } from '../../src/core/fold';
import type { Db } from '../../src/core/db';

/** The folded columns of the space schema (space/schema.ts). */
export const FOLDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  projects: ['name', 'description'],
  milestones: ['name', 'description'],
  epics: ['name', 'description'],
  tasks: ['title', 'description'],
  tags: ['name'],
  statuses: ['name'],
};

export function assertFoldsConsistent(db: Db): void {
  const problems: string[] = [];
  for (const [table, columns] of Object.entries(FOLDED_COLUMNS)) {
    const select = columns.flatMap((c) => [c, `${c}_fold`]).join(', ');
    for (const row of db.all<Record<string, string | number>>(`SELECT id, ${select} FROM ${table} ORDER BY id`)) {
      for (const column of columns) {
        const value = String(row[column]);
        if (row[`${column}_fold`] !== fold(value)) {
          problems.push(`${table} ${row.id}: ${column}_fold is ${JSON.stringify(row[`${column}_fold`])}, not fold(${JSON.stringify(value)})`);
        }
      }
    }
  }
  if (problems.length > 0) throw new Error(`Fold columns out of date:\n${problems.join('\n')}`);
}

/** Every task's tag_ids is the JSON array of its task_tags rows' tag ids, ascending (what the triggers write). */
export function assertTagListsConsistent(db: Db): void {
  const wrong = db.all<{ id: number; tag_ids: string; expected: string }>(
    `SELECT id, tag_ids, expected FROM (
       SELECT t.id, t.tag_ids,
              (SELECT json_group_array(tag_id) FROM (SELECT tag_id FROM task_tags WHERE task_id = t.id ORDER BY tag_id)) AS expected
         FROM tasks t)
      WHERE tag_ids <> expected ORDER BY id`,
  );
  if (wrong.length > 0) {
    const lines = wrong.map((r) => `tasks ${r.id}: tag_ids is ${r.tag_ids}, its task_tags are ${r.expected}`);
    throw new Error(`Tag lists out of date:\n${lines.join('\n')}`);
  }
}

/** Every task's comment_count and worklog_minutes are the count of its comments and the sum of its work logs' minutes. */
export function assertTaskCountsConsistent(db: Db): void {
  const wrong = db.all<{ id: number; comment_count: number; comments: number; worklog_minutes: number; minutes: number }>(
    `SELECT * FROM (
       SELECT t.id, t.comment_count, t.worklog_minutes,
              (SELECT COUNT(*) FROM comments WHERE task_id = t.id) AS comments,
              (SELECT COALESCE(SUM(minutes), 0) FROM work_logs WHERE task_id = t.id) AS minutes
         FROM tasks t)
      WHERE comment_count <> comments OR worklog_minutes <> minutes ORDER BY id`,
  );
  if (wrong.length > 0) {
    const lines = wrong.map(
      (r) => `tasks ${r.id}: comment_count ${r.comment_count} (${r.comments} comments), worklog_minutes ${r.worklog_minutes} (${r.minutes} logged)`,
    );
    throw new Error(`Task counts out of date:\n${lines.join('\n')}`);
  }
}

/** Databases registered by the running test. */
const registered: Db[] = [];

/** Check `db` with assertFoldsConsistent, assertTagListsConsistent and assertTaskCountsConsistent once the running test has ended. */
export function checkFoldsAfterTest(db: Db): void {
  registered.push(db);
}

/** The after-each check of every database the running test registered. */
export function checkRegisteredFolds(): void {
  for (const db of registered) {
    assertFoldsConsistent(db);
    assertTagListsConsistent(db);
    assertTaskCountsConsistent(db);
  }
}

afterEach(() => {
  try {
    checkRegisteredFolds();
  } finally {
    registered.length = 0;
  }
});
