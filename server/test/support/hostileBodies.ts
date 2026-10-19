// Request bodies that are invalid in as many places as their size allows (design Appendix D 44), for the
// validation bounds of shared/src/bounded.ts on both runtimes (server/test/validationBounds.test.ts, which also
// sends them to a server whose heap is capped, and server/test-workers/validation.test.ts). Before the bounds,
// zod described every bad item: the first query made 700,000 issues and 500 MB of heap on Node, and a stack
// overflow (500) in workerd; the import ones up to 7.9 million issues and 2.4 GB. With zod's validate() first
// (the first bound), the items that fail a check rather than a type (0 and -1 ids, keys one character too
// long, a WIP limit of 0) still made one issue each: the zero query 1.3 GB, and a valid task's 40 MiB of zero
// tag ids ended the Node server. P7 sends the imports as the multipart file of a replace commit, and adds the
// hostile archives of design §14.5: the gzip and value bombs, deep nesting, a huge string, bad gzip, wrong formats
// and versions, and users that do not add up. Cloudflare counts at most 300,000 JSON values before it parses
// (IMPORT_MAX_JSON_VALUES), which the 4 MiB import bodies hold more of: there they answer 413, so each also has a
// variant just under that count, which reaches the validation on both runtimes. Node counts at most 1,000,000
// (Appendix D 62), which four of them hold more of too: they answer 413 there as well, and have a variant under
// Node's count, which reaches the validation on Node. The fix of P7's review adds the boards whose configs each
// hold as many broken custom columns as a repair looks at (one import's repairs are bounded together).

import { gzipSync } from 'node:zlib';

export const MIB = 1024 * 1024;

/** The most bytes an import file has here: Cloudflare's IMPORT_BODY_LIMIT, less room for the multipart framing. */
const IMPORT_FILE = 4 * MIB - 1024;

/** Bytes of import file that hold just under Cloudflare's 300,000 JSON values when each item adds two (`{…}` or `[` and its `,`). */
const UNDER_CF_VALUES = (unitBytes: number) => 145_000 * (unitBytes + 1);
/** The same for Node's 1,000,000. */
const UNDER_NODE_VALUES = (unitBytes: number) => 495_000 * (unitBytes + 1);

/** Items of `unit` (each followed by a comma) between `head` and `tail`, filling `bytes`. */
function fill(head: string, unit: string, tail: string, bytes: number): string {
  const n = Math.floor((bytes - head.length - tail.length + 1) / (unit.length + 1));
  return head + Array(n).fill(unit).join(',') + tail;
}

/** An id that fails: of the wrong type (an empty string), or a number that fails a check (0, -1). */
export type BadId = '""' | '0' | '-1';

/** POST …/tasks/query: a filter whose projectIds are `unit`s (the schema takes at most 1,000 ids). */
export const badQuery = (bytes: number, unit: BadId = '""') => fill('{"filter":{"projectIds":[', unit, ']}}', bytes);

/** POST …/tasks/bulk: ids that are `unit`s. */
export const badBulk = (bytes: number, unit: BadId = '""') => fill('{"ids":[', unit, '],"patch":{"priority":1}}', bytes);

/** POST …/boards: 50 custom columns, each matching on lists of 1,000 bad ids (nested lists multiply issues). */
export function badBoard(unit: BadId = '""'): string {
  const ids = Array(1000).fill(unit).join(',');
  const column = (i: number) => `{"id":"c${i}","name":"C${i}","match":{"projectIds":[${ids}],"epicIds":[${ids}],"tagIds":[${ids}]}}`;
  return `{"name":"Bad","config":{"columns":{"groupBy":"custom","custom":[${Array.from({ length: 50 }, (_, i) => column(i)).join(',')}]}}}`;
}

/** Members `"<i in base 36>":<value>` (each key different) between `head` and `tail`, filling `bytes`. */
function fillRecord(head: string, value: string, tail: string, bytes: number): string {
  const entries: string[] = [];
  for (let size = head.length + tail.length; ; ) {
    const entry = `"${entries.length.toString(36)}":${value}`;
    if (size + entry.length + 1 > bytes) break;
    entries.push(entry);
    size += entry.length + 1;
  }
  return head + entries.join(',') + tail;
}

/** POST …/boards: a status axis whose WIP limits (a record, which zod never stops early) are all 0. */
export const badWipLimits = (bytes: number) =>
  fillRecord('{"name":"Bad","config":{"columns":{"prefs":{"status":{"wipLimits":{', '0', '}}}}}}', bytes);

/** POST …/boards: a status axis whose order lists group keys one character over their limit of 80. */
export const badGroupKeys = (bytes: number) =>
  fill('{"name":"Bad","config":{"columns":{"prefs":{"status":{"order":[', `"${'k'.repeat(81)}"`, ']}}}}}', bytes);

const TS = '"2026-10-18T00:00:00.000Z"';

/** A v1 export: its header, and the tables before `tasks`, ending in the opening of `tasks`. */
const EXPORT_HEAD =
  `{"format":"lyren-plan-export","formatVersion":1,"exportedAt":${TS},"appVersion":"1",` +
  '"settings":{"weekStartsOn":1,"estimateUnit":"points","defaultBoardId":null,"homePage":"dashboard"},' +
  '"statuses":[{"id":1,"name":"Open","category":"unstarted","color":"#000000","position":0}],"tags":[],' +
  '"projects":[{"id":1,"key":"AB","name":"A","description":"","color":"#000000","status":"active","position":0,' +
  `"taskCounter":1,"createdAt":${TS},"updatedAt":${TS}}],"milestones":[],"epics":[],"tasks":[`;
/** From the end of `tasks` to the opening of `boards`. */
const AFTER_TASKS = '],"comments":[],"worklogs":[],"activity":[],"boards":[';
/** The end of `boards` and of the file. */
const END = ']}';

/** A v1 export of `bytes` whose tasks are `unit`s: `1` (one issue each), `{"id":1}` (19 each) or `{}` (an object each). */
export const badImport = (bytes: number, unit: '1' | '{"id":1}' | '{}') => fill(EXPORT_HEAD, unit, AFTER_TASKS + END, bytes);

/** A task of the export above, valid but for what its `tagIds` (the rest of the row) holds. */
const TASK_HEAD =
  '{"id":1,"projectId":1,"number":1,"epicId":null,"statusId":1,"priority":0,"title":"T","description":"",' +
  '"startDate":null,"dueDate":null,"estimate":null,"rank":"a","completedAt":null,"archivedAt":null,' +
  `"createdBy":null,"createdAt":${TS},"updatedAt":${TS},"tagIds":[`;

/** A v1 export of `bytes` whose one task is valid but for its tag ids, all `unit`s. */
export const badTagIdsImport = (bytes: number, unit: BadId = '0') =>
  fill(EXPORT_HEAD + TASK_HEAD, unit, ']}' + AFTER_TASKS + END, bytes);

/** A board of the export above, up to its config (the rest of the row). */
const BOARD_ROW =
  `{"id":1,"projectId":null,"name":"B","description":"","position":0,"createdAt":${TS},"updatedAt":${TS},"config":`;
/** The board above, valid but for the project ids of its config's filter. */
const BOARD_HEAD = BOARD_ROW + '{"filter":{"projectIds":[';

/**
 * A v1 export of `bytes` holding one board whose config's filter lists project ids that are all `unit`s. A board's
 * config is read leniently (parseBoardConfigLenient: a part that is invalid falls back to its default), so the
 * import succeeds and the board has the default filter.
 */
export const badBoardConfigImport = (bytes: number, unit: BadId = '0') =>
  fill(EXPORT_HEAD + AFTER_TASKS + BOARD_HEAD, unit, ']}}}' + END, bytes);

/**
 * A v1 export of `bytes` holding one board whose config's custom columns are all `{}`: each would take three
 * failed parses to repair, so a list this long is not repaired (Appendix D 44; 34 s on Node at 40 MiB before).
 */
export const badCustomColumnsImport = (bytes: number) =>
  fill(EXPORT_HEAD + AFTER_TASKS + BOARD_ROW + '{"columns":{"groupBy":"custom","custom":[', '{}', ']}}}' + END, bytes);

/**
 * A v1 export of `boards` boards whose configs each hold 200 custom columns `{}` on both axes, as many as a repair
 * looks at (CUSTOM_REPAIR_MAX, shared/src/board.ts): each board alone is repaired column by column, so before one
 * import's repairs were bounded together, 9,000 of them took 8.5 s of the commit on Node (P7 security review).
 */
export function repairLimitBoardsImport(boards: number): string {
  const custom = `[${Array(200).fill('{}').join(',')}]`;
  const config = `{"columns":{"groupBy":"custom","custom":${custom}},"swimlanes":{"groupBy":"custom","custom":${custom}}}`;
  const rows = Array.from({ length: boards }, (_, i) => BOARD_ROW.replace('"id":1,', `"id":${i + 1},`) + config + '}');
  return EXPORT_HEAD + AFTER_TASKS + rows.join(',') + END;
}

/**
 * A v1 export holding one board whose config is valid but longer than an editor makes it: four group fields of
 * its columns' prefs each order 1,000 keys of 80 characters (about 330 KB of JSON, over ACTIVITY_DATA_MAX_CHARS).
 */
export function longConfigImport(): string {
  const keys = JSON.stringify(Array.from({ length: 1000 }, (_, i) => String(i).padStart(80, 'k')));
  const prefs = ['status', 'priority', 'tag', 'epic'].map((field) => `"${field}":{"order":${keys}}`).join(',');
  return EXPORT_HEAD + AFTER_TASKS + BOARD_ROW + `{"layout":"list","columns":{"groupBy":"tag","prefs":{${prefs}}}}}` + END;
}

/** A v1 export of `bytes` holding one board whose config's column prefs are keyed by fields no axis has. */
export const badPrefsImport = (bytes: number) =>
  fillRecord(EXPORT_HEAD + AFTER_TASKS + BOARD_ROW + '{"columns":{"prefs":{', '{}', '}}}}' + END, bytes);

/** A 16 KiB gzip of `[{},{},…]`, 16 MiB unpacked (the security review's probe: 357 MiB of heap once parsed). */
export const gzipBomb = () => gzipSync(Buffer.from(`[${Array(5_592_405).fill('{}').join(',')}]`), { level: 9 });

/** An archive v2 with one project, the given tasks, activity and users (each a JSON text), for the archive cases. */
function archive(o: { users?: string; tasks?: string; activity?: string; space?: string } = {}): string {
  return (
    `{"format":"lyren-plan-space","formatVersion":2,"exportedAt":${TS},"appVersion":"1",` +
    `"space":${o.space ?? '{"id":"x","name":"S","exportedBy":null}'},"users":[${o.users ?? ''}],` +
    '"settings":{"estimateUnit":"points","defaultBoardId":null},' +
    '"statuses":[{"id":1,"name":"Open","category":"unstarted","color":"#000000","position":0}],"tags":[],' +
    '"projects":[{"id":1,"key":"AB","name":"A","description":"","color":"#000000","status":"active","position":0,' +
    `"taskCounter":1,"createdAt":${TS},"updatedAt":${TS}}],"milestones":[],"epics":[],"tasks":[${o.tasks ?? ''}],` +
    `"comments":[],"worklogs":[],"activity":[${o.activity ?? ''}],"boards":[]}`
  );
}

/** One task of `archive`, its title and creator given. */
const archiveTask = (title: string, createdBy = 'null') =>
  TASK_HEAD.replace('"title":"T"', `"title":${JSON.stringify(title)}`).replace('"createdBy":null', `"createdBy":${createdBy}`) + ']}';

/** A request to the signed-in owner's space: its path under /api/s/<spaceId>, its body, and the status it answers. */
export interface HostileRequest {
  path: string;
  body: () => string | Uint8Array;
  /** Sent as the multipart field `file` (an import's). */
  form?: boolean;
  status: 200 | 400 | 413;
  /** A 400's code, when it is not validation_error (a file that is no JSON or no gzip at all). */
  code?: 'bad_request';
  /** Cloudflare's answer when it differs: its IMPORT_MAX_JSON_VALUES (300,000) and IMPORT_BODY_LIMIT (4 MiB) refuse first. */
  cloudflare?: 413;
  /** Node's answer when it differs: its IMPORT_MAX_JSON_VALUES (1,000,000) refuses first. */
  node?: 413;
}

const IMPORT = '/data/import/commit?mode=replace';

/** Every body above, at the most bytes each route takes on Cloudflare (2 MiB, imports 4 MiB). */
export const HOSTILE_REQUESTS = {
  'query, project ids that are empty strings': { path: '/tasks/query', body: () => badQuery(2 * MIB - 1, '""'), status: 400 },
  'query, project ids 0': { path: '/tasks/query', body: () => badQuery(2 * MIB - 1, '0'), status: 400 },
  'query, project ids -1': { path: '/tasks/query', body: () => badQuery(2 * MIB - 1, '-1'), status: 400 },
  'bulk, ids 0': { path: '/tasks/bulk', body: () => badBulk(2 * MIB - 1, '0'), status: 400 },
  'board, 150,000 ids that are empty strings': { path: '/boards', body: () => badBoard('""'), status: 400 },
  'board, 150,000 ids 0': { path: '/boards', body: () => badBoard('0'), status: 400 },
  'board, WIP limits 0': { path: '/boards', body: () => badWipLimits(2 * MIB - 1), status: 400 },
  'board, group keys over their limit': { path: '/boards', body: () => badGroupKeys(2 * MIB - 1), status: 400 },
  'import, tasks {"id":1}': { path: IMPORT, form: true, body: () => badImport(IMPORT_FILE, '{"id":1}'), status: 400, cloudflare: 413 },
  'import, tasks 1': { path: IMPORT, form: true, body: () => badImport(IMPORT_FILE, '1'), status: 400, cloudflare: 413, node: 413 },
  'import, a valid task with tag ids 0': {
    path: IMPORT,
    form: true,
    body: () => badTagIdsImport(IMPORT_FILE),
    status: 400,
    cloudflare: 413,
    node: 413,
  },
  'import, a board config with project ids 0': {
    path: IMPORT,
    form: true,
    body: () => badBoardConfigImport(IMPORT_FILE),
    status: 200,
    cloudflare: 413,
    node: 413,
  },
  'import, a board config with custom columns {}': {
    path: IMPORT,
    form: true,
    body: () => badCustomColumnsImport(IMPORT_FILE),
    status: 200,
    cloudflare: 413,
    node: 413,
  },
  'import, a board config with prefs of unknown fields': { path: IMPORT, form: true, body: () => badPrefsImport(IMPORT_FILE), status: 200, cloudflare: 413 },
  'import under the value cap, tasks {"id":1}': {
    path: IMPORT,
    form: true,
    body: () => badImport(UNDER_CF_VALUES('{"id":1}'.length), '{"id":1}'),
    status: 400,
  },
  'import under the value cap, a valid task with tag ids 0': { path: IMPORT, form: true, body: () => badTagIdsImport(UNDER_CF_VALUES(1)), status: 400 },
  'import under the value cap, a board config with project ids 0': {
    path: IMPORT,
    form: true,
    body: () => badBoardConfigImport(UNDER_CF_VALUES(1)),
    status: 200,
  },
  'import under the value cap, a board config with custom columns {}': {
    path: IMPORT,
    form: true,
    body: () => badCustomColumnsImport(UNDER_CF_VALUES(2)),
    status: 200,
  },
  "import under Node's value cap, tasks 1": { path: IMPORT, form: true, body: () => badImport(UNDER_NODE_VALUES(1), '1'), status: 400, cloudflare: 413 },
  "import under Node's value cap, a valid task with tag ids 0": {
    path: IMPORT,
    form: true,
    body: () => badTagIdsImport(UNDER_NODE_VALUES(1)),
    status: 400,
    cloudflare: 413,
  },
  "import under Node's value cap, a board config with project ids 0": {
    path: IMPORT,
    form: true,
    body: () => badBoardConfigImport(UNDER_NODE_VALUES(1)),
    status: 200,
    cloudflare: 413,
  },
  "import under Node's value cap, a board config with custom columns {}": {
    path: IMPORT,
    form: true,
    body: () => badCustomColumnsImport(UNDER_NODE_VALUES(2)),
    status: 200,
    cloudflare: 413,
  },
  // The P7 runner's payload at Node's cap (its 1,990,000 objects under the old 4,000,000 ended a 128 MB server on
  // the fourth request): validationBounds.test.ts sends it four times.
  "import under Node's value cap, tasks {}": { path: IMPORT, form: true, body: () => badImport(UNDER_NODE_VALUES(2), '{}'), status: 400, cloudflare: 413 },
  'import, 350 boards at the repair limit': { path: IMPORT, form: true, body: () => repairLimitBoardsImport(350), status: 200 },
  "import under Node's value cap, 1,200 boards at the repair limit": {
    path: IMPORT,
    form: true,
    body: () => repairLimitBoardsImport(1_200),
    status: 200,
    cloudflare: 413,
  },
  'archive, a 16 KiB gzip of [{},{},…]': { path: IMPORT, form: true, body: gzipBomb, status: 413 },
  'archive, nested 1,000,000 deep': {
    path: IMPORT,
    form: true,
    body: () => '['.repeat(1_000_000) + ']'.repeat(1_000_000),
    status: 400,
    code: 'bad_request',
  },
  'archive, a task title of 3 MiB': { path: IMPORT, form: true, body: () => archive({ tasks: archiveTask('x'.repeat(3 * MIB)) }), status: 400 },
  // Activity data has no field limits of its own: its JSON is bounded instead (Appendix D 62), so that no row of the
  // import comes near a Durable Object's 2 MB, which would fail the commit after its deletes (billed all the same).
  'archive, activity data of 3 MiB': {
    path: IMPORT,
    form: true,
    body: () =>
      archive({
        tasks: archiveTask('T'),
        activity: `{"id":1,"action":"task.created","entityType":"task","entityId":1,"projectId":1,"taskId":1,"actorId":null,"createdAt":${TS},"data":{"title":"${'x'.repeat(3 * MIB)}"}}`,
      }),
    status: 400,
  },
  'archive, bad gzip': {
    path: IMPORT,
    form: true,
    body: () => Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4),
    status: 400,
    code: 'bad_request',
  },
  'archive, not JSON': { path: IMPORT, form: true, body: () => '{"format":"lyren-plan-space",', status: 400, code: 'bad_request' },
  'archive, a wrong format': { path: IMPORT, form: true, body: () => '{"format":"lyren-plan-backup","formatVersion":2}', status: 400 },
  'archive, version 3': { path: IMPORT, form: true, body: () => '{"format":"lyren-plan-space","formatVersion":3}', status: 400 },
  'archive, a user reference missing from users': {
    path: IMPORT,
    form: true,
    body: () => archive({ users: '{"id":3,"kind":"account","displayName":"A","email":null}', tasks: archiveTask('T', '4') }),
    status: 400,
  },
  'archive, a placeholder with a positive id': {
    path: IMPORT,
    form: true,
    body: () => archive({ users: '{"id":3,"kind":"placeholder","displayName":"A","email":null}', tasks: archiveTask('T', '3') }),
    status: 400,
  },
} satisfies Record<string, HostileRequest>;

export type HostileCase = keyof typeof HOSTILE_REQUESTS;

/** The status a case answers on `runtime`. */
export const hostileStatus = (c: HostileRequest, runtime: 'node' | 'cloudflare') =>
  runtime === 'cloudflare' ? (c.cloudflare ?? c.status) : (c.node ?? c.status);

/** A case's request body: the file as an import's multipart form, or the JSON text. */
export function hostileBody(c: HostileRequest): { body: string | Uint8Array | FormData; contentType?: string } {
  const body = c.body();
  if (!c.form) return { body, contentType: 'application/json' };
  const form = new FormData();
  form.set('file', new File([body], 'archive.json'));
  return { body: form };
}
