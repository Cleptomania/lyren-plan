// Validation is bounded (design Appendix D 44): a large invalid body answers 400 within a time and memory
// bound, however many of its items are bad and whichever way they fail, and a small one is still described
// problem by problem. The bodies are support/hostileBodies.ts's; the workers half (the same bodies through the
// Worker) is server/test-workers/validation.test.ts, and findsProblem's own tests are shared/src/bounded.test.ts.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultBoardConfig } from '@shared/board';
import { DESCRIBED_VALUES } from '@shared/bounded';
import { ACTIVITY_DATA_MAX_CHARS } from '@shared/export';
import { createTestContext } from './helpers';
import { replaceImport } from './support/archive';
import {
  badBoardConfigImport,
  badImport,
  HOSTILE_REQUESTS,
  hostileStatus,
  longConfigImport,
  MIB,
  type HostileCase,
  type HostileRequest,
} from './support/hostileBodies';
import { ROOT, tsxCommand, tsxEnv } from './tsxNode';

/** The V8 heap of the child server below, in MB: what a Worker's isolate has. */
const HEAP_MB = 128;

describe('every hostile body answers within a 128 MB heap (Appendix D 44)', () => {
  // One server in a child process whose heap is capped (support/boundsChild.ts): a request whose validation
  // outgrows it ends the process, whatever the requests before it used. With zod's validate() as the bound (the
  // first fix), 6 of the first 12 did.
  const names = Object.keys(HOSTILE_REQUESTS) as HostileCase[];
  // A parse at Node's value cap, again and again: what one leaves behind must not add up (Appendix D 62).
  const repeated = Array<HostileCase>(3).fill("import under Node's value cap, tasks {}");
  type Answer = { name: HostileCase; status: number; error: { code: string; message: string } | null; ms: number };
  let child: SpawnSyncReturns<string>;
  let answers: Map<HostileCase, Answer>;
  beforeAll(() => {
    const [command, args] = tsxCommand('server/test/support/boundsChild.ts', [...names, ...repeated]);
    child = spawnSync(command, [`--max-old-space-size=${HEAP_MB}`, ...args], {
      cwd: ROOT,
      env: tsxEnv(process.env),
      encoding: 'utf8',
      timeout: 120_000,
    });
    const lines = child.stdout.split('\n').filter((line) => line.startsWith('{'));
    answers = new Map(lines.map((line) => JSON.parse(line) as Answer).map((answer) => [answer.name, answer]));
  }, 130_000);

  it('the server lasts', () => {
    expect(child.status, child.stderr.slice(-2000)).toBe(0);
  });

  it.each(names)('%s', (name) => {
    const answer = answers.get(name);
    expect(answer, `no answer: the server ended (${child.signal ?? child.status})`).toBeDefined();
    expect(answer!.status).toBe(hostileStatus(HOSTILE_REQUESTS[name], 'node'));
    if (answer!.status === 400) expect(answer!.error?.code).toBe((HOSTILE_REQUESTS[name] as HostileRequest).code ?? 'validation_error');
    expect(answer!.ms).toBeLessThan(3000);
  });
});

describe('what a large invalid body answers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function owner() {
    const ctx = createTestContext();
    const { client } = await ctx.signedIn();
    return client;
  }

  it('a body too large to describe: no details', async () => {
    const client = await owner();
    const res = await client.request('POST', '/api/tasks/query', HOSTILE_REQUESTS['query, project ids 0'].body());
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'validation_error', message: 'Invalid input (too many values to list its problems)' });
  });

  it('a small invalid body is still described, its first 20 problems and a count of the rest', async () => {
    const client = await owner();
    const res = await client.request('POST', '/api/tasks/query', { filter: { projectIds: Array(30).fill(0) } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^filter\.projectIds\.0: /);
    expect(res.body.error.details).toHaveLength(21);
    expect(res.body.error.details[19].path).toBe('filter.projectIds.19');
    expect(res.body.error.details[20]).toEqual({ path: '', message: '…and 10 more problem(s)' });
  });

  it('a 4 MiB v1 import of 400,000 tasks {"id":1}: the first 50 problems', async () => {
    const client = await owner();
    const res = await replaceImport(client, badImport(4 * MIB, '{"id":1}'));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^Invalid export file \(more than 50 problems\): tasks\.0\./);
    expect(res.body.error.details).toHaveLength(51);
    expect(res.body.error.details[50]).toEqual({ path: '', message: '…and more problems' });
  });

  it('a 4 MiB v1 import of 2 million tasks 1: past Node\'s value cap 413, and with a cap that lets it in, one problem, the list is too long', async () => {
    const client = await owner();
    expect((await replaceImport(client, badImport(4 * MIB, '1'))).status).toBe(413);
    vi.stubEnv('IMPORT_MAX_JSON_VALUES', '4000000');
    const res = await replaceImport(await owner(), badImport(4 * MIB, '1'));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^Invalid export file \(1 problem\): tasks: Too big/);
  });

  it('an import row too large to describe is named by its path, whether its items fail on type or on a check', async () => {
    const client = await owner();
    for (const unit of ['""', '0']) {
      const row = `{"id":1,"tagIds":[${Array(DESCRIBED_VALUES).fill(unit).join(',')}]}`;
      const res = await replaceImport(client, badImport(1024, '1').replace('"tasks":[', `"tasks":[${row},`));
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toEqual({ path: 'tasks.0', message: 'Invalid row (too many values to list its problems)' });
      expect(res.body.error.details[1].path).toBe('tasks.1');
    }
  });

  it('an imported board whose config is too large to describe gets the default filter (read leniently)', async () => {
    const client = await owner();
    const res = await replaceImport(client, badBoardConfigImport(MIB));
    expect(res.status).toBe(200);
    const boards = await client.get('/api/boards');
    expect(boards.body.map((b: { config: { filter: unknown } }) => b.config.filter)).toEqual([{ closedWithinDays: 14 }]);
  });

  it('an imported board whose valid config is longer than an editor makes gets the default config (no row near 2 MB)', async () => {
    const client = await owner();
    expect(longConfigImport().length).toBeGreaterThan(ACTIVITY_DATA_MAX_CHARS);
    expect((await replaceImport(client, longConfigImport())).status).toBe(200);
    const boards = await client.get('/api/boards');
    expect(boards.body.map((b: { config: unknown }) => b.config)).toEqual([defaultBoardConfig()]);
  });
});
