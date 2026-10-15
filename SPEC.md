# Lyren Plan — Engineering Spec (the contract)

Lyren Plan is a **self-hosted, single-owner project management app**: projects → milestones → epics → tasks,
with highly configurable boards, tags, comments, work logs and an activity history. One Node.js process
serves a JSON API and a React SPA, storing everything in one SQLite file. **No third-party services, CDNs,
web fonts, analytics or outbound network calls — ever** (the browser must never fetch anything from another
origin either). It must work well on phones (mobile browsers, installable as a PWA) and desktops.

This document is binding for everyone working on the codebase. If something here is ambiguous, choose the
simplest behaviour consistent with it and note the decision in your final report. Never change a shared
contract (shared/, the DB schema, web/src/api/, exported props of cross-feature components) silently —
report it instead.

---------------------------------------------------------------------------------------------------------

## 1. Feature checklist (what "done" means)

- Projects (key like `LYR`, color, status active/on hold/completed/archived, description in Markdown, progress).
- Milestones per project (status, start/due dates, progress rolled up from epics' tasks).
- Epics per project, optionally assigned to a milestone (color, status, dates, progress).
- Tasks per project, optionally in an epic (milestone derived from epic). Fields: title, Markdown description,
  status (user-configurable statuses with fixed categories), priority (none/low/medium/high/urgent),
  tags, start date, due date, estimate (points or hours — a setting), manual order, archive flag.
  Human refs: `LYR-42`.
- Tags: global, colored, rename/recolor/merge/delete; created inline while tagging.
- Comments on tasks (Markdown, edit/delete own).
- Work log on tasks ("log activity"): date, time spent (e.g. `1h 30m`), note. Work-log report page.
- Activity history: automatic, field-level change history for tasks and structural changes
  (project/milestone/epic), per task, per project and global feeds.
- Boards (§8): saved, highly configurable views over tasks — filters, column grouping by any field or by
  user-defined custom columns, swimlanes (also custom), sorting, card display options, WIP limits,
  collapsed/hidden/reordered groups, kanban or grouped-list layout, drag & drop that edits tasks, quick
  filters. **Global boards** (Boards page) and **project boards** (each project's Board tab, persisted
  server-side, several per project).
- Dashboard (overdue / due today / due soon / in progress / recently done / activity / project progress).
- Global search + command palette (mod+K).
- Settings: account (display name, password, sessions), preferences (theme, week start, estimate unit,
  home page), statuses, tags, data (JSON export/import, SQLite backup download).
- First-run setup screen (setup code from the server log, create owner account, optional sample data),
  login, logout, password reset CLI, backup CLI.
- Mobile: every screen usable at 360px wide; touch drag & drop with long-press plus non-drag alternatives
  (menus) for every drag action; bottom navigation; full-screen sheets for dialogs/drawers; Back gesture
  closes sheets; installable PWA with an offline app shell.
- Self-hosting: `npm ci && npm run build && npm start`, or Docker / docker-compose. Data in `DATA_DIR`.
- Single-file desktop app (§12.1): `npm run package:win` → one Windows exe that needs nothing installed;
  double-click starts the server and opens the browser; data in `%LOCALAPPDATA%\Lyren Plan`.

---------------------------------------------------------------------------------------------------------

## 2. Stack (do not add dependencies)

| Layer   | Choice |
|---------|--------|
| Runtime | Node.js ≥ 22.13 (dev: 24). **`node:sqlite`** built-in (no native modules). |
| Server  | Hono 4 + @hono/node-server 1, zod 4, fractional-indexing 3. Bundled to one file by esbuild. |
| Web     | React 19, react-router 7 (library mode, import from `react-router`), @tanstack/react-query 5, Tailwind CSS 4, @dnd-kit/core 6 + sortable 10 + utilities 3, @floating-ui/react 0.27, lucide-react (0.5xx icon names), react-markdown 10 + remark-gfm 4, clsx. |
| Tests   | vitest 4 (node environment). |
| TS      | TypeScript 5.9, strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (use `import type`). |

**No new npm dependencies** may be installed (parallel installs corrupt node_modules). If you truly need one,
say so in your report. Build-time only, for the single-file app (§12.1), pinned to exact versions:
`postject` 1.0.0-alpha.6 (injects the SEA blob) and `resedit` 3.1.0 (icon and version information); nothing
at runtime depends on them. zod 4 notes: use `.prefault()` for nested object defaults, `z.partialRecord` for
enum-keyed partial maps; input schemas in shared have no `.default()`s (servers apply defaults explicitly).

Path aliases: `@shared/*` → `shared/src/*` (server and web); `@/*` → `web/src/*` (web only; relative imports
are also fine).

---------------------------------------------------------------------------------------------------------

## 3. Repository layout and ownership

```
shared/src/            CONTRACT (owner: lead). constants, dates, duration, schemas (zod inputs), board (config +
                       grouping helpers), filter (reference filter/sort semantics), export (import schema),
                       types (DTOs). Pure TS — no Node/DOM APIs.
server/src/
  index.ts             entry of the Node build / Docker (lead); cli.ts: the commands serve, backup, reset-password,
                       help (lead); startupErrors.ts: plain-language start-up failures (lead)
  sea.ts desktop/      entry and runtime of the single-file desktop app (§12.1) (lead)
  config.ts env.ts     config / Deps / AppEnv (lead)
  app.ts               middleware + route mounting (lead) — routes are already mounted, don't edit
  db/index.ts          Db wrapper (lead)        db/schema.ts  migrations (lead)   db/seed.ts (lead; createSampleData: server-domain)
  db/snapshots.ts      automatic snapshot names and retention (SNAPSHOT_KEEP, §12) (lead)
  http/                errors, validate, static (lead)
  auth/                sessions, passwords, middleware, /api/auth routes (lead)
  services/            domain services (server-domain agent) — see §6
  routes/<area>.ts     one Hono router factory per area (feature agents) — stubs exist
server/test/           vitest API tests; helpers.ts gives createTestContext() (lead)
web/index.html web/public/   (web-foundation agent: manifest, icons, favicon, service worker; theme-init.js is lead's)
web/vite.config.ts web/devProxy.ts   build config; the dev server proxies /api to PORT/HOST or LYREN_API_URL (lead)
scripts/package.mjs scripts/lib/   the single-file app's packaging and its pure helpers, tested in scripts/test (lead)
.github/workflows/release.yml scripts/ci/   release workflow, its Windows smoke test and publishing script (§12.1) (lead)
web/src/
  main.tsx app/        root, router, auth gates (lead)
  api/                 fetch client + ALL React Query hooks (lead) — the web↔API contract
  lib/                 theme, format, colors, hooks, events, taskLinks, overlays (lead)
  components/ui/       design-system primitives (web-foundation agent)
  components/layout/   AppShell, PageHeader, nav (web-foundation agent)
  components/domain/   task/status/tag/... display components, pickers, TaskActionsMenu (web-domain agent)
  features/<area>/     pages and feature components (feature agents)
```

Feature ownership (web + server):

| Agent             | Server routes (server/src/routes)                         | Web (web/src/features)                           |
|-------------------|-----------------------------------------------------------|--------------------------------------------------|
| server-domain     | bootstrap.ts + services/*                                 | —                                                |
| web-foundation    | —                                                         | components/ui, components/layout, auth/, common/, web/public |
| web-domain        | —                                                         | components/domain                                |
| projects          | projects.ts, milestones.ts, epics.ts                      | projects/                                        |
| tasks             | tasks.ts (+ services/taskMutations.ts)                    | tasks/                                           |
| timeline          | timeline.ts                                               | timeline/                                        |
| boards            | boards.ts                                                 | boards/                                          |
| admin             | tags.ts, statuses.ts, settings.ts, data.ts                | settings/                                        |
| dashboard-search  | dashboard.ts, search.ts                                   | dashboard/, search/                              |

Only edit files you own. If you need a change elsewhere (a bug in a shared component, a missing hook),
make the smallest possible fix, keep exported signatures backwards compatible, and list it in your report.

---------------------------------------------------------------------------------------------------------

## 4. Server conventions

- **Route factories**: `export function xRoutes({ db, config }: Deps) { const r = new Hono<AppEnv>(); ...; return r; }`.
  Paths inside a router are relative to its mount point (see app.ts). All routes except `/api/health` and
  `/api/auth/{status,setup,login,logout}` are already behind `requireAuth`; use `currentUser(c)` from
  `auth/context.ts` to get the user row. Middleware order in app.ts: CSRF header → session → auth gate →
  body limit (import 50 MiB, public auth paths 64 KiB, else 2 MiB) → gzip, so requests that will be refused
  are refused before any body byte is read (bodyLimit buffers chunked bodies before calling next()).
- **Validation**: `await readJson(c, schema)`, `readQuery(c, schema)`, `readId(c, 'id')` from `http/validate.ts`
  with the zod schemas in `shared/src/schemas.ts` / `board.ts` / `export.ts`. Never trust unvalidated input.
- **Errors**: throw `badRequest(msg, details?)`, `notFound('Task')`, `conflict(msg)`, `forbidden()` from
  `http/errors.ts`. The error handler renders `{ error: { code, message, details? } }`. For a field-specific
  400 use `badRequest('Due date must be on or after start date', [{ path: 'dueDate', message: '...' }])`.
- **Status codes**: 200 OK (GET/PATCH/DELETE/actions), 201 for creates (POST that creates a resource), body = DTO.
  Deletes return `{ ok: true }`.
- **Database** (`db/index.ts`): `db.all<T>(sql, params)`, `db.get<T>`, `db.run` → `{changes, lastInsertRowid}`,
  `db.tx(() => {...})` (synchronous only; nests with savepoints), `db.backupTo(file)` (VACUUM INTO; not inside
  tx). Named params use `:name` in SQL with a plain object. **A named param missing from the object throws;
  extra keys are ignored**; explicit `undefined` binds NULL; booleans bind 0/1. Rows are snake_case; map to
  camelCase DTOs in services/mappers.ts. Every multi-statement mutation runs inside `db.tx`.
  `PRAGMA foreign_keys=ON` (cascades are relied upon). Ids are AUTOINCREMENT (never reused).
- **Timestamps**: `new Date().toISOString()` (always this exact format — SQL compares them as strings).
  Calendar dates are `'YYYY-MM-DD'` strings. The server's "today" (`new Date().toISOString().slice(0,10)`) is
  only a fallback — APIs that depend on the user's day take a `today` parameter from the client.
- **Activity**: every create/update/delete of a project, milestone, epic, task, comment or work log records
  activity (§5.8) in the same transaction, via `services/activity.ts`.
- **SQL injection**: never interpolate values into SQL; only interpolate trusted fragments you built
  (column names from a fixed whitelist, placeholders).
- Case-insensitive text matching uses the registered SQL function `lyren_lower(x)` (JS `toLowerCase()`,
  Unicode-aware) so SQL agrees with `shared/src/filter.ts`. The ref is per row:
  `instr(lyren_lower(t.title || char(10) || t.description || char(10) || p.key || '-' || t.number), :tok0) > 0`
  (one parameter per token). If you use LIKE anywhere, escape `%`, `_` and `\` and add `ESCAPE '\'`.
- Pass id lists as one JSON parameter: `WHERE id IN (SELECT value FROM json_each(:ids))` with
  `{ ids: JSON.stringify(ids) }` (keeps SQL text constant). `IN` never matches NULL: when a filter array
  contains `null`, strip it from the JSON and OR in `col IS NULL`. Deduplicate id arrays first.
- Tests run on Linux and natively on Windows: start server sources with `tsxCommand`/`tsxEnv`
  (server/test/tsxNode.ts: node + tsx's loader in ONE process; never node_modules/.bin/tsx, a shell script on
  Windows, nor tsx's CLI, whose second process a Windows kill would orphan); expect host paths via
  `path.resolve`/`path.join`; never create two names differing only in case; directory links as junctions
  on win32; no graceful-signal assertions on win32 (child.kill() is TerminateProcess).
- Tests: `server/test/<area>.test.ts` with `createTestContext(overrides?)` from `server/test/helpers.ts`
  (in-memory DB; `ctx.signedIn()` returns a client that sends cookie + CSRF header; `ctx.config.dataDir` is a
  temp dir). Run with `npx vitest run server/test/<file>`.

## 5. Domain rules

### 5.1 Projects
- `key` 2–10 chars `[A-Z][A-Z0-9]+`, unique (case-insensitive; 409 on duplicate). If omitted on create,
  generate from the name: initials of up to 4 words when the name has ≥2 words, else the first 3 letters;
  letters/digits only, uppercase; prefix `P` if it doesn't start with a letter; pad short keys with `X`; if
  taken append 2, 3, … (truncating to stay ≤ 10). Changing a key changes every task ref (refs are computed).
- Default color: `DEFAULT_PROJECT_COLOR`. Position: appended (max+1).
- Status `archived` hides the project's tasks from task queries unless a filter lists the project explicitly
  or sets `includeArchivedProjects` (§7). Archived projects are listed separately in the UI.
- Delete cascades to everything (milestones, epics, tasks, comments, logs, activity, project boards). Activity
  rows of tasks that were moved out of the project earlier (and still exist elsewhere) are not part of it: they
  are re-homed to the task's current project first, so the task keeps its full history. Records
  `project.deleted` with `project_id NULL`, `entity_id` = old id, data `{ name, key }`. If settings.defaultBoardId
  pointed at a cascaded board it becomes null. Board references are cleaned (§5.11).
- `GET /api/projects(/:id)` accept `?today=` for `stats.tasksOverdue`.

### 5.2 Milestones
- Belong to one project (immutable). Position appended within the project.
- `completedAt` set when status becomes `completed` or `cancelled` (if not already set); cleared otherwise.
- If both dates are set, `startDate <= dueDate` (checked on the merged result; 400 with path `dueDate`).
- Delete: `?epics=detach` (default; FK sets epics' milestone to NULL) or `?epics=delete` (deletes its epics,
  logging `epic.deleted` for each; their tasks lose the epic via FK).

### 5.3 Epics
- Belong to one project (immutable); optional milestone **of the same project** (else 400 `milestoneId`).
- `completedAt` set when status becomes `done`/`cancelled`; cleared otherwise. Same date rule as milestones.
- Delete: `?tasks=detach` (default) or `?tasks=delete` (delete the epic's tasks, each logging `task.deleted`).

### 5.4 Statuses
- User-configurable list with a fixed `category` (`backlog|unstarted|started|completed|cancelled`).
  Closed = completed or cancelled. At least one status must always exist (deleting the last → 409).
  Default color `DEFAULT_STATUS_COLOR`. Names unique case-insensitively (409).
- Default status for new tasks: first by position with category `unstarted`, else first status.
- Order: `position` (dense 0…n−1) is the column order everywhere (boards, pickers, grouping). Settings shows
  statuses grouped by category in `STATUS_CATEGORIES` order, so a created status is inserted right after the
  last status whose category comes no later than its own (else first), and later statuses shift by one
  (their `updated_at` untouched). `POST /api/statuses/reorder` sets any order.
- Changing a status's category updates its tasks' `completedAt` (entering closed: set to now where NULL;
  leaving closed: NULL).
- Deleting a status in use requires `?reassignTo=<otherId>`; tasks move (with completedAt transitions).
  Without it → 409 `conflict` with message mentioning the task count; `reassignTo` = itself or unknown → 400.

### 5.5 Tasks
- `number` = `++projects.task_counter` (in the same transaction). `ref` = `${project.key}-${number}`.
- `projectId` required on create. `epicId` must belong to the task's project. On update, if `epicId` refers
  to an epic in another project and `projectId` is omitted, the task **moves to that epic's project**.
  If both are given and disagree → 400.
- Moving to another project (`projectId` change): new number from the target project; epic cleared unless a
  valid target-project epic is given in the same request; records `task.moved` (`fromProjectId/Name`,
  `toProjectId/Name`, `fromRef`, `toRef`; row `project_id` = the NEW project) in addition to `task.updated`
  for other changed fields. **Returning** to a project the task left before (e.g. the Undo of a move): the
  number from its latest `task.moved` away from that project (`fromRef`) is reused when no task holds it and
  it is ≤ that project's `task_counter` (numbers are never issued twice, so it normally is free), so the old
  ref and links to it work again; otherwise a new number as above (`returningNumber` in taskMutations.ts).
- `completedAt`: set to now when the status category goes non-closed → closed; NULL when closed → non-closed;
  unchanged for closed → closed.
- Tags: `tagIds` replaces the set; `addTagIds`/`removeTagIds` adjust it; `tagIds` with add/remove → 400.
  Unknown tag ids → 400 (path `tagIds`). TaskDTO.tags sorted by name, case-insensitive.
- `archived: true|false` sets/clears `archivedAt`. Archived tasks are hidden by default filters. Archived
  closed tasks still count towards project/milestone/epic progress; archived open tasks do not (§6 `stats.ts`).
- Dates: `startDate <= dueDate` when both set (400 path `dueDate`).
- **Rank** (manual order) is a global fractional index (`fractional-indexing`); ranks are kept unique.
  Positions (`rankPositionSchema`, always in ascending-rank terms):
  - `'bottom'` (default for create): after the current max rank. `'top'`: before the min rank.
  - `{ afterId }` (beforeId optional, only validated): place **directly after `after` in the GLOBAL order**:
    lo = rank(after), hi = the next rank after `after` ordered by (rank, id), excluding the moving task
    (null if none); new rank = generateKeyBetween(lo, hi).
  - `{ beforeId }` only: hi = rank(before), lo = the previous rank before it (excluding the moving task).
  - `{}` / both null: no-op (rank unchanged). Neighbours must exist (400) and must not be the task itself
    (400); `afterId === beforeId` → 400.
  - `{ rank }` (updates only, `taskPositionSchema`; the Undo of a move): that exact rank again when no other
    task holds it — the task is back in its old place among ALL tasks, including ones a view filters out —
    else directly after the task holding it. A malformed key → 400 (path `position.rank`). In updates the
    neighbour object is strict, so `{ rank: <malformed> }` can't pass as a no-op `{}`.
  - If lo === hi (duplicate ranks), renormalize all task ranks (`generateNKeysBetween(null, null, n)` over
    tasks ordered by rank, id — no updated_at bump, no activity) and recompute.
  - Rank-only changes do NOT bump `updated_at` and create no activity.
- `updated_at` changes only when something other than rank actually changed; a no-op PATCH returns the task
  unchanged and logs nothing.
- Delete: cascades. Records `task.deleted` with `task_id NULL`, `project_id`, `entity_id` = old id, data `{ title, ref }`.
- Duplicate: same fields/tags/epic, title + ` (copy)`, status kept unless closed (then default status),
  `completedAt` NULL, not archived, placed right after the original. Activity `task.created` with
  `data.duplicatedFrom = <ref>`.
- Bulk update/delete: all-or-nothing transaction; unknown ids → 400 listing them; one activity entry per task.
  Bulk `epicId` must belong to each task's project (400 listing offenders); bulk never moves projects.

### 5.6 Comments & work logs
- Comments: body trimmed, 1–50 000 chars, Markdown. Only the author may edit/delete (403 otherwise).
  Editing sets `edited_at`. Work logs: `date` required, `minutes` (int ≥ 0, nullable) and/or `note`;
  at least one of minutes>0 or a non-empty note — on create and on the MERGED row for updates (400, path
  `note`). Author-only edits/deletes.
- TaskDTO.commentCount and worklogMinutes are aggregates over existing rows.

### 5.7 Tags
- Name unique case-insensitive (duplicate → 409). Default color `DEFAULT_TAG_COLOR`.
- Merge `POST /tags/:id/merge {targetId}`: retag (no duplicates), delete source, return target. id == targetId → 400.
- Tag changes are not logged as activity (task tag changes are).

### 5.8 Activity
Row: `user_id, project_id, task_id, entity_type, entity_id, action, data(JSON), created_at`. Actions are
listed in `ActivityAction` (shared/src/types.ts). `data` follows `ActivityData`:
- `*.created`: `{ title|name, ref? }`. Task: `{ title, ref }`.
- `*.updated`: `{ changes: FieldChange[], title|name, ref? }` — only fields that actually changed.
  Task fields: `title` (from/to), `description` (no values), `status` (ids + `fromLabel/toLabel` names),
  `priority` (numbers + labels), `epic` (ids + names), `startDate`, `dueDate`, `estimate`, `tags`
  (`added`/`removed` = tag names), `archived` (booleans). Milestone/epic/project fields similarly
  (`name`, `status`, `startDate`, `dueDate`, `milestone` (epic), `key`, `color` (no values), `description`).
- `comment.*`: `{ excerpt }` (first 200 chars), `task_id` set. `worklog.*`: `{ minutes, date, note }`, `task_id` set.
- Task events have `task_id` = the task (except `task.deleted`). All entries have `project_id` (except
  `project.deleted`). Structural events (milestone/epic) have `task_id NULL`.
- **Indirect changes are not logged** and do not bump `tasks.updated_at`: FK SET NULL effects (milestone/epic
  deletion with detach), status reassignment on status delete, status category changes, tag delete/merge.
- `TaskTimelineDTO.activity` contains only `entity_type = 'task'` entries (comments and work logs come
  through their own lists). Feeds (`GET /api/activity`) contain everything, newest first by id.
- Stored `data` is served (and exported) through `sanitizeActivityData` (shared/src/export.ts): keys whose value
  doesn't match the `ActivityData` shape, and malformed `changes` entries, are dropped, so clients can rely on it.

### 5.9 Settings
Stored per key as JSON in `settings`; `GET /api/settings` returns `DEFAULT_SETTINGS` merged with stored values.
Keys starting with `_` are internal (never exported/overwritten by import). `defaultBoardId` must reference an
existing board (or null). Deleting that board (directly or via project cascade) resets it to null.
Theme is a per-device preference (localStorage), not a server setting.

### 5.10 Import (`POST /api/data/import`)
Validate with `exportSchema` (shared/src/export.ts) — 400 with details on any failure, nothing changed. Then
check referential integrity (400 listing problems): unique ids per table, unique project keys / tag names /
status names (case-insensitive); milestone/epic/task `projectId` exist; epic `milestoneId` in the same
project; task `statusId` exists; task `epicId` in the same project; task `tagIds` exist; comment/worklog
`taskId` exist; activity `taskId`/`projectId` exist or are null (drop entries that dangle);
`settings.defaultBoardId` exists else becomes null; board `projectId` exists or null. Also the value rules
later edits re-check on the merged row: `startDate <= dueDate` for tasks/milestones/epics (path `<table>.<i>.dueDate`)
and work logs with minutes>0 or a non-blank note (path `worklogs.<i>.note`). The schema caps ids, task numbers,
`taskCounter` and positions at `IMPORT_INT_MAX` (2^40, far from the 2^53 node:sqlite can read back), and activity
`data` must match `ActivityData` (§5.8; extra keys allowed). Before replacing, write
a safety snapshot with `db.backupTo(DATA_DIR/backups/pre-import-<timestamp>.db)` (a `-<n>` suffix keeps names
unique), then delete the oldest pre-import snapshots beyond `SNAPSHOT_KEEP` (never the new one; §12). Then in
ONE `db.tx`: delete all domain rows (activity, comments, work_logs, task_tags, tasks, epics, milestones, boards,
projects, tags, statuses, non-internal settings), insert everything with the ORIGINAL ids, map every user reference
(authorId/actorId/createdBy) to the importing user (comment/worklog `authorId` null too, so they stay
editable by their author), set `task_counter = max(taskCounter, max(number))`,
regenerate task ranks preserving the exported order (rank, id), recompute `completedAt` consistency from
status categories (closed without completedAt → now; open → NULL), parse board configs leniently and force
project boards' `filter.projectIds = [projectId]`, reset any AUTOINCREMENT counter above `IMPORT_INT_MAX` (left by
an older import) to the table's max id; finally `PRAGMA foreign_key_check` must be empty.
Users and sessions are never touched. Returns `{ ok, counts, backupFile }`.

### 5.11 Board references
Board configs store entity ids in JSON (no FKs). `services/boardRefs.ts#rewriteBoardRefs(db, kind, fromId,
toId|null)` applies `remapBoardConfigIds` (shared/src/board.ts) to every board and saves changed configs. Call it
in the same transaction from: tag merge (→ target) and tag delete (null), status delete (→ reassignTo),
milestone / epic / project delete (null). Deletions leave filter ids in place (they match nothing; the UI shows
them as "(deleted)") but remove them from drop patches and group prefs. Clients must ignore unknown ids.

---------------------------------------------------------------------------------------------------------

## 6. Server services (server-domain agent builds these first; feature agents use them)

`server/src/services/`:

- `rows.ts` — row interfaces for every table (`ProjectRow`, `MilestoneRow`, `EpicRow`, `StatusRow`, `TagRow`,
  `TaskRow`, `CommentRow`, `WorklogRow`, `ActivityRow`, `BoardRow`).
- `mappers.ts` — row → DTO (`toProjectDTO(row, stats)`, `toMilestoneDTO`, `toEpicDTO`, `toStatusDTO`,
  `toTagDTO`, `toBoardDTO` (config via `parseBoardConfigLenient`), `toCommentDTO`, `toWorklogDTO`).
- `stats.ts` — batched aggregate queries: project stats (needs `today`), milestone & epic progress,
  status/tag task counts. No N+1 queries. Progress (tasksTotal/tasksClosed/estimates) counts non-archived
  tasks plus archived **closed** tasks, so archiving finished work never moves progress backwards; archived
  open tasks count nowhere (not in tasksOpen/tasksOverdue either). Tag counts exclude archived tasks; status
  counts include them.
- `entities.ts` — `listProjects/getProject(DTO)`, `listMilestones(projectId?)/getMilestone`,
  `listEpics(projectId?)/getEpic`, `listStatuses`, `listTags`, `listBoards/getBoard`;
  `requireProject/requireMilestone/requireEpic/requireStatus/requireTask/requireBoard` (row or 404);
  `requireTagIds(ids)` (400 listing unknown ids); `defaultStatusId()`; `generateProjectKey(name)`;
  `nextPosition(table, scope?)`; `assertExactIdSet(ids, expected)` (400 for reorder mismatches).
- `tasks.ts` — `hydrateTasks(db, rows)` → TaskDTO[] (batched tags / counts / worklog sums / milestone / ref),
  `getTaskDTO(db, id)`, `queryTasks(db, input, { nowMs?, today?, weekStartsOn? })` → `TaskQueryResult`,
  `buildTaskWhere(filter, ctx)` → `{ sql, params }` (exact SQL equivalent of `matchesTaskFilter`),
  `taskOrderBy(sort)` (equivalent of `compareTasks`), `findTaskByRef(db, ref)`.
- `rank.ts` — `rankForPosition(db, position, movingTaskId?)`, `renormalizeRanks(db)` (§5.5).
- `activity.ts` — `recordActivity(db, entry)`, diff helpers to build `FieldChange[]`,
  `listActivity(db, query)` → `ActivityPage`, `hydrateActivity(db, rows)`, `taskActivity(db, taskId)`.
- `settings.ts` — `getSettings(db)`, `saveSettings(db, patch)`.
- `boardRefs.ts` — `rewriteBoardRefs(db, kind, fromId, toId)` (§5.11).
- `routes/bootstrap.ts` — `GET /api/bootstrap` → `BootstrapDTO` (accepts `?today=`).
- `db/seed.ts#createSampleData(db, userId)` — §11.

---------------------------------------------------------------------------------------------------------

## 7. API reference

All bodies are JSON. All mutating requests carry header `X-Lyren-Request: 1` (web/src/api/client.ts does).
Types: inputs in `shared/src/schemas.ts` / `board.ts` / `export.ts`, outputs in `shared/src/types.ts`.
Every reorder endpoint requires the exact full id set of its scope (400 otherwise).

| Method & path | Input | Output |
|---|---|---|
| GET `/api/health` | – | `{ ok, version }` |
| GET `/api/auth/status` | – | `AuthStatusDTO` |
| POST `/api/auth/setup` | `SetupInput` (incl. `setupCode`) | 201 `{ user }` + cookie |
| POST `/api/auth/login` | `LoginInput` | `{ user }` + cookie |
| POST `/api/auth/logout` | – | `{ ok }` |
| GET/PATCH `/api/auth/me` | `UpdateMeInput` | `UserDTO` |
| POST `/api/auth/password` | `ChangePasswordInput` | `{ ok }` (other sessions revoked) |
| GET `/api/auth/sessions` | – | `SessionDTO[]` |
| DELETE `/api/auth/sessions/:id` · POST `/api/auth/sessions/revoke-others` | – | `{ ok }` |
| GET `/api/bootstrap?today=` | – | `BootstrapDTO` |
| GET `/api/projects?today=` · GET `/api/projects/:id?today=` | – | `ProjectDTO[]` · `ProjectDTO` |
| POST `/api/projects` · PATCH `/api/projects/:id` | `ProjectCreateInput` · `ProjectUpdateInput` | `ProjectDTO` |
| DELETE `/api/projects/:id` | – | `{ ok }` |
| POST `/api/projects/reorder` | `ReorderInput` | `{ ok }` |
| GET `/api/projects/:id/milestones` · `/epics` | – | `MilestoneDTO[]` · `EpicDTO[]` |
| POST `/api/milestones` · GET/PATCH `/api/milestones/:id` | `MilestoneCreateInput` · `MilestoneUpdateInput` | `MilestoneDTO` |
| DELETE `/api/milestones/:id?epics=detach\|delete` | – | `{ ok }` |
| POST `/api/milestones/reorder` | `ReorderInput` (all of one project) | `{ ok }` |
| POST `/api/epics` · GET/PATCH `/api/epics/:id` | `EpicCreateInput` · `EpicUpdateInput` | `EpicDTO` |
| DELETE `/api/epics/:id?tasks=detach\|delete` | – | `{ ok }` |
| POST `/api/epics/reorder` | `ReorderInput` (all of one project) | `{ ok }` |
| POST `/api/tasks/query` | `TaskQueryInput` | `TaskQueryResult` |
| POST `/api/tasks` | `TaskCreateInput` | 201 `TaskDTO` |
| GET `/api/tasks/:id` · GET `/api/tasks/ref/:ref` | – | `TaskDTO` |
| PATCH `/api/tasks/:id` | `TaskUpdateInput` | `TaskDTO` |
| DELETE `/api/tasks/:id` | – | `{ ok }` |
| POST `/api/tasks/:id/duplicate` | – | 201 `TaskDTO` |
| POST `/api/tasks/bulk` | `TaskBulkUpdateInput` | `{ tasks: TaskDTO[] }` |
| POST `/api/tasks/bulk-delete` | `TaskBulkDeleteInput` | `{ deleted }` |
| GET `/api/tasks/:id/timeline` | – | `TaskTimelineDTO` (each list oldest first) |
| POST `/api/tasks/:id/comments` · PATCH/DELETE `/api/comments/:id` | `CommentCreateInput` | `CommentDTO` |
| POST `/api/tasks/:id/worklogs` · PATCH/DELETE `/api/worklogs/:id` | `WorklogCreateInput` · `WorklogUpdateInput` | `WorklogDTO` |
| GET `/api/worklogs?from&to&projectId&today` | `WorklogReportQuery` (default [today-29, today]) | `WorklogReportDTO` |
| GET `/api/activity?projectId&taskId&before&limit` | `ActivityQueryInput` | `ActivityPage` |
| GET/POST `/api/boards` · GET/PATCH/DELETE `/api/boards/:id` | `BoardCreateInput` · `BoardUpdateInput` | `BoardDTO` |
| POST `/api/boards/:id/duplicate` · POST `/api/boards/reorder` | – · `ReorderInput` (one scope: global or one project) | 201 `BoardDTO` · `{ ok }` |
| GET/POST `/api/tags` · PATCH/DELETE `/api/tags/:id` · POST `/api/tags/:id/merge` | `TagCreateInput` · `TagUpdateInput` · `TagMergeInput` | `TagDTO` |
| GET/POST `/api/statuses` · PATCH `/api/statuses/:id` · DELETE `/api/statuses/:id?reassignTo=` · POST `/api/statuses/reorder` | `StatusCreateInput` · `StatusUpdateInput` · `ReorderInput` | `StatusDTO` |
| GET/PATCH `/api/settings` | `SettingsUpdateInput` | `Settings` |
| GET `/api/data/export` | – | `ExportDTO` (attachment `lyren-export-YYYY-MM-DD.json`) |
| POST `/api/data/import` | `ExportDTO` | `{ ok, counts, backupFile }` (§5.10) |
| GET `/api/data/backup` | – | SQLite snapshot (attachment `lyren-backup-YYYY-MM-DD.db`, see below) |
| GET `/api/dashboard?today=` | – | `DashboardDTO` (lists capped at 50 / 20; `counts` = uncapped totals per list, `inProgressProjects` = distinct projects with started tasks) |
| GET `/api/search?q&limit` | `SearchQueryInput` | `SearchResultDTO` (tasks of every project, archived tasks included and ranked after live ones at equal relevance) |

Backup: `db.backupTo(path.join(config.dataDir, '.backup-<random>.db'))` → strip the `sessions` table from the
copy → stream with `Content-Type: application/vnd.sqlite3` → always unlink the temp file. Never read the live
database file (WAL mode). `HEAD` answers with the headers only and takes no snapshot (a body-less response
would never close the stream).

Boards: `projectId` is immutable (create only). For project boards the server forces
`config.filter.projectIds = [projectId]` on create/update/duplicate. `GET /api/boards` returns all boards.

### Filter semantics (`TaskFilter`, implemented by `matchesTaskFilter` in shared/src/filter.ts)
All present criteria are ANDed; within an array values are ORed; **an omitted or empty array means "no
constraint"**. `ids` restricts the result to those tasks (the palette refreshes its Recent list with it).
`null` inside `milestoneIds`/`epicIds`/`tagIds` means "has none". `tagMode: 'all'` requires
every listed (non-null) tag (only `[null]` → untagged). `due` presets are ORed and resolved against the
request's `today`/`weekStartsOn` (`overdue` excludes closed tasks). `search`: every whitespace token must
appear (case-insensitive) in title, description or ref. `archived`: default `exclude`. `closedWithinDays`:
0 hides every closed task; N>0 keeps closed tasks with `completedAt >= now − N days` (closed with NULL
completedAt count as recent) — SQL: `NOT closed OR (:n > 0 AND (completed_at IS NULL OR completed_at >= :cutoffIso))`.
Projects with status `archived` are excluded unless listed in `projectIds` or `includeArchivedProjects` is
true. Sorting: `compareTasks` (same file). The server SQL must match these functions exactly (the
server-domain tests cross-check them on randomized data).

---------------------------------------------------------------------------------------------------------

## 8. Boards

A board = name + description + optional `projectId` + `BoardConfig` (shared/src/board.ts; always parse with
`boardConfigSchema` / `parseBoardConfigLenient`). Global boards (`projectId` null) are listed on /boards;
project boards on the project's Board tab (several per project, ordered by position, switchable as tabs).
For project boards the effective filter always has `projectIds = [projectId]`, and the editor hides
"project" grouping and the project filter.

**Saving**: config edits on a saved board (config panel, collapsing/reordering/hiding groups, card options)
**auto-save** (debounced ~400 ms via the optimistic `useUpdateBoard`). "Duplicate" exists for experiments.
**Quick filters** in the board header (text search, tags, priorities, assignee-free "hide closed" toggle)
are view state in URL search params (`?q=&tags=1,2&pri=3,4&closed=0`), ANDed with `config.filter`, never
saved. Below md, tags, priorities and "hide closed" sit in a "Filters" sheet behind one button that shows the
number of active ones (`quickFilterCount`), so the search, the filters and the board buttons fit in one row.
That button is not part of the scrolling strip (it can't scroll away or sit under the fade); it shows only its
icon / count below 22rem and while the search is in use (a query set or being typed); a set query shrinks to
the room left (the project Board tab's row also holds Configure and ⋯) and gets the active-filter look; while
the search has focus the list toggle and Select step aside so it gets the row, Filters staying at hand.
A project's Board tab with no saved boards renders `defaultBoardConfig({ filter: { projectIds: [id] } })`
and the first config change creates a project board named "Board" (nothing is lost).

**Data flow**: fetch with `useTaskQuery({ filter: effectiveFilter, sort: config.sort, today, weekStartsOn,
limit: LIMITS.queryLimitMax })`. Derive the view from the cached result as
`tasks.filter(t => matchesTaskFilter(t, effectiveFilter, fctx)).sort((a, b) => compareTasks(a, b, sort, sctx))`
(equals server order when nothing is pending, and makes optimistic edits move cards immediately), then group
stably. When `total > tasks.length` show "Showing N of M tasks — narrow the filter".

### 8.1 Groups
Keys: see the table at the end of board.ts. A task with several tags appears in several tag groups.
Custom grouping: `customGroupKey()` (first match, archive defaults ignored), else `'__other'`.

**Enumeration** (`enumerateGroups(field, axis, filter, lookups, tasks)` in features/boards/grouping.ts,
unit-tested) — natural order, then restricted by the filter:
| field | natural order & scope |
|---|---|
| status | by position; ∩ filter.statusIds; ∩ category ∈ filter.statusCategories (each when non-empty) |
| statusCategory | STATUS_CATEGORIES order; only categories with ≥1 status; ∩ filter.statusCategories; ∩ categories of filter.statusIds |
| priority | 4, 3, 2, 1, 0; ∩ filter.priorities |
| project | by position; filter.projectIds if non-empty, else non-archived projects (all if includeArchivedProjects) |
| milestone / epic | entities of the in-scope projects (project position, then own position); ∩ filter.milestoneIds / filter.epicIds (epics also ∩ milestoneId ∈ filter.milestoneIds when set). Completed/cancelled milestones and done/cancelled epics only when they have tasks in the result. `none` only when the id filter is empty or contains null |
| tag | by name; with non-empty tagIds and tagMode 'any' only the listed tags; minus excludeTagIds; `none` only when tagIds is empty or contains null |
| due | DUE_BUCKETS order (`dueBucket(due, today, ws, closed)`; closed past-due tasks go to `past`) |
| custom | array order of `custom`, then `__other` (when showUnmatched) |

`none` and `__other` come last. A key present in the tasks but not enumerated (stale data) is appended, so
tasks never disappear. Then apply the axis prefs for the current field (`activePrefs(axis)`): `order`
(listed keys first in that order; ignored for custom), `hidden`, `collapsed`.
Visible(g) = not hidden && (g.key !== 'none' || showNone) && (count > 0 || showEmpty); custom columns are
always visible unless hidden; empty lanes hidden unless swimlanes.showEmpty. The header shows
"N tasks in hidden groups" when applicable.

**WIP**: `wipLimits[key]` (columns only) counts tasks in the column across all lanes. Header shows `7 / 5`
with a warning icon and visually-hidden text "over WIP limit" when exceeded (soft; never blocks).

### 8.2 Drag & drop
A drop from cell (srcLane, srcCol) to (dstLane, dstCol) sends `colPatch(srcCol→dstCol) ∪ lanePatch(srcLane→dstLane)`;
an axis whose key is unchanged contributes nothing. One pure function, unit-tested:
`computeDropPatch(config, ctx, task, from: {lane, col}, to: {lane, col}) → TaskUpdateInput | null` (null = not
droppable). If a changed axis is not droppable, or the merged patch sets the same field twice, or sets
projectId together with an epic of a different project, the target is not droppable (rendered disabled
while dragging). Per-axis patches:
| field | patch for src → dst |
|---|---|
| status | `statusId` = dst |
| statusCategory | `statusId` = first status (by position) of the dst category that `filter.statusIds` allows (when set), else the first of the category (`categoryTargetStatus`) |
| priority | `priority` = dst |
| project | `projectId` = dst (server clears the epic) |
| epic | `epicId` = dst or null for `none` (may move the task to the epic's project); `none` inside a project lane = `{ projectId: lane, epicId: null }` |
| milestone | not droppable across groups (milestone comes from the epic) — reorder only |
| tag | dst `none` → `tagIds: []` ("Remove all tags"); src `none` → `addTagIds: [dst]`; else `removeTagIds: [src], addTagIds: [dst]` |
| due | `dueDate = dueBucketDropDate(dst, today, ws)`; `undefined` = not droppable (past/overdue/later) |
| custom | `resolveDropPatch(dst.onDrop)`; plus `removeTagIds` = src.onDrop.addTagIds − dst.onDrop.addTagIds when src is custom; `__other` and `onDrop: null` are not droppable; `onDrop: {}` = reorder-only. After patching, if `customGroupKey(applyTaskPatch(task, patch))` ≠ dst, still send it and toast "Moved — it now matches “<group>”". |

Feedback and Undo: a drop into another cell (and a card-menu "Move to column / lane") shows a success toast
naming the target ("Moved WEB-7 to Payments · Todo", or the custom landing message above; after a move to
another project also the new ref: "… (now ME-5)", `withNewRef`) with **Undo**, which applies
`inverseTaskPatch(task, patch)` (api/tasks.ts: the old values of every changed field; project and epic
together — the server gives the task its old number back, §5.5; the full tag set; after a manual-sort drop
the old rank, `position: { rank }`, so the card returns to its exact place in the global order even when it
was alone in its cell). Reordering within a cell shows no toast. Above the dragged card the DragOverlay shows
"→ Lane · Column" on boards with lanes, "Can't move here" over a cell that can't take it, and "Release to
cancel" while the pointer is off the board (any layout).

Phones with lanes stack each column's lanes separately, so the lane under the finger in another column is
arbitrary: a **touch** drag that enters another column keeps the card's own lane (`keepLaneTarget` in
features/boards/laneKeep.ts, unit-tested) and scrolls that lane's cell under the finger, until the finger moves
vertically more than `LANE_SLOP` (32px) inside that column; from then on the cell under the finger is the
target. Nothing may change the layout when a drag starts: "Add task" rows are hidden (not removed) while
dragging, and an empty lane's one-row header on phones is itself the drop target (it does not expand).

Ordering: only when `sort.field === 'manual'`. Neighbours are the cards directly above/below the drop point
**in the target cell** (lane × column) of the rendered list. dir `asc`: `{ afterId: above, beforeId: below }`;
dir `desc`: `{ afterId: below, beforeId: above }`. Both null (empty cell, collapsed group, header) → omit
`position`. With other sorts, never send `position` (cards can only move between groups). A multi-tag
card's rank is global, so reordering it also changes its order in its other tag groups (expected).
Draggable/sortable ids are `${laneKey}|${colKey}|${taskId}`; read the source keys from the active id.

### 8.3 Layouts and mobile
- **Kanban (≥ md)**: horizontal scrolling columns (~18–19rem); collapsed columns render as a narrow vertical
  strip (name + count); lanes are collapsible horizontal bands with aligned columns.
- **Kanban (< md)**: columns `w-[85vw] max-w-[22rem]` in one horizontal scroller with
  `scroll-snap-type: x mandatory` and `snap-start` columns; a sticky strip of column chips (name + count)
  jumps to a column. Swimlanes render as collapsible sections inside each column (no 2-D grid). A per-device
  "Show as list on this device" toggle (localStorage) switches to list layout.
- Every board scroller is `position: relative`, so absolutely positioned descendants (sr-only labels) can't
  escape its clipping and make the page scroller around the board scrollable (drag auto-scroll would then
  scroll the page sideways instead of the board).
- **List layout**: one collapsible section per column group (same order/hidden/collapsed/showEmpty/showNone
  and WIP badge), rows show `card.fields` inline (domain TaskRow), swimlanes ignored (editor disables lane
  controls). Dragging rows between sections uses only the column patch. (Boards do NOT use features/tasks
  TaskList; they render their own groups with domain components.)
- **DnD sensors**: MouseSensor `{ distance: 4 }`, TouchSensor `{ delay: 250, tolerance: 8 }`, KeyboardSensor with
  sortableKeyboardCoordinates. Never PointerSensor with `touch-action: none` on cards (it blocks scrolling).
  Collision: off the board — outside BoardView's `data-board-area` element, except past an edge it shares with
  the window (the bottom counts up to the phone tab bar / offline banner, `data-bottom-chrome`, so a finger
  pushed onto the tab bar still auto-scrolls and drops; `isOverBoard` in `pointerTarget.ts`, unit-tested) —
  nothing, so releasing over the sidebar, the header or a toolbar cancels the drag ("not moved"). On the board: the droppables under the pointer; over none
  (a gap, or past the board's edge while it auto-scrolls) the nearest column to the pointer, then the nearest
  cell in it (`nearestToPoint`) — not the droppable nearest the dragged card's corners, which reach into the
  next column. Keyboard drags (no pointer) use closestCorners.
  Cards: `touch-action: manipulation; -webkit-touch-callout: none; user-select: none`, open on click (not an
  `<a href>`), `navigator.vibrate?.(10)` on drag start, DragOverlay, edge auto-scroll.
- **Long-press is reserved for drag**: on touch, each card shows an always-visible "⋯" button (TaskActionsMenu
  with board `extraItems`: "Move to column ▸", "Move to lane ▸" (droppable targets via computeDropPatch),
  and with manual sort "Move to top/bottom of column"). Multi-select is an explicit "Select" mode whose
  Actions menu is the task lists' bulk menu (`useBulkTaskActions`, §9.1). Below 22rem its bar shows the
  count without "selected" and an icon-only Actions button, so Clear, Actions and Done fit at 320px.
- **Performance**: React.memo cards with stable props; each cell renders its first cards with "Show N more"
  (adds 50): without swimlanes the first 50 per cell; with swimlanes the visible, expanded, non-empty cells share
  a ~300-card budget, 5–50 per cell (`cellPageSize` in grouping.ts). On phones with swimlanes only the column in
  view and its neighbours render cards; the others show lane headers and mount when scrolled or jumped to.
- **Cards**: the description preview (card field `description`) is one line in compact density and two in
  comfortable.
- **Quick add**: "+" per column/cell calls `openCreateTask(defaults)` with the cell's patch as create
  defaults (statusId, priority, epicId, dueDate, tagIds = addTagIds; projectId from the lane/column project,
  else the board's project / filter.projectIds when it has exactly one entry).

---------------------------------------------------------------------------------------------------------

## 9. Web conventions

- **Data**: use the hooks in `web/src/api/*` (they define keys and invalidation). Read projects, milestones,
  epics, statuses, tags, boards, settings and the user from `useLookups()` (bootstrap, memoized per payload) —
  never refetch them per page. Mutations already invalidate the right caches; show `toast.error(err)` on failure.
- **Navigation model**: ≥ md: collapsible left sidebar (Dashboard, Projects list, Boards list, Activity,
  Work log, Settings; search + new-task buttons; user menu). < md: bottom bar (h-14 + safe area) with
  Home (dashboard) · Projects · Boards · Search (palette) · More (sheet: Activity, Work log, Settings, theme,
  sign out; also opened by the 'toggle-nav' event; it rests on top of the bar, which stays usable by touch:
  More closes it again, the other tabs leave it. While the sheet is shown the bar is aria-hidden and out of
  the Tab order, and the sheet has its own Close button (first Tab stop; Esc works too)), plus a floating "+"
  above the bar, hidden while a sheet is open. New-task defaults (the "+", `c`, the sidebar's New task and the
  palette's) come from `createTaskDefaults` (components/layout/navigation.ts), read when the action fires:
  the task open in the drawer (`?task=`) or on its `/tasks/:key` page first (its project, and its epic when
  that belongs to the project), else the page's project / epic / board.
- **Scrolling**: pages scroll the DOCUMENT (so mobile browser toolbars collapse and tap-status-bar works):
  sticky headers use `top-0` + safe-area padding; main content gets bottom padding for the bottom bar on
  mobile. Only board pages use a fixed-height layout (`100dvh`-based, never `vh`) with an inner scroller.
- **PageHeader**: every page renders one; nested pages (project sub-pages, milestone, epic, task, settings
  sections) pass `backTo` so installed PWAs (no browser back button) can navigate up.
- **Task drawer** (`?task=<id>` via `useOpenTask()` / `useCloseTask()` in lib/taskLinks.ts, which handle
  history): ≥ md a NON-modal right panel (~36rem, no scrim; the page stays interactive; clicking another card
  swaps the task; Esc closes; focus moves to the title on open and back to the origin on close). < md a modal
  full-screen sheet with ← (close), the ref and "⋯" (TaskActionsMenu). The comment composer is sticky at the
  bottom of the drawer's scroll container.
- **Overlays**: every dialog/drawer/sheet/menu/popover registers with `useOverlay()` (lib/overlays.ts): only
  the top overlay handles Esc; single-key hotkeys are suppressed while any overlay is open; full-screen
  sheets on phones use `history: true` so Back closes them (and call `dismissForNavigation()` before closing
  due to a navigation). Confirm before discarding a non-empty create-task or comment draft.
- **Toasts** draw above every overlay (z-60) so Undo / Open stay reachable, and move out of an open panel's
  way (`placeToasts` in components/ui/toastPlacement.ts; components/ui/README.md): the usual spot when no panel
  is there, else right above a bottom sheet or centred card, else beside the docked desktop drawer, else
  inside a full-screen panel in the free band nearest the usual spot (no control under it), else the top
  edge. Panels are measured where they settle (untransformed box), and the stack is re-placed when toasts
  come or go, a panel opens, finishes its enter transition, resizes, changes content or gets focus, and on
  window resize — never while a panel scrolls. TaskList's bulk bar lifts the usual spot above itself
  (`--selection-bar-h`).
- **Global UI**: `openCreateTask(defaults)`, `openCommandPalette()`, `emit('toggle-nav', {})` (lib/events.ts).
  Global hosts (TaskDrawerHost, TaskCreateDialogHost, CommandPalette) stay tiny and eagerly mounted (they must
  subscribe at startup) but lazy-load their heavy content (`lazy(() => import(...))`) on first open; prefetch
  the task drawer chunk when idle.
- **Offline / network**: mutations fail fast when offline (queryClient `networkMode: 'always'`) → roll back
  + toast "Could not reach the server". AppShell shows a thin "Offline — changes can't be saved" banner
  (navigator.onLine / onlineManager). Forms keep their content when a submit fails. Unsent drafts (comment,
  work log, create-task) may be kept per task in sessionStorage. `localStorage` only for per-device prefs
  (theme, sidebar collapsed, last-used project, per-device board list toggle, recent items).
- **Styling**: Tailwind utilities with the semantic tokens in `web/src/index.css` (`bg-surface`, `text-fg-muted`,
  `border-border`, `bg-accent text-accent-fg` …). Never hard-code grays/blacks/whites for UI chrome — both
  light and dark themes must look right. Entity colors (user data) via inline style + lib/colors.ts.
  Icons: lucide-react, 16px default (`size-4`), `aria-hidden` when decorative.
- **Markdown** (components/ui/Markdown): react-markdown + remark-gfm, never raw HTML; links get
  `target="_blank" rel="noopener noreferrer"`; images whose src is not same-origin/data: render as a link with
  the alt text (CSP blocks remote images anyway). Lazy-load the renderer with a plain-text fallback.
- **Components**: build on `components/ui` and `components/domain`; don't re-implement buttons, dialogs,
  menus, pickers or task cards in feature code. §9.1 lists the cross-team contracts.
- **Mobile first**: design for 360–430px widths first, then `md:` (≥768px) for desktop. Touch targets
  ≥ 40px. No hover-only affordances. Dialogs/drawers become full-screen or bottom sheets on mobile (the UI
  kit handles this). Respect safe areas (`pt-safe`/`pb-safe`). Horizontal scrolling only inside explicit
  containers (boards). Inputs ≥ 16px font on mobile (index.css handles it).
- **Accessibility**: semantic elements, labels for every input, `aria-label` on icon-only buttons,
  keyboard reachable menus/dialogs (Esc closes, focus trapped in modals and restored), visible focus rings,
  color never the only signal (status icons have shapes, overdue has text, WIP has text).
- **Pages** default-export their component (lazy routes in app/App.tsx) and set `document.title` via
  `useDocumentTitle()`. Empty/loading/error states everywhere (`EmptyState`, `Skeleton`/`Spinner`, `ErrorState`).
- **Optimistic UI**: task edits via `useUpdateTask` are optimistic (cards move immediately); board config
  edits via `useUpdateBoard` are optimistic and serialized.
- **Dashboard**: tiles and section badges show `DashboardDTO.counts` (exact totals) and "Across N projects"
  `inProgressProjects`. A section shows 5 rows, then all rows of its list; when `counts.x` exceeds the capped
  list, expanding loads the whole section once (`useFullSection`: POST /api/tasks/query with the section's
  filter, limit `LIMITS.queryLimitMax`, sorted by `compareDashboardTasks` = the server's dashboard order) and
  renders it 200 rows per "Show N more". (Paging through the server's sort would not be a prefix of the
  dashboard order.) A failed load keeps the rows shown and offers Retry.
- **Command palette**: archived tasks (search results and Recent) carry an "Archived" label. The Recent list
  (localStorage, `features/search/recent.ts`) is read once per opening and refreshed from the server with one
  `POST /api/tasks/query { filter: { ids, archived: 'include', includeArchivedProjects: true } }`: labels,
  refs and titles follow the server, and tasks it no longer returns (deleted) are dropped, in storage too.
- **Editing text**: the task description saves on blur, mod+Enter and Esc; only its Cancel button discards
  (asking when changed). Closing the drawer (Back, ←, ×, another task) while editing an existing comment or
  work-log entry saves the edit; only Cancel (or Esc in a comment) discards it, and a changed comment asks first.
- Keyboard shortcuts: `c` new task, `mod+k` and `/` search, `?` shortcuts help, `Esc` close (top overlay).

### 9.1 Cross-team component contracts
- `MenuItem` (components/ui/Menu): `{ label: string; icon?: ReactNode; onSelect?: () => void; danger?: boolean;
  disabled?: boolean; checked?: boolean; hint?: string; items?: MenuItem[] } | { separator: true } | { heading: string }`;
  `<Menu trigger={ReactElement} items={MenuItem[]} />` — anchored dropdown ≥ md, bottom action sheet on touch.
- `PageHeader` (components/layout): `{ title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; backTo?: string;
  breadcrumbs?: {label, to?}[]; actions?: ReactNode; menu?: MenuItem[]; tabs?: {to, label, end?, count?}[] }`.
- `Dialog`, `Drawer`/`Sheet`, `useConfirm()` (`(o: {title, body?, confirmLabel?, danger?, typeToConfirm?}) =>
  Promise<boolean>`), `EmptyState {icon?, title, body?, action?}`, `ErrorState {error, onRetry?}`,
  `Skeleton`, `Spinner`, `Markdown {source}`, `MarkdownEditor {value, onChange, onSubmit?, onCancel?, placeholder?}`,
  `toast` — documented in components/ui/README.md.
- Domain (components/domain/README.md): `TaskCard {task, fields?, density?, colorBy?, onOpen?, extraMenuItems?, selected?, dragging?}`
  (React.memo); `TaskRow {task, hide?, fields?, onOpen?, selectable?, selected?, onSelectedChange?, extraMenuItems?}`
  (React.memo); `useTaskActions(task, extra?) → MenuItem[]` + `TaskActionsMenu {task, extraItems?}` (Status ▸,
  Priority ▸, Move to project/epic ▸, Due ▸, Tags…, Duplicate, Archive, Delete) — the shared non-drag
  alternative; pickers `StatusPicker`, `PriorityPicker`, `TagPicker {allowCreate}`, `EpicPicker {projectId}`,
  `MilestonePicker {projectId}`, `ProjectPicker`, `DateField`; display `StatusIcon`, `PriorityIcon`, `TagChip`,
  `ProjectBadge`, `EpicBadge`, `DueDateLabel`, `ProgressBar`.
- Timeline (features/timeline): `TaskTimeline {task}` (segmented: Comments (default) · Work log · History, with
  counts, sticky composer), `ActivityFeed {projectId?, limit?, compact?, paginate?}`, `ActivityItem {entry,
  compact?, showTask?, showProject?}` (the dashboard and the activity feeds render entries with it; it and the
  task History panel build their sentences from `activityPhrases` in activityText.ts) and pure
  `describeActivity(entry, lookups): string` (a unit-tested plain-text helper; no page uses it).
- Tasks (features/tasks): `TaskList` (props in its file), `TaskDrawerHost`, `TaskCreateDialogHost`, `TaskPage`.
  TaskList's toolbar has per-list "Show closed" and "Show archived" toggles (seeded from the filter, not
  persisted; below the 44rem container they read "Closed" / "Archived" and wrap onto their own line when the
  buttons don't fit). An empty list says when everything in it is closed or archived and offers to show it
  (toolbar-less lists too). `useBulkTaskActions(tasks, { onDeleted })` (features/tasks/bulkActions.tsx) is the
  one bulk menu — status, priority, due date, Set epic (single-project selections), add/remove tags,
  Archive/Unarchive (each only on the tasks it changes), Delete — used by TaskList's `BulkActionBar` and by a
  board's select mode.
- Boards (features/boards): `ProjectBoardPage` (route), `BoardView` used internally.

---------------------------------------------------------------------------------------------------------

## 10. Testing & verification (every agent)

- Typecheck your area: `npx tsc -p tsconfig.server.json` and/or `npx tsc -p tsconfig.web.json`. Other agents
  work in parallel, so errors in files you don't own may appear — ignore those, but your files must be clean.
- Server: API tests for every endpoint you own — happy paths, validation (400), not found (404), conflicts,
  activity entries written, edge cases from §5. `npx vitest run server/test/<yours>.test.ts`.
- Web: unit tests for non-trivial pure logic (`*.test.ts` next to it, node environment).
- **Do not** run `npm install`, `npm run build`, or write into `dist/`. To check a web build, use
  `npx vite build --config web/vite.config.ts --outDir <your scratch dir>/web-build --emptyOutDir`.
- If you start a server for manual testing, use your own `PORT` and `DATA_DIR` (in your scratch dir) and stop
  it. First-run setup needs the setup code printed in the server log (or set `SETUP_TOKEN=test`).

## 11. Sample data (`createSampleData`)
Project "Website Relaunch" (key WEB, active): milestones "MVP launch" (active, due today+21) and
"Post-launch polish" (planned, due today+60); epics "Design system", "Content migration" (MVP),
"Performance" (polish), "Analytics" (no milestone); ~16 tasks across all statuses, priorities and due
dates (some overdue, some due today/this week), tags `bug`, `idea`, `blocked`, `quick win`; a few comments
and work logs; activity entries for creations. Project "Personal" (key ME): 4 tasks without epics.
A project board "WEB board" for WEB (columns by status, swimlanes by epic) and a global board
"Priority triage" (columns by priority, swimlanes by project, hide closed after 7 days).

## 12. Deployment
- `npm ci && npm run build && npm start` → http://localhost:8080. Env: see `node dist/server.mjs help`. A
  single-file desktop app is built from the same sources (§12.1).
- `dist/` is self-contained (server bundle + web assets); only Node ≥ 22.13 is needed at runtime. When
  `WEB_DIR` is set but has no `index.html`, the server logs "Web client not found: no index.html in <dir>"
  (and keeps serving the API), and app routes answer 503 with a short self-contained HTML page saying so
  (no paths in it); a later build is picked up without a restart.
- Start-up failures a self-hoster can fix are printed as plain lines, not stack traces (`startupErrors.ts`): an
  invalid env value (exit 2), a database that can't be opened for permission reasons (path, uid and a
  `chown` hint; exit 1), a data directory that can't be created because its drive or a parent is missing
  (ENOENT) or a file stands in the way (EEXIST/ENOTDIR, naming the file; `fileInTheWay`), a Windows path too
  long for SQLite (CANTOPEN with a folder of ≥ 248 characters; exit 1), and listen errors (port in use,
  privileged port, bad HOST; exit 1). Only unknown causes (a failed migration, a corrupt file) add the stack.
- **First run**: the server prints a one-time **setup code** to its log (or use `SETUP_TOKEN`); the setup
  page asks for it, so a freshly exposed instance can't be claimed by someone else.
- Docker: multi-stage `Dockerfile` (node:24-alpine), volume `/data`, non-root user (uid 1000), healthcheck on
  `/api/health`. Bind mounts need `chown 1000:1000` (or `user:` in compose).
- Behind a TLS reverse proxy set `TRUST_PROXY=true` (secure cookies + real client IPs from the RIGHTMOST
  X-Forwarded-For entry) and publish the port only on localhost (`127.0.0.1:8080:8080`) so clients can't
  bypass the proxy.
- Backups: Settings → Data (download), or `node dist/server.mjs backup <file>` (safe while running; e.g.
  `docker exec lyren-plan node dist/server.mjs backup /data/backups/x.db` from cron). Restore: stop the server,
  replace `lyren.db`, DELETE `lyren.db-wal` and `lyren.db-shm`, start.
- Upgrading: pull/build/restart (`docker compose build --pull && docker compose up -d`); migrations run
  automatically on start after writing a snapshot `lyren-v<N>-before-upgrade-<timestamp>.db` to `backups/` next
  to the database file (`DATA_DIR/backups/` unless `DB_PATH` is set); an older build refuses a newer DB.
- Snapshot retention (`db/snapshots.ts`): after writing an automatic snapshot, keep the newest `SNAPSHOT_KEEP`
  (default 10; 0 = keep all) of that kind — pre-import and pre-upgrade counted separately — and delete the
  rest. Only regular files whose whole name matches the kind's pattern are candidates (user backups, renamed
  copies, symlinks and directories are never touched); the new snapshot always stays; "newest" is the
  timestamp in the name; failures are logged and never fail the import or the start-up.
- Lost password: `node dist/server.mjs reset-password <username>` (prints a random password, or pipe one in;
  a piped password must pass `passwordSchema`, 8–256 characters, else exit 2 and nothing changes).
- File permissions: `index.ts` (and `sea.ts`) set `process.umask(0o077)` for the server and every CLI command, and the DB
  layer creates its directories with mode 0700, so DATA_DIR, backups/, the database, WAL and snapshots are
  owner-only.
  On Windows modes are ignored and a new folder inherits its parent's ACL (a drive root grants Users read and
  Authenticated Users modify). The desktop app therefore gives the folder of the database a protected DACL when
  it creates it (`desktop/folder.ts`: `icacls <dir> /inheritance:r /grant:r *<user SID>:(OI)(CI)F
  *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`, SID from `whoami /user`, both by absolute path, no shell; a
  failure, e.g. FAT, is a banner warning). An existing folder is never changed: when its SDDL (`icacls /save`)
  has an allow ACE with read/write/generic/full rights for Everyone, Users, Authenticated Users, Interactive,
  Domain Users or Guests, the banner warns and prints the icacls command that makes it private (for Command
  Prompt, a trailing backslash doubled; for PowerShell, single-quoted (`psArg`, a trailing backslash doubled when
  the path has whitespace), when the path has a `%`: `commandShell`, see `stop`; measured: icacls accepts both the
  single trailing backslash 5.1 then hands it and the doubled one PowerShell 7 would). icacls is not long-path aware (measured: a folder path of 259 characters works, 260 fails, and `/save`
  then exits 0 with an empty file), so a path of MAX_PATH (260) characters or more is passed, and printed, as
  `\\?\<path>` (`\\?\UNC\<server>\<share>\…` for a UNC path; `icaclsPath`); an empty `/save` gives no verdict.
- Static serving (`http/static.ts`): one handler over a `StaticSource` — `diskSource(webDir)` (dist/web or
  WEB_DIR; unhashed files re-validated by mtime, no ETag) or `memorySource(files)` (the embedded client; strong
  ETag per file, `<etag>-gz` for the gzip body, If-None-Match → 304). Same rules for both: `/assets/*`
  `public, max-age=31536000, immutable`, everything else `no-cache`; gzip for text files > 1 KiB with
  `Vary: Accept-Encoding`; HEAD = GET headers without body; extension-less unknown paths → index.html; other
  unknown paths 404; only canonical paths are looked up; the missing-client 503 page. The disk cache is keyed
  by resolved path, case-folded on win32/darwin, and on Windows paths the file system would rewrite (trailing
  `.`/space in a segment, `:` streams) or that may be an 8.3 short name (any `~`) are never looked up, so URL
  aliases can't grow it. A web folder at a drive or file-system root (`W:\`, `/`) works (the root already ends
  with the separator).
- Windows file-system rules (all code): never rename over or delete a file that may be open (SQLite opens
  without FILE_SHARE_DELETE); the backup-download temp copy (`DATA_DIR/.backup-<16 hex>.db`) is unlinked while
  Node holds it open (allowed: libuv shares delete access) and again on stream close, and any copy left by a
  crash is deleted at the next start (`removeStaleBackupTemps`); snapshot pruning tolerates EBUSY/EPERM (logged,
  retried at the next prune); `VACUUM INTO` targets are bound parameters (any path, spaces, non-ASCII); state
  files are rewritten in place; piped passwords lose one trailing LF or CRLF and a leading BOM, and must be
  valid UTF-8 (cmd.exe pipes in the OEM code page): otherwise `reset-password` changes nothing and exits 2
  with a `chcp 65001` hint (on win32 a piped password containing `?` gets a PowerShell 5.1 warning). SQLite
  gets `\\?\` paths on win32 (`db/index.ts` `sqlitePath`: the database, `stripSessions`, `VACUUM INTO`
  targets), because its VFS passes names to CreateFileW unchanged and MAX_PATH (260) would otherwise break
  long data folders and the snapshots in them.

### 12.1 Single-file desktop app

- **Build**: `npm run package:win` (`scripts/package.mjs --target win-x64`; also `win-arm64`, `linux-x64`,
  `linux-arm64`; `npm run package:linux` = linux-x64) → `dist/lyren-plan-<version>-<target>[.exe]` + `.sha256`.
  Steps: `npm run build` (unless `--no-build`); esbuild bundles `server/src/sea.ts` as ONE CommonJS file
  (format cjs, no top-level await, no import.meta, no warnings allowed; SEA's require() loads built-ins only);
  every dist/web file except `*.map` becomes SEA asset `web/<path>` plus `lyren/manifest.json`
  (`{format:1, version, builtAt, files:[{path,key,size,sha256,etag}]}`); `sea-config.json` with
  `useSnapshot:false, useCodeCache:false` (portable blob), `disableExperimentalSEAWarning:true`,
  `execArgv:["--disable-warning=ExperimentalWarning"]`, `execArgvExtension:"none"` (NODE_OPTIONS ignored); blob
  from `node --experimental-sea-config` of the running Node (= target version); official node binary of that
  version from nodejs.org (or `LYREN_NODE_MIRROR`), SHA-256 verified against `SHASUMS256.txt`, cached in
  `.cache/node/<version>/`, or `LYREN_NODE_BINARY` (+ optional `LYREN_NODE_SHASUMS`) offline; Windows: strip
  the Authenticode signature (clear the certificate-table directory entry, truncate the table); inject with
  postject (`NODE_SEA_BLOB`, fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`); Windows: then set icon
  (scripts/lib/icons.mjs) and VERSIONINFO with resedit (after postject: resedit before it moves .reloc, which
  LIEF rejects), add `consoleAllocationPolicy` `detached` (xmlns `http://schemas.microsoft.com/SMI/2024/WindowsSettings`)
  to RT_MANIFEST 1 (`scripts/lib/manifest.mjs`: inserted as bytes, every other byte of node.exe's manifest kept
  (asInvoker, supportedOS, any windowsSettings); inside an existing `windowsSettings`, else in a new
  `<application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings>` before `</assembly>`; refused when
  already present; the image stays IMAGE_SUBSYSTEM_WINDOWS_CUI (3)) and recompute the PE checksum; Windows targets
  also embed `lyren/tray-icon.ico` (the app icon at 16, 20, 24, 32, 40, 48 px) as a SEA asset; Windows, optional: sign (below); self-test `help` when the
  target runs on the build host; then write `.sha256` (the old one is removed before the new exe is written, so
  a build that fails after that leaves none). Not part of `npm run check`; its pure helpers are (scripts/test).
  The SEA main script is `lyren-plan.cjs` and every sea-config path is relative to the work folder (the
  generator's cwd), so stack traces show `lyren-plan.cjs:<line>`; the build fails when the exe contains the
  checkout path or the home folder (either slash, UTF-8 or UTF-16; `buildPathNeedles`), checked before signing.
  `npm run build` runs as `node $npm_execpath run build` under npm (no shell), else as `npm run build` (on
  Windows one shell command string: no DEP0190) (`scripts/lib/npm-run.mjs`, also used by `scripts/dev.mjs`,
  which stops each npm's whole process tree, `taskkill /T` on Windows).
- **Signing** (`scripts/lib/sign.mjs`, Windows targets; Linux targets ignore it with a note):
  `LYREN_SIGN_CMD` = a command template run WITHOUT a shell: split at spaces/tabs, `"…"`/`'…'` group and are
  removed, no escapes (backslashes literal), or a JSON array of strings when it starts with `[`; `{file}` (the
  exe, required) and `{out}` (optional separate output, moved over the exe afterwards) are replaced in every
  word. Validated before the build starts; no error message quotes the value (it may hold a password: a JSON
  syntax error reports at most a character position, never V8's excerpt). A template whose program is cmd(.exe)
  is refused when the `{file}`/`{out}` path has one of `& | < > ^ % , ; =` (cmd.exe re-parses its command line);
  README recommends `powershell.exe -NoProfile -ExecutionPolicy Bypass -File sign.ps1 {file}` for scripts.
  Runs after the PE checksum update (stdio inherited); then
  `verifySignedImage`: a certificate table at the old end of file (8-byte aligned, zero padding only), holding a
  WIN_CERTIFICATE rev 2.0 / PKCS_SIGNED_DATA, and every byte before it unchanged except the PE checksum and the
  certificate-table directory entry; the SEA blob and the set fuse still present. Any failure fails the build:
  the unsigned bytes are written back over the exe and `{out}` is removed (a signer may have changed the file
  before failing), no `.sha256`. The self-test runs on the signed exe and `.sha256` is of the signed file.
- **Self-test** (`scripts/lib/self-test.mjs`): Windows targets are first checked to be PE images whose COFF
  Machine is the target's (0x8664 / 0xAA64), on every build host. The self-test passes on exit 0 with
  `Lyren Plan <version>` in stdout. On win32 a spawn error UNKNOWN/EACCES/EPERM with status null
  (`refusedToStart`) hides the Win32 error (libuv reports a policy block and a broken image, 216/193, alike as
  UNKNOWN), so `windowsStartError` starts the exe once more through Windows PowerShell and .NET
  (`Process.Start`, UseShellExecute off; path in an environment variable, script via -EncodedCommand) and reads
  `NativeErrorCode`. Only a policy error (`POLICY_BLOCK_ERRORS`: 1260, 4551, 4556-4559, 4580-4583), or
  "Device Guard" / "Application Control policy" text in the output, counts as a block, which is not a build
  failure: it prints why (unsigned, or signed but not trusted), keeps the exe, writes `.sha256` and exits 0, or 3
  with `--require-self-test`. Any other failure (another or an unknown Win32 error included) names the spawn
  error / signal / exit code, the Win32 error and the output (never "undefined"), writes no `.sha256`, exits 1.
- **Node binary verification** (`scripts/lib/node-dist.mjs`): the expected SHA-256 comes from
  `scripts/lib/node-hashes.mjs` for pinned versions (v24.19.0, all four targets; values from a SHASUMS256.txt
  whose signature was checked against the Node.js release keys), else `LYREN_NODE_SHASUMS`, else SHASUMS256.txt
  from `https://nodejs.org/dist` (cached as `SHASUMS256.nodejs.org.txt`), never from the mirror.
  `LYREN_NODE_MIRROR` is a transport only and must be https (http only with `LYREN_NODE_ALLOW_HTTP=1`). The
  cached download is re-checked every build and fetched again on mismatch; `LYREN_NODE_BINARY` is checked when
  its hash is known, else used with a warning. `LYREN_NODE_PINNED_ONLY=1` (`requirePinned`; any other non-empty
  value is an error) allows pinned versions only: package.mjs checks it before the build, `fetchNodeBinary` again,
  and an uncheckable `LYREN_NODE_BINARY` (a Linux target: the pinned hash is of the .tar.gz) is refused. `.nvmrc`
  is an exact version and must be pinned (a test checks it).
- **Releases** (`.github/workflows/release.yml`; README "Releases"): a pushed tag `v*` → build (ubuntu-24.04: the
  tag must equal `v` + package.json version, which must be `x.y.z` or `x.y.z-<prerelease>`; setup-node from
  `.nvmrc`; `LYREN_NODE_PINNED_ONLY=1`; `npm ci --ignore-scripts`, `npm run check`, `package.mjs --no-build` for
  win-x64 and linux-x64, after win-x64 `scripts/test/manifest.test.mjs` with `LYREN_TEST_REQUIRE_CACHED_NODE=1`
  (its official-node.exe case, which `npm run check` skips without `.cache/node`); artifact kept 7 days, 3 for a
  dry run) → smoke-windows (windows-2025, `scripts/ci/smoke-windows.ps1` in PowerShell 7 and Windows PowerShell
  5.1: .sha256, `help`, serve with `--no-browser --data-dir --port` and every standard handle redirected to a file
  (console mode), `/api/health` with that version, `/`, `stop` exit 0, server exit 0, port closed; the server is
  killed on any failure; refuses without `-Exe`, a new or empty `-WorkDir` and a free `-Port` outside 43770–43779,
  or with any other argument, and removes the app's variables for what it starts) → release (contents: write;
  `scripts/ci/publish-release.sh`: checks the .sha256 files, writes SHA256SUMS, `gh release create --verify-tag
  --generate-notes` with a notes header, prerelease when the version has `-`; a draft for the tag by
  github-actions[bot] is deleted first, any other draft stops it; a published release is never changed: same asset
  names and SHA-256 digests → success, else an error; replacing one = delete the release, keep the tag, re-run,
  impossible with immutable releases, whose tags can't be reused). `workflow_dispatch` = build + smoke test + a
  notes preview in the job summary, nothing published. Top-level permissions `contents: read`; only actions/*,
  pinned to commit SHAs; no caches; untrusted text (tag names) only through environment variables. No signing in
  CI.
- **Runtime** (`sea.ts` → `desktop/main.ts`): `require('node:sea').isSea()` → web client from the embedded
  assets (`desktop/assets.ts`; size + SHA-256 checked at start, else "This copy of Lyren Plan is damaged").
  `WEB_DIR` set explicitly serves from disk (empty = API only). Same commands as the Node CLI plus `stop` (below); options map to
  variables and win over them: `--no-browser` (OPEN_BROWSER=false), `--lan` (HOST=0.0.0.0), `--port <n>`
  (PORT), `--data-dir <dir>` (DATA_DIR), `--db-path <file>` (DB_PATH); `--console` sets no variable (Modes);
  `help` explains desktop mode (on Windows the icon, Quit, `stop`, a terminal start, the log file and
  `--console`; on Linux / macOS as before plus `stop`). Unset (or empty) variables take the
  desktop defaults: DATA_DIR `%LOCALAPPDATA%\Lyren Plan` (Linux `$XDG_DATA_HOME/lyren-plan` or
  `~/.local/share/lyren-plan`, macOS `~/Library/Application Support/Lyren Plan`), HOST `127.0.0.1`, PORT 43770
  (`desktop/defaults.ts` explains the choice). The Node build and Docker keep SERVER_DEFAULTS (config.ts).
- **One server per database** (`desktop/instance.ts`): an exclusive named pipe (Windows) / abstract socket
  (Linux) named after the canonical DB path. A second start asks the holder for its URL with a random
  challenge and accepts only an answer carrying HMAC(secret, challenge + url), the secret being in
  `desktop.json` next to the DB (private folder, see File permissions), then opens the browser there and exits
  0. Never two servers on one DB. A start that fails after taking the name (data folder, database, port)
  closes the database and the name, dropping clients that wait for its address (they retry and take the
  name), before it waits for Enter. A second start waits at most 15 s for an answer and says "Waiting for the
  Lyren Plan that is already running with this data folder [this database with DB_PATH] to answer..." after
  2 s (tray mode: also a non-blocking Information box, `waitingMessage`: "It opens in your browser as soon as it
  answers ...", or when this start opens no browser "This start opens no browser (<reason>), so nothing else
  happens once it answers.", the reason being `--no-browser` when the option was given, else `OPEN_BROWSER=<value>`
  from the environment: `noBrowserReason`). A name that can't be asked ends with a plain
  explanation (`unusableInstanceMessage`), never a stack: connecting refused for lack of permission (EACCES /
  EPERM, e.g. another Windows account's copy on a shared folder) → 'denied' at once; still EADDRINUSE after 20
  attempts against a holder that drops every connection → 'unreachable'. The texts name the database instead
  of the data folder with DB_PATH.
- **Files next to the DB** (`desktop/files.ts`): `desktop.json` and `logs\lyren-plan.log` for `lyren.db` (any
  case on Windows / macOS); for another file name `<name>.desktop.json` and `logs\<name>.log` (rotating to
  `<name>.1.log`), so two databases in one folder never share a secret, port or log. Until a DB's own file
  exists, a `desktop.json` of an older version in that folder is read (port, secret of a running older copy),
  unless `lyren.db` is in the same folder.
- **`stop`** (`instance.ts` `requestStop`, `main.ts` `stopRunning`): `<exe> stop [--data-dir | --db-path]` connects
  to the instance endpoint of that database and sends `{challenge, stop: true}`; the server answers (once ready)
  with its usual `{app, url, proof}` plus a fresh 16-byte hex `nonce` and keeps the connection open; the client
  checks the proof with the secret from `desktop.json` (no readable secret: exit 1 "... could not be read, so it
  can't be asked to stop"; a wrong proof: exit 1 "Another program answers as Lyren Plan ... could not prove it.
  Nothing was stopped."; a valid proof without a nonce, i.e. a version before `stop`: exit 1 "Lyren Plan (<url>)
  runs with ..., but it is an older version, which the stop command can't stop." + "Close its window (or press
  Ctrl+C in it) to stop it."; connecting refused for lack of permission: exit 1 "... this Windows account may
  not ask it to stop") and sends `{stop: HMAC(secret, "stop\n" + nonce)}` (the prefix keeps it apart from the
  server's proofs, whose challenge is hex; a proof for another nonce is worthless). A valid proof gets
  `{stopping: true}` and the same graceful shutdown as Ctrl+C (reason "stop command"); anything else
  `{stopping: false}` and nothing happens (a server without a stop handler refuses). The client waits up to
  15 s until the name is free (database closed, then the name, then exit): "Lyren Plan (<url>) has stopped.",
  exit 0. A connection dropped without an answer, before or after the proof (the server is already shutting
  down: another `stop`, Quit), also waits for the name: free → stopped ("Lyren Plan (with the data folder
  <dir>) has stopped." when no URL was answered), else no answer / refused. Nothing listening: "Lyren Plan is
  not running with the data folder <dir>" (or "the database <file>" with DB_PATH), exit 1; no answer, refused or
  still running: exit 1 with the reason. Works on Linux (abstract socket) and from source. The answer to a
  second start also carries `mode` ('tray' | 'terminal', absent for a console window) so it can say how the
  running copy is stopped. The stop command the app prints itself (tray banner, a second start's
  `runningHint`) is `commandLine(exe, 'stop', commandTargetOption(...))`: with `--db-path "<file>"` when DB_PATH
  makes the DB a separate file, else `--data-dir "<dir>"` when the data folder is not the per-user default (the
  web client's `targetOption` rule; Command Prompt quoting with a trailing backslash doubled). Command Prompt
  expands `%NAME%` even inside double quotes and its command line has no escape for it (a data folder "R&D
  100%PATH%" arrived with the PATH in it), so when the program's name or the option's value contains a `%`
  (`commandShell`, the same rule as the web client's) the command is for Windows PowerShell instead:
  `& '.\<exe>' stop --data-dir '<dir>'` (`psQuote`: single quotes, `'` and the typographic ‘ ’ ‚ ‛ doubled; nothing
  else is special in them), printed as "run in PowerShell: …" instead of "run: …" (`howToRun`). A program's argument
  there is `psArg` = `psQuote(ps51ArgText(value))`: Windows PowerShell 5.1 wraps an argument containing whitespace
  (.NET `char.IsWhiteSpace`: \t–\r, space, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F,
  U+205F, U+3000; measured, not U+180E, U+200B, U+FEFF) in double quotes without escaping the backslashes before
  the closing quote, so a value ending in backslashes (a share's root: `path.win32.resolve` keeps
  `\\nas\Lyren 100%\`) has that run doubled then (`'\\nas\Lyren 100%\\'`, which 5.1 hands over as
  `\\nas\Lyren 100%\`; the single one arrived as `\\nas\Lyren 100%"`); without whitespace it is passed as it
  is and left alone. PowerShell 7 passes the doubled backslashes on, which the app resolves away. The same rule for
  `help` (a program name with a `%`: Usage "(in PowerShell: …)", the piped-password example for PowerShell), the
  "To see the options" line and the icacls command (File permissions).
- **Port**: explicit PORT/`--port` is used or the start fails (exit 1, plain message). Otherwise the port
  remembered in `desktop.json`, then 43770…43779; the first that is not EADDRINUSE/EACCES (Windows excluded
  port ranges) is used. On win32 each candidate is first probed with a TCP connect to the browser's address
  (`connectProbe`, 300 ms, a timeout counts as free): Windows lets 127.0.0.1:P be bound while another program
  holds 0.0.0.0:P (and vice versa), so an answer counts as EADDRINUSE, for an explicit port too. The origin
  (browser storage, an installed PWA, bookmarks, the port-blind session cookie) depends on the port, so
  (`portToRemember`): a start without a remembered port remembers where it fell back to (banner note); a
  remembered port that is taken this time stays remembered, and the banner warns that bookmarks and the
  installed app for the usual address now reach another program (don't sign in there) and that the app
  returns once it is free.
- **Browser**: opened at the app unless `OPEN_BROWSER` is set to anything but 1/true/yes/on (the rule of every
  boolean variable, `envBool`) (`rundll32 url.dll,FileProtocolHandler <url>` by absolute path on Windows,
  `open` on macOS, `xdg-open` with a display elsewhere; no shell; http(s) URLs only). While no account exists
  (`browserTarget`): on win32 `/setup#code=<code>` (`SETUP_CODE_FRAGMENT_PARAM`; a fragment, never a query
  string); on other platforms `/setup` without the code, since every local user can read the command line
  of xdg-open / open and of a newly started browser. SetupPage fills the code in and replaces the history
  entry without it at once. The code is also printed (banner: "already filled in" or "enter it on the page
  that opened"), and written to `desktop.json` by a first start (dropped at the next start). A second start
  opens the setup page only while the running server answers `GET /api/auth/status` with
  `setupRequired: true`, else the app.
- **Console**: banner with the URL (and LAN URLs with a wildcard HOST), data folder, setup code, and how to stop:
  "Keep this window open ...; close it to stop" (console mode), plus "or right-click the Lyren Plan icon in the
  notification area (near the clock) and choose Quit Lyren Plan" (terminal mode), or "Lyren Plan keeps running in
  the notification area (near the clock). To stop it, right-click its icon and choose Quit Lyren Plan, or run:
  <exe> stop [--data-dir "<dir>" | --db-path "<file>"]" (tray mode, in the log file; "or run in PowerShell: & '.\<exe>'
  stop …" for a `%`, see `stop`); window title
  `Lyren Plan - <url>` on Windows. A stop or crash that begins while the start is still going on (the stop
  command answered once the name is ready, the session ending) ends the start there (`onStopping`): no browser,
  no banner. A fatal start-up error
  waits for Enter when stdin is a TTY (tray mode: a message box). No Node warnings (node:sqlite emits none on
  24.19; ExperimentalWarning is disabled). SIGINT, SIGTERM, SIGBREAK and SIGHUP (console window closed; Windows
  allows a few seconds), Quit in the icon's menu, the `stop` command and the end of the Windows session stop the
  server (`installShutdown` returns that stop): new connections refused, 1.5 s for requests in flight,
  `db.close()` (WAL checkpointed, -wal/-shm removed), the instance name released, then the icon removed (at most
  3 s), exit 0. An uncaught error (`installShutdown`) at once closes the HTTP server (and its connections), the
  instance name and the DB, prints the error and waits for Enter (tray mode: removes the icon and shows a message
  box with the crash's own text, "Lyren Plan stopped because of an unexpected error:" and the error, not the
  run's earlier stderr); a stop signal then exits 1 immediately. A second start says how the running copy is stopped (its window;
  the notification area and `stop`; or its terminal and the icon), and when the running one can't be used
  (Windows): "Quit the other Lyren Plan (close its window, or choose Quit Lyren Plan from its icon in the
  notification area), or end it in Task Manager, and start Lyren Plan again." (Linux unchanged.)
- **Modes** (`desktop/mode.ts` `decideMode`, Windows SEA only; from source, on Linux and macOS always `console`):
  `--console` → `console` when there is a console or the output is redirected, else `relaunch-console`; no
  console: output redirected to a file or pipe (fstat of fd 1/2 neither a TTY nor a character device; a Windows
  pipe has no isFIFO()) → `console`, else (double-clicked; Node opened NUL) → `tray`; a console: build ≥ 26100
  (24H2, where the manifest applies) or the copy started hidden (`LYREN_DESKTOP_RELAUNCHED=1`, removed at start) →
  `terminal`; older Windows → the parent's image (`tasklist /FI "PID eq <ppid>" /FO CSV /NH`, hidden, by
  absolute path; a failing tasklist counts as a terminal) `explorer.exe` or gone → `relaunch-hidden`, else
  `terminal`. Other commands (`backup`, `reset-password`, `stop`, `help`; `commandMode`) without a console and
  without redirection are `unattended` only where nobody can be at the screen: the process's own session is 0
  (services, no interactive desktop, e.g. a task that runs "whether user is logged on or not"; `tasklist /FI "PID
  eq <pid>" /FO CSV /NH`, the Session# field, asked first), or its parent's image (tasklist as above) is one of
  `UNATTENDED_PARENTS`: svchost.exe (Task Scheduler's service), taskhostw.exe, taskhost.exe, taskhostex.exe,
  taskeng.exe, services.exe, wmiprvse.exe. Every other start may be a person's and runs in `tray` mode: Explorer
  (a shortcut, Win+R), another file manager or launcher, Start-Process in a PowerShell window, a program's
  DETACHED_PROCESS child, a parent that has ended, an unknown session or parent (tasklist failing). `tray`: no
  log file; everything printed (stdout and stderr in order, `runtime.showOutput`) is shown when the command ends,
  in a message box (Information on success, Error on failure; reset-password adds "(Ctrl+C copies the text of this
  message.)"), else a console window (`LYREN_DESKTOP_MESSAGE`); a text over 3000 characters or 30 lines (help) goes
  to the console window first and to a shortened box only when that can't be opened. The command's own process
  waits for neither, so a scheduled start taken for a person's does not hang on it: the box is an `outlive` box
  (Message boxes) and the process exits with the command's exit code as soon as it is up (measured: 0.3–0.8 s after the start for `stop` from a
  shortcut, Start-Process and a DETACHED_PROCESS launcher; the box stayed until OK); the console window is a new
  process started by cmd.exe's `start`. A caller that waits for the whole process tree still waits for the box:
  Windows PowerShell's `Start-Process -Wait` puts the command in a job without breakaway and returns only when
  every process in it has ended (measured: the exe exited after 0.7 s, Start-Process returned right after OK);
  the README tells scripts to use `& '<exe>' …` or `Start-Process -PassThru` with `.WaitForExit()` instead. A
  start through "Run as different user" (Secondary Logon, a service in svchost.exe) is taken for unattended
  (untested). `unattended`: no message box, no console window, nothing waited for;
  stdout and stderr go to the log file next to the database (Log file; opened only when the folder that holds the
  database exists, which a command never creates, and not for `help`) after "Command: <command>, started without
  a window by <parent image>: nothing is shown, its output follows." ("… in session 0 (Windows services, no
  desktop) …") and end with "<command> ended with exit code <n>."; then the exit code at once. `reset-password` there without a password (none given, none piped) refuses
  before it opens the database (`MaintenanceContext.noRandomPassword`: "reset-password was started without a
  window by Task Scheduler or a service, so nobody would see a new random password. Nothing was changed.", exit 2): the password would be lost (it is never written to the log). `tray`:
  no console; stdout/stderr go to the log file (`log.ts`); `terminal`: the console as before plus the log file and
  the icon; `console`: as before (no log file, no icon). A relaunch that fails is noted in the log (`--console`
  without a console then runs in `tray`).
- **Relaunches** (`desktop/relaunch.ts`): `relaunch-console`, the tray fallback, the message fallback and a
  long command output start
  `cmd.exe /d /v:off /c start "Lyren Plan" "<System32>\conhost.exe" "%LYREN_RELAUNCH_REF%"` (hidden, verbatim,
  waited for; Node can't start conhost.exe with working standard handles, and the detached policy outranks
  CREATE_NEW_CONSOLE): a classic console window. No user data is in that command line: `LYREN_RELAUNCH_REF` holds
  the text `%LYREN_RELAUNCH_EXE%`, which cmd.exe's single expansion leaves for conhost.exe, whose single expansion
  turns it into the exe path without looking into it (an exe in "…100%PATH%…" works; only `"` is refused); the
  arguments are a JSON array in `LYREN_RELAUNCH_ARGS`, which the new copy uses as its command line when it has none
  (conhost.exe rebuilds the client's command line and expands `%VARIABLES%` in it: a data folder "…100%PATH%…"
  arrived expanded). The variables are removed from the new copy's environment at once. `relaunch-hidden`: the exe with the same
  arguments, `detached`, `windowsHide`, stdio ignored, `LYREN_DESKTOP_RELAUNCHED=1`; the visible copy exits 0.
  A `relaunch-console` that fails continues as `tray`; a `relaunch-hidden` that fails as `terminal`.
- **Notification-area icon** (`desktop/tray.ts`, `scripts.ts` TRAY_SCRIPT, `powershell.ts`): Windows PowerShell
  5.1 by absolute path (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, checked to exist), started
  as `cmd.exe /d /s /c ""<powershell.exe>" -NoProfile -NonInteractive -Command "<BOOTSTRAP>""` with pipes and
  windowsHide (`outsideJobLaunch`, also used for a command's result box; not detached: a detached powershell.exe exits at once; not directly: Node's kill-on-close job would
  end it with the app before it removes its icon; started by cmd.exe it is outside that job). BOOTSTRAP (no `"`,
  `%` or `!`) prints `lyren-ps-boot <LanguageMode>`, reads the script as text lines from stdin up to
  `#lyren-script-end` and runs it with the same reader; no file, no ExecutionPolicy, no -EncodedCommand. Then
  newline-delimited JSON, UTF-8: app → helper `init {parentPid, tooltip, icon (base64 .ico, null = stock icon),
  menu [{id, text, default?} | {separator}], testHooks}`, `tooltip {text}`, `copy {text}`, `ping {id}`, `exit`,
  `test {op}` (only with testHooks: `click:<id>` = that MenuItem's PerformClick, `describe` = the built menu);
  helper → app `hello {languageMode, ps, pid}`, `ready {iconSize, dpi}`, `action {id, via: menu|left-click}`,
  `session-ending {reason}`, `copied`, `pong`, `described`, `error {message}`, `bye {reason}`; garbage, partial
  lines (joined), lines over 64 KiB (dropped) and unknown types are ignored. Every value is JSON data, never
  code. The scripts contain none of the words for which PowerShell logs a script block as suspicious (event 4104,
  Warning; the list is in the tests): WinForms and Drawing load by full assembly name
  (`[System.Reflection.Assembly]::Load('System.Windows.Forms, Version=4.0.0.0, …')`, not Add-Type), and the icon
  comes from `System.Drawing.IconConverter` (not a MemoryStream). The helper runs in System32 (cmd.exe would warn
  about a UNC working folder on stderr, which ends up in the logged exit reasons). The helper: NotifyIcon with the
  icon of 16 × AppliedDPI/96 px (HKCU\Control
  Panel\Desktop\WindowMetrics; powershell.exe is DPI-unaware), tooltip "Lyren Plan - <url>" cut to 63 characters
  (sent with `init`, and as `tooltip` to a helper that got its `init`, ready or not: a slow start sets the address
  between hello and ready), a native ContextMenu: **Open Lyren Plan** (DefaultItem, bold; also the left click; setup
  page with the code while no account exists, `browserTarget`), **Open data folder** (`explorer.exe "<dir>"` by
  absolute path, verbatim and quoted, a drive root unquoted: unquoted, explorer.exe splits at `,` `;` `=` and opens
  Documents; a path over 259 characters, which it can't open, gives an Information box with the path instead; NOT
  windowsHide: with it the folder opens hidden), with `--lan` **Copy address for other devices** (the first LAN
  URL to the clipboard), separator, **Quit Lyren Plan**. It removes the icon and exits on `exit`, stdin EOF (the
  app ended, also when killed: measured 85–119 ms), the app's process gone (polled every 500 ms) and
  SessionEnded (after serving stdin for at most 4 s), in a `finally` on every path; SessionEnding/SessionEnded
  → `session-ending` → the app stops ("Windows is ending the session"). The helper is started right after this
  run holds the instance name; the start waits at most 3 s for `ready` before it opens the browser. Not
  FullLanguage, or PowerShell missing → failed at once; exited before ready or no ready within 15 s (the
  PowerShell pid from `hello` is killed, killing cmd.exe would not end it) → started again after 1, 2, 3 s, at
  most 3 restarts per run, also after it was ready; then failed. Failed in tray mode → "The Lyren Plan icon could
  not be shown in the notification area (<reason>). Lyren Plan stops and starts again in a console window." (log),
  graceful stop, then a console relaunch with `--console`, `--no-browser` when the browser was already opened and
  `SETUP_TOKEN` = the setup code of this first start (the page already open keeps working); "Lyren Plan continues
  in a console window." is logged once that relaunch started, else an Error box (waited for) and the log say
  that Lyren Plan has stopped and to start it from Command Prompt or PowerShell. Failed in terminal mode
  → a note in the terminal, `stopMode` dropped, it keeps running. close(): `exit` + stdin end, at most 3 s, then
  the PowerShell pid is killed (logged: the icon may stay until the mouse passes over it). Windows lists the icon
  under powershell.exe (HKCU\Control Panel\NotifyIconSettings: ExecutablePath …\powershell.exe, UID 1).
- **Message boxes** (`desktop/dialog.ts`, `scripts.ts` DIALOG_SCRIPT, `runtime.ts`): tray mode only. powershell.exe
  directly (windowsHide, the same bootstrap), then `{title: "Lyren Plan", text, icon: Error|Warning|Information}`
  as one JSON line; the script prints `hello {pid}`, `showing` just before the box and `closed` after OK (ignoring
  a closed pipe); `MessageBox.Show(…, MessageBoxOptions.DefaultDesktopOnly)` (a top-most box on the user's
  desktop, hosted by csrss: a box owned by a hidden TopMost form was neither top-most nor in the foreground when
  the app was started in the background). A command's result (Modes) is an `outlive` box: PowerShell started like
  the tray helper (`outsideJobLaunch`: through `cmd.exe /d /s /c`, outside Node's kill-on-close job), resolved at
  `showing`, then the app lets go of it (child unref'd, pipes destroyed) and exits; when the job closes, cmd.exe
  ends and the box stays until OK, after which its PowerShell ends (measured). A box not up within 30 s ends
  the PowerShell named in `hello` too (killing cmd.exe would not end it). The boxes of `serve` are direct
  children and go away with the app. Fatal problems of `serve` (a failed start: the stderr text of this run, the
  same lines as the console, at most 3000 characters plus where the rest is; a crash; a damaged exe; a second
  start that can't reach the running one) are waited for, then exit 1; when no box can be shown (PowerShell
  missing, not FullLanguage, exited before `showing`, no `showing` within 30 s) a console relaunch shows the text
  (`LYREN_DESKTOP_MESSAGE`: print it, wait for Enter, exit 1; for a command's result not waited for either; a
  ConstrainedLanguage PowerShell outside the job ends by itself, measured). Not waited for: the browser could not
  be opened (the address, and the setup code on a first start), the banner's notices (`bannerNotices`: port fallback, usual address taken, folder permission warnings), Open /
  Open data folder failing (or the folder's path too long for File Explorer), no LAN address to copy, a second
  start still waiting for the running copy after 2 s. A command's output: see Modes.
- **Log file** (`desktop/log.ts`, tray and terminal mode): `<folder of the database>\logs\lyren-plan.log`
  (`<name>.log` for a DB not named lyren.db, see Files next to the DB; created 0700/0600 after the data folder
  exists, earlier output kept in memory, at most 256 KiB), everything written to stdout/stderr (banner, warnings,
  errors, Hono's request log with LOG_REQUESTS) plus tray events, as plain text: ANSI escape sequences (Hono
  colours the status) are removed and the setup code of a first start is written as `[not in the log]`
  (`redact`; the terminal still shows it); each line prefixed with local `YYYY-MM-DD HH:MM:SS `; first line "Lyren Plan <version> started
  (<mode> mode, process <pid>, Windows build <n>)". At 1 MiB it is renamed to `lyren-plan.1.log` (replacing it;
  if that fails the file starts over) and a new one starts. Writing never throws. Besides an unattended command
  (Modes), which appends to it (each write at the end of the file), only the run that holds the
  instance name writes it.
- **Child processes on Windows** never flash a console window: icacls (a long path as `\\?\<path>`, File
  permissions), whoami, tasklist, rundll32, cmd.exe and
  powershell.exe are started with windowsHide (relaunch-hidden also detached); explorer.exe (a windowed program)
  is the only exception. The tray helper and the message boxes run with System32 as their working folder.
- **Test-only hooks** (`desktop/hooks.ts`; environment variables, inert unless set, nothing sets them in normal
  use): `LYREN_TEST_BROWSER_LOG=<file>` appends each URL the app would open in the browser instead of opening it;
  `LYREN_TEST_DIALOG_LOG=<file>` appends each message box as JSON instead of showing it; `LYREN_TEST_TRAY_CONTROL=<file>`
  polls <file> every 250 ms (read, deleted) and sends each line to the helper as a test operation (`init.testHooks`
  true): `click:<id>` runs that menu item's own Click handler (no synthetic input), `describe` logs the menu;
  `LYREN_TEST_POWERSHELL_CLM=1` prefixes the bootstrap with `$ExecutionContext.SessionState.LanguageMode =
  'ConstrainedLanguage'` (Windows PowerShell 5.1 ignores `__PSLockdownPolicy` in a process environment).
- **In-app guidance** (`routes/desktop.ts`): only the desktop app passes `Deps.desktop` to `createApp`, and
  only then do responses gain a field (the Node build's and Docker's stay byte-identical, no `desktop` key):
  `GET /api/auth/status` (public) adds `desktop: DesktopAppDTO` `{ exe, windows }` (the program's file name,
  never a path), plus `stopMode: 'tray' | 'terminal'` while the icon is in use (read per response; absent for a
  console window, Linux and macOS, so their responses are unchanged); `GET /api/bootstrap` (signed in) adds `desktop: DesktopDataDTO` (also `dataDir`, `dbPath`
  when DB_PATH makes the database anything but `<dataDir>/lyren.db`, another folder or another name, else null
  (`separateDbPath`, compared without case on Windows; also the banner's "Database:" line), `customDataDir`
  when it is not the per-user default, `exeFolder`, null from source). LoginPage (`PasswordResetHint`) and Settings → Data (`SelfHostingNotes`, card "Data
  folder and commands") then show the app's commands instead of `node dist/server.mjs`, Docker and cron:
  Command Prompt in the program's folder with the file name always quoted (`"<exe>" reset-password <user>`,
  `"<exe>" backup "%USERPROFILE%\Documents\Lyren Plan backups\lyren-<date>.db"`, `--db-path "<dbPath>"`
  appended when `dbPath` is set, else `--data-dir "<dir>"` when `customDataDir`, since a Command Prompt opened
  later lacks the app's DATA_DIR/DB_PATH; a trailing backslash doubled); when the file name or that option's value
  contains a `%` (`commandShell`, see `stop`) every command is for Windows PowerShell instead (`& '.\<exe>' …`,
  values `psQuote`d with a trailing backslash doubled where 5.1 needs it (`ps51ArgText`, see `stop`), the backup file `"$env:USERPROFILE\Documents\Lyren Plan backups\lyren-<date>.db"`; "run in
  PowerShell", "Not in Command Prompt: it would change the % in the path of the data folder" (of the database /
  in the name of the program), "type powershell in the address bar"; the sign-in page by the file name alone); a
  Windows Task Scheduler entry (`powershell.exe` with `& '<exeFolder>\<exe>' backup (… Get-Date -Format
  yyyy-MM-dd …)` and the same option; PowerShell single quotes double `'` and the typographic ‘ ’ ‚ ‛, which also
  end such a string; a `%` in the program's path or the option's value is written as `[char]37`, `('…' + [char]37
  + '…')` (`psLiteral`), since Task Scheduler may expand %NAME% in a task's arguments; the option's value is
  `ps51ArgText`'d first, as PowerShell passes the expression's value to the program like any argument); or `./<exe>` in a
  terminal elsewhere; a "Stop Lyren Plan" note (how, by `stopMode`, and `"<exe>" stop` with the same option);
  the first restore step by `stopMode` ("Close the Lyren Plan window." / "Quit Lyren Plan: right-click its icon in
  the notification area (near the clock) and choose Quit Lyren Plan." / "Stop Lyren Plan: press Ctrl+C in its
  window, or …"), restores replace `dbPath` (and delete its -wal/-shm) when it is set, else `lyren.db` in the data
  folder; the lock-out line by `stopMode` too. With `stopMode` 'tray' the app shell shows a one-time note
  (`TrayHint`, dismissed for good in localStorage `lyren.trayHint.dismissed`, not on phones): it keeps running in
  the notification area, Quit there, the ^ overflow and Settings → Personalization → Taskbar → Other system tray
  icons (maybe listed as Windows PowerShell); the setup page then says "Start Lyren Plan again to open this page
  with the code filled in." (`setupCodeHelp`; the log file leaves the code out). "Can't reach Lyren Plan" on a loopback address says
  "start it again (it must keep running while you use it)". Desktop wording elsewhere: Settings → Account's
  Sign out card ("Your data stays in the data folder on the computer that runs Lyren Plan") and the import
  card's error texts ("Lyren Plan" instead of "the server"). `reset-password` ends with `lockoutAdvice`
  (cli.ts): "restart the server" (server), "close the Lyren Plan window and start Lyren Plan again" (desktop on
  Linux / macOS), or "quit Lyren Plan (choose Quit Lyren Plan from its icon in the notification area, or close its
  window) and start it again" (desktop on Windows: the command can't tell how the app runs).
