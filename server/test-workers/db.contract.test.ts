// The Db contract (server/test/contract/db.contract.ts) on DoDb, in workerd: every case runs
// synchronously inside a fresh TestDbDO, on a DoDb over that object's storage. Then what only DoDb
// does: its error mapping and its refusals.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DAILY_LIMIT_MESSAGE, DailyQuotaError } from '../src/core/db';
import { DoDb } from '../src/runtime/cloudflare/doDb';
import { defineDbContract } from '../test/contract/db.contract';

let objects = 0;

const inFreshObject = <T>(body: (db: DoDb) => T): Promise<T> =>
  runInDurableObject(env.TEST_DB.getByName(`db-contract-${++objects}`), (_instance, state) => body(new DoDb(state.storage)));

defineDbContract('durable-object', inFreshObject, { limits: true });

/** Storage whose SQL API always throws `error` (the daily quota cannot be used up locally). */
function failingStorage(error: Error): DurableObjectStorage {
  const sql = {
    exec: () => {
      throw error;
    },
  };
  return { sql, transactionSync: <T>(fn: () => T) => fn() } as unknown as DurableObjectStorage;
}

describe('DoDb', () => {
  it('turns a daily-quota error of the SQL API into a DailyQuotaError that keeps the original', () => {
    const quota = new Error('Exceeded allowed rows read in Durable Objects free tier.');
    const db = new DoDb(failingStorage(quota));
    let caught: unknown;
    try {
      db.get('SELECT 1 AS v');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DailyQuotaError);
    expect((caught as Error).message).toBe(DAILY_LIMIT_MESSAGE);
    expect((caught as Error).cause).toBe(quota);
    expect(() => db.run('DELETE FROM t')).toThrow(DailyQuotaError);
    expect(() => db.exec('CREATE TABLE t (v)')).toThrow(DailyQuotaError);
  });

  it('passes other SQL errors through unchanged', () => {
    const other = new Error('no such table: t: SQLITE_ERROR');
    expect(() => new DoDb(failingStorage(other)).all('SELECT * FROM t')).toThrow(other);
  });

  it('exec refuses transaction statements and Node-only pragmas with a clear message, before running any', () =>
    inFreshObject((db) => {
      expect(() => db.exec('CREATE TABLE t (v); BEGIN')).toThrow('Not supported in a Durable Object: BEGIN (transactions use db.tx()');
      expect(() => db.exec('CREATE TABLE t (v); PRAGMA journal_mode = WAL')).toThrow(
        'PRAGMA journal_mode is not available in a Durable Object',
      );
      expect(db.get("SELECT name FROM sqlite_master WHERE name = 't'")).toBeUndefined();
      expect(() => db.exec('-- only a comment\n')).not.toThrow();
    }));
});
