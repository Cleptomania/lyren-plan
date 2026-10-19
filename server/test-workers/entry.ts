// The Worker of the 'workers' test project (wrangler.test.jsonc): the production Worker (worker.ts) and
// its two Durable Objects, here as subclasses that count the calls they get, and TestDbDO, a bare SQLite
// Durable Object for the Db contract (server/test/contract/db.contract.ts).
//
// Tests run in the same isolate as these objects and import this module (the same instance the bindings
// use), so they read the counters directly: which requests reached the directory or a space (the Worker
// answers many itself, §10.2), how many authorizeSpace calls a space made (the auth cache, §10.5; an
// uninitialized space, Appendix D 39), and the objects' databases, whose meters give the rows a request
// read and wrote (the cost tests, §14.4). Storage and counters start fresh in every test file. testHooks
// lets a test make a space's destroy fail (the alarm's failing task, §10.3), and hold the directory's
// answers to authorizeSpace after they are computed (an answer from before a change, §10.5).

import { DurableObject } from 'cloudflare:workers';
import type { DirectoryClient, SpaceInit } from '../src/core/ports';
import type { DoDb } from '../src/runtime/cloudflare/doDb';
import type { Env } from '../src/runtime/cloudflare/env';
import worker, { DirectoryDO as WorkerDirectoryDO, SpaceDO as WorkerSpaceDO } from '../src/runtime/cloudflare/worker';

/** A Durable Object with nothing but SQLite storage: tests use it through runInDurableObject. */
export class TestDbDO extends DurableObject {}

type DirectoryCall = 'fetch' | Exclude<keyof DirectoryClient, 'serve'>;
type SpaceCall = 'fetch' | 'init' | 'invalidate' | 'destroy' | 'stats';

/** Calls that reached the directory, by method. */
export const directoryCalls: Record<DirectoryCall, number> = {
  fetch: 0,
  authorizeSpace: 0,
  spaceSync: 0,
  importCandidates: 0,
  reserveImport: 0,
  refundImport: 0,
  importCommitted: 0,
};

/** Calls that reached a space object, by space id and method. */
export const spaceCalls = new Map<string, Record<SpaceCall, number>>();

/**
 * The database of each space object, by space id (its newest instance: an evicted object comes back with a new
 * one), and the directory's. Their `meter` sums the rows the platform bills; a request's are the difference.
 */
export const objectDbs = { spaces: new Map<string, DoDb>(), directory: null as DoDb | null };

export const testHooks = {
  /** Space ids whose destroy throws. */
  failDestroy: new Set<string>(),
  /** While set, authorizeSpace computes its answer, then waits for this before it returns it. */
  holdAuthorize: null as Promise<void> | null,
};

/** The calls of one space so far (zeros when none reached it). */
export function callsOf(spaceId: string): Record<SpaceCall, number> {
  return spaceCalls.get(spaceId) ?? { fetch: 0, init: 0, invalidate: 0, destroy: 0, stats: 0 };
}

export class DirectoryDO extends WorkerDirectoryDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The database exists once the constructor's blockConcurrencyWhile has run, before any call.
    void ctx.blockConcurrencyWhile(async () => {
      objectDbs.directory = this.db;
    });
  }

  override fetch(request: Request) {
    directoryCalls.fetch++;
    return super.fetch(request);
  }

  override async authorizeSpace(input: Parameters<WorkerDirectoryDO['authorizeSpace']>[0]) {
    directoryCalls.authorizeSpace++;
    const answer = await super.authorizeSpace(input);
    if (testHooks.holdAuthorize) await testHooks.holdAuthorize;
    return answer;
  }

  override spaceSync(input: Parameters<WorkerDirectoryDO['spaceSync']>[0]) {
    directoryCalls.spaceSync++;
    return super.spaceSync(input);
  }

  override importCandidates(input: Parameters<WorkerDirectoryDO['importCandidates']>[0]) {
    directoryCalls.importCandidates++;
    return super.importCandidates(input);
  }

  override reserveImport(input: Parameters<WorkerDirectoryDO['reserveImport']>[0]) {
    directoryCalls.reserveImport++;
    return super.reserveImport(input);
  }

  override refundImport(input: Parameters<WorkerDirectoryDO['refundImport']>[0]) {
    directoryCalls.refundImport++;
    return super.refundImport(input);
  }

  override importCommitted(input: Parameters<WorkerDirectoryDO['importCommitted']>[0]) {
    directoryCalls.importCommitted++;
    return super.importCommitted(input);
  }
}

export class SpaceDO extends WorkerSpaceDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    objectDbs.spaces.set(ctx.id.name ?? '', this.db);
  }

  private count(call: SpaceCall): void {
    const name = this.ctx.id.name ?? '';
    const calls = callsOf(name);
    calls[call]++;
    spaceCalls.set(name, calls);
  }

  override fetch(request: Request) {
    this.count('fetch');
    return super.fetch(request);
  }

  override init(init: SpaceInit) {
    this.count('init');
    return super.init(init);
  }

  override invalidate() {
    this.count('invalidate');
    return super.invalidate();
  }

  override async destroy() {
    this.count('destroy');
    if (testHooks.failDestroy.has(this.ctx.id.name ?? '')) throw new Error('destroy failed (test hook)');
    return super.destroy();
  }

  override stats() {
    this.count('stats');
    return super.stats();
  }
}

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_DB: DurableObjectNamespace<TestDbDO>;
    }
  }
}

export default worker;
