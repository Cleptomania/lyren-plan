// The persisted throttle (directory/throttle.ts, design §5.9): block and progressive modes, windows,
// clear and purge with a fake clock, and the buffered storage: memory first, the row written at the
// 3rd and every 10th hit after it and when a block starts, so a one-off request writes no row.

import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/core/version';
import { migrate } from '../../src/core/migrate';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import { MEMORY_KEYS, POLICIES, spacesCreatedPolicy, Throttle, type ThrottlePolicy } from '../../src/directory/throttle';
import { NodeDb } from '../../src/runtime/node/nodeDb';
import { fakeClock } from '../support/directoryHarness';

const MINUTE = 60_000;

function setup() {
  const db = new NodeDb(':memory:');
  migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
  const clock = fakeClock();
  return { db, clock, throttle: new Throttle(db, clock) };
}

const row = (db: NodeDb, key: string) =>
  db.get<{ count: number; window_start: string; blocked_until: string | null }>('SELECT * FROM auth_throttle WHERE key = :key', { key });

const exact: ThrottlePolicy = { name: 'xt', limit: 3, windowMs: 10 * MINUTE, mode: 'block', storage: 'exact' };

describe('Throttle: block mode', () => {
  it('blocks at the limit until the window ends', () => {
    const { clock, throttle } = setup();
    for (let i = 0; i < 9; i++) throttle.hit('li:a', POLICIES.li);
    expect(throttle.check('li:a', POLICIES.li).blocked).toBe(false);
    const tenth = throttle.hit('li:a', POLICIES.li);
    expect(tenth).toEqual({ blocked: true, retryAfterMs: 15 * MINUTE, count: 10 });
    clock.advance(5 * MINUTE);
    expect(throttle.check('li:a', POLICIES.li)).toEqual({ blocked: true, retryAfterMs: 10 * MINUTE, count: 10 });
    expect(throttle.check('li:b', POLICIES.li).blocked).toBe(false);
    clock.advance(10 * MINUTE);
    expect(throttle.check('li:a', POLICIES.li)).toEqual({ blocked: false, retryAfterMs: 0, count: 0 });
    expect(throttle.hit('li:a', POLICIES.li).count).toBe(1);
  });

  it('exact storage writes every hit, so a new instance (a restart) sees it', () => {
    const { db, clock, throttle } = setup();
    throttle.hit('xt:1', exact);
    expect(row(db, 'xt:1')?.count).toBe(1);
    throttle.hit('xt:1', exact);
    throttle.hit('xt:1', exact);
    const restarted = new Throttle(db, clock);
    expect(restarted.check('xt:1', exact)).toMatchObject({ blocked: true, count: 3 });
    expect(row(db, 'xt:1')?.blocked_until).toBe(new Date(clock.now() + 10 * MINUTE).toISOString());
  });

  it('forgive gives one hit back; clear forgets the key', () => {
    const { db, throttle } = setup();
    throttle.hit('xt:1', exact);
    throttle.hit('xt:1', exact);
    throttle.forgive('xt:1', exact);
    expect(throttle.check('xt:1', exact).count).toBe(1);
    throttle.hit('li:a', POLICIES.li);
    throttle.forgive('li:a', POLICIES.li);
    expect(throttle.check('li:a', POLICIES.li).count).toBe(0);
    throttle.clear('xt:1');
    expect(row(db, 'xt:1')).toBeUndefined();
    expect(throttle.check('xt:1', exact).count).toBe(0);
  });

  it('forgive lifts the block its hit started, in memory and in the row, so a success is not blocked by itself', () => {
    const { db, clock, throttle } = setup();
    for (let i = 0; i < 10; i++) throttle.hit('li:a', POLICIES.li);
    expect(row(db, 'li:a')).toMatchObject({ count: 10, blocked_until: expect.any(String) });
    throttle.forgive('li:a', POLICIES.li);
    expect(throttle.check('li:a', POLICIES.li)).toEqual({ blocked: false, retryAfterMs: 0, count: 9 });
    expect(row(db, 'li:a')).toMatchObject({ count: 9, blocked_until: null });
    expect(new Throttle(db, clock).check('li:a', POLICIES.li).blocked).toBe(false);

    // Without the memory (an eviction between the hit and the forgive) the row is given back.
    throttle.hit('li:a', POLICIES.li);
    const evicted = new Throttle(db, clock);
    evicted.forgive('li:a', POLICIES.li);
    expect(row(db, 'li:a')).toMatchObject({ count: 9, blocked_until: null });

    // Exact storage likewise; a block that hits which were not forgiven started stays.
    for (let i = 0; i < 3; i++) throttle.hit('xt:1', exact);
    throttle.forgive('xt:1', exact);
    expect(row(db, 'xt:1')).toMatchObject({ count: 2, blocked_until: null });
    expect(throttle.check('xt:1', exact).blocked).toBe(false);
    throttle.hit('xt:1', exact);
    throttle.hit('xt:1', exact);
    throttle.forgive('xt:1', exact);
    expect(throttle.check('xt:1', exact)).toMatchObject({ blocked: true, count: 3 });
  });
});

describe('Throttle: progressive mode (lid)', () => {
  it('lets 20 failures through, then spaces attempts out: 250 ms · 2^(n − 20), at most 10 s', () => {
    const { clock, throttle } = setup();
    for (let i = 0; i < 20; i++) expect(throttle.hit('lid:a:1', POLICIES.lid).blocked).toBe(false);
    expect(throttle.hit('lid:a:1', POLICIES.lid)).toEqual({ blocked: true, retryAfterMs: 500, count: 21 });
    clock.advance(499);
    expect(throttle.check('lid:a:1', POLICIES.lid).blocked).toBe(true);
    clock.advance(1);
    expect(throttle.check('lid:a:1', POLICIES.lid).blocked).toBe(false);
    expect(throttle.hit('lid:a:1', POLICIES.lid).retryAfterMs).toBe(1000);
    for (let i = 0; i < 10; i++) throttle.hit('lid:a:1', POLICIES.lid);
    expect(throttle.check('lid:a:1', POLICIES.lid).retryAfterMs).toBe(10_000);
  });
});

describe('Throttle: buffered storage', () => {
  it('writes no row for one or two hits, then at the 3rd, the 13th and the 23rd', () => {
    const { db, throttle } = setup();
    throttle.hit('ln:x', POLICIES.ln);
    throttle.hit('ln:x', POLICIES.ln);
    expect(row(db, 'ln:x')).toBeUndefined();
    throttle.hit('ln:x', POLICIES.ln);
    expect(row(db, 'ln:x')?.count).toBe(3);
    for (let i = 4; i <= 12; i++) throttle.hit('ln:x', POLICIES.ln);
    expect(row(db, 'ln:x')?.count).toBe(3);
    throttle.hit('ln:x', POLICIES.ln);
    expect(row(db, 'ln:x')?.count).toBe(13);
    for (let i = 14; i <= 23; i++) throttle.hit('ln:x', POLICIES.ln);
    expect(row(db, 'ln:x')?.count).toBe(23);
  });

  it('writes the row when a block starts, so a restart keeps the block', () => {
    const { db, clock, throttle } = setup();
    for (let i = 0; i < 10; i++) throttle.hit('li:a', POLICIES.li);
    expect(row(db, 'li:a')).toMatchObject({ count: 10, blocked_until: new Date(clock.now() + 15 * MINUTE).toISOString() });
    expect(new Throttle(db, clock).check('li:a', POLICIES.li).blocked).toBe(true);
  });

  it('a check reads the larger of memory and row; losing the memory costs at most 9 hits', () => {
    const { db, clock, throttle } = setup();
    for (let i = 0; i < 12; i++) throttle.hit('ln:x', POLICIES.ln);
    expect(throttle.check('ln:x', POLICIES.ln).count).toBe(12);
    const restarted = new Throttle(db, clock);
    expect(restarted.check('ln:x', POLICIES.ln).count).toBe(3);
    // Counting goes on from the row.
    expect(restarted.hit('ln:x', POLICIES.ln).count).toBe(4);
    // A row written elsewhere (another process) with a higher count wins over memory.
    db.run("UPDATE auth_throttle SET count = 40 WHERE key = 'ln:x'");
    expect(restarted.check('ln:x', POLICIES.ln).count).toBe(40);
  });

  it('a row cleared from outside (the reset-password command) ends the lock-out in memory too', () => {
    const { db, throttle } = setup();
    for (let i = 0; i < POLICIES.li.limit; i++) throttle.hit('li:x', POLICIES.li);
    expect(throttle.check('li:x', POLICIES.li).blocked).toBe(true);
    db.run("DELETE FROM auth_throttle WHERE key = 'li:x'");
    expect(throttle.check('li:x', POLICIES.li)).toEqual({ blocked: false, retryAfterMs: 0, count: 0 });
    // Counting starts again from nothing.
    expect(throttle.hit('li:x', POLICIES.li).count).toBe(1);
  });

  it('flush writes counts that passed their first write and changed, and nothing for one-off keys', () => {
    const { db, throttle } = setup();
    for (let i = 0; i < 5; i++) throttle.hit('ln:x', POLICIES.ln);
    throttle.hit('ln:once', POLICIES.ln);
    expect(throttle.flush()).toBe(1);
    expect(row(db, 'ln:x')?.count).toBe(5);
    expect(row(db, 'ln:once')).toBeUndefined();
    expect(throttle.flush()).toBe(0);
  });

  it('a stream of one-off keys (rotating addresses) writes no rows', () => {
    const { db, throttle } = setup();
    for (let i = 0; i < 500; i++) throttle.hit(`li:192.0.2.${i}`, POLICIES.li);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_throttle')!.n).toBe(0);
  });

  it('keeps at most MEMORY_KEYS keys in memory; spraying addresses neither loses a count nor lifts a block', () => {
    const { db, throttle } = setup();
    for (let i = 0; i < 4; i++) throttle.hit('li:counted', POLICIES.li); // the row holds 3, memory 4
    for (let i = 0; i < POLICIES.li.limit; i++) throttle.hit('li:blocked', POLICIES.li);
    expect(row(db, 'li:counted')?.count).toBe(3);
    for (let i = 0; i <= MEMORY_KEYS; i++) throttle.hit(`li:spray:${i}`, POLICIES.li);
    expect(throttle.size).toBeLessThanOrEqual(MEMORY_KEYS);
    // Evicted: the count the memory held was written; the block lives on in its row.
    expect(row(db, 'li:counted')?.count).toBe(4);
    expect(throttle.check('li:counted', POLICIES.li).count).toBe(4);
    expect(throttle.check('li:blocked', POLICIES.li).blocked).toBe(true);
    // The one-off keys wrote nothing.
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_throttle')!.n).toBe(2);
  });
});

describe('Throttle.purge', () => {
  it('deletes rows (and counters) whose window and block are over, per policy window', () => {
    const { db, clock, throttle } = setup();
    for (let i = 0; i < 3; i++) throttle.hit('li:a', POLICIES.li);
    for (let i = 0; i < 3; i++) throttle.hit('lda:1', POLICIES.lda);
    const sc = spacesCreatedPolicy(10);
    throttle.hit('sc:1', sc);
    throttle.hit('lg', POLICIES.lg);
    throttle.hit('lg', POLICIES.lg);
    throttle.hit('lg', POLICIES.lg);
    expect(throttle.purge(clock.now())).toBe(0);
    clock.advance(16 * MINUTE);
    expect(throttle.purge(clock.now())).toBe(2); // li:a and lg; lda and sc have a day
    expect(db.all<{ key: string }>('SELECT key FROM auth_throttle ORDER BY key').map((r) => r.key)).toEqual(['lda:1', 'sc:1']);
    clock.advance(24 * 60 * MINUTE);
    expect(throttle.purge(clock.now())).toBe(2);
    expect(throttle.check('li:a', POLICIES.li).count).toBe(0);
  });

  it('keeps a row whose block outlasts its window, and purges rows of unknown policies after a day', () => {
    const { db, clock, throttle } = setup();
    const start = new Date(clock.now()).toISOString();
    db.run("INSERT INTO auth_throttle (key, window_start, count, blocked_until) VALUES ('lid:a:9', :s, 30, :b), ('zz:1', :s, 1, NULL)", {
      s: start,
      b: new Date(clock.now() + 20 * MINUTE).toISOString(),
    });
    clock.advance(16 * MINUTE);
    expect(throttle.purge(clock.now())).toBe(0);
    clock.advance(5 * MINUTE);
    expect(throttle.purge(clock.now())).toBe(1);
    clock.advance(24 * 60 * MINUTE);
    expect(throttle.purge(clock.now())).toBe(1);
  });
});
