// Reading an import file (design §8.4 "Request handling", §8.7, §14.2): the JSON value counter, then every step of
// the read path as a request answers it (the form, gzip and its unpacked size, UTF-8, the value count and the
// nesting, JSON, the format and version) and archive v2's own integrity checks of its users. The hostile bodies
// at the Cloudflare limits, under a capped heap, are validationBounds.test.ts's (support/hostileBodies.ts).

import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportAnalysisDTO, SpaceArchiveDTO } from '@shared/types';
import { sizeText } from '../src/space/archive/read';
import { jsonShapeProblem, MAX_JSON_DEPTH } from '../src/space/archive/values';
import { createTestContext } from './helpers';
import { downloadArchive, importForm } from './support/archive';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the JSON value counter (§8.4 step 4)', () => {
  it('counts objects, arrays and commas outside strings, and stops past the limit', () => {
    expect(jsonShapeProblem('[{},{},{}]', 6)).toBeNull(); // [ { , { , {
    expect(jsonShapeProblem('[{},{},{}]', 5)).toBe('values');
    expect(jsonShapeProblem('{"a":1,"b":[1,2]}', 4)).toBeNull();
    expect(jsonShapeProblem('{"a":1,"b":[1,2]}', 3)).toBe('values');
    // Brackets, commas and escaped quotes inside strings do not count.
    expect(jsonShapeProblem(String.raw`["a\"[{,,,}]", "\\", "{[,"]`, 3)).toBeNull();
    expect(jsonShapeProblem(String.raw`["\\\"", ","]`, 2)).toBeNull();
    // An unterminated string is JSON.parse's to refuse.
    expect(jsonShapeProblem('["[[[[', 1)).toBeNull();
  });

  it("the review's bomb, 16 MiB of [{},{},…], is refused at Cloudflare's and Node's limits", () => {
    const bomb = `[${Array(5_592_405).fill('{}').join(',')}]`;
    expect(bomb.length).toBeGreaterThan(16 * 1024 * 1024 - 2);
    expect(jsonShapeProblem(bomb, 300_000)).toBe('values');
    expect(jsonShapeProblem(bomb, 4_000_000)).toBe('values');
  });

  it(`refuses a nesting deeper than ${MAX_JSON_DEPTH}`, () => {
    expect(jsonShapeProblem('['.repeat(MAX_JSON_DEPTH) + ']'.repeat(MAX_JSON_DEPTH), 1000)).toBeNull();
    expect(jsonShapeProblem('['.repeat(MAX_JSON_DEPTH + 1) + ']'.repeat(MAX_JSON_DEPTH + 1), 1000)).toBe('depth');
    expect(jsonShapeProblem('{"a":'.repeat(MAX_JSON_DEPTH + 1), 1000)).toBe('depth');
    // Depth counts what is open, not everything seen.
    expect(jsonShapeProblem('[[]]'.repeat(1000).replace(/\]\[/g, '],['), 10_000)).toBeNull();
  });

  it('names sizes as the refusals do', () => {
    expect(sizeText(4 * 1024 * 1024)).toBe('4 MB');
    expect(sizeText(50 * 1024 * 1024)).toBe('50 MB');
    expect(sizeText(1536 * 1024)).toBe('1.5 MB');
    expect(sizeText(2048)).toBe('2 KB');
    expect(sizeText(100)).toBe('100 bytes');
  });
});

describe('the read path, as a request answers it', () => {
  async function owner(vars: Record<string, string> = {}, config: Parameters<typeof createTestContext>[0] = {}) {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    const ctx = createTestContext(config);
    const { client } = await ctx.signedIn({ createSampleData: true });
    const archive = (await downloadArchive(client)).archive!;
    const analyze = (body: unknown) => client.post('/api/data/import/analyze?mode=replace', body);
    return { ctx, client, archive, analyze };
  }

  it('the form: a multipart body with a file', async () => {
    const { analyze } = await owner();
    expect(errorOf(await analyze({ file: 'x' }))).toEqual({
      status: 400,
      error: { code: 'validation_error', message: 'Send the file as the multipart field "file"', details: [{ path: 'file', message: 'Required' }] },
    });
    const form = new FormData();
    form.set('file', 'text, not a file');
    expect((await analyze(form)).body.error.message).toBe('Choose a file to import');
  });

  it('gzip: unpacked, its bytes counted against IMPORT_BODY_LIMIT; damaged gzip is refused', async () => {
    const { analyze, archive } = await owner({}, { importBodyLimit: 64 * 1024 });
    const json = JSON.stringify(archive);
    expect(json.length).toBeLessThan(64 * 1024);
    expect((await analyze(importForm(archive, { gzip: true }))).status).toBe(200);
    // Small packed, large unpacked: refused at the counter.
    const padded = { ...archive, appVersion: '1', padding: ' '.repeat(70 * 1024) };
    expect(errorOf(await analyze(importForm(padded, { gzip: true })))).toEqual({
      status: 413,
      error: { code: 'payload_too_large', message: 'The archive is larger than 64 KB unpacked' },
    });
    const damaged = gzipSync(Buffer.from(json)).subarray(0, 100);
    expect(errorOf(await analyze(importForm(damaged)))).toEqual({ status: 400, error: { code: 'bad_request', message: 'The file is not a valid gzip file' } });
    const trailing = Buffer.concat([gzipSync(Buffer.from(json)), Buffer.from('junk')]);
    expect((await analyze(importForm(trailing))).body.error.message).toBe('The file is not a valid gzip file');
  });

  it('UTF-8 only (a byte order mark is fine), then JSON', async () => {
    const { analyze, archive } = await owner();
    const notJson = { status: 400, error: { code: 'bad_request', message: 'The file is not valid JSON' } };
    const latin1 = Uint8Array.from([...Buffer.from('{"format":"lyren-plan-space","x":"'), 0xe9, ...Buffer.from('"}')]);
    expect(errorOf(await analyze(importForm(latin1)))).toEqual(notJson);
    expect(errorOf(await analyze(importForm(latin1, { gzip: true })))).toEqual(notJson);
    expect(errorOf(await analyze(importForm('{oops')))).toEqual(notJson);
    expect((await analyze(importForm(`﻿${JSON.stringify(archive)}`))).status).toBe(200);
  });

  it('IMPORT_MAX_JSON_VALUES, and the nesting, before anything is parsed', async () => {
    const { analyze, archive } = await owner({ IMPORT_MAX_JSON_VALUES: '2000' });
    const many = { ...archive, tasks: [...archive.tasks, ...Array.from({ length: 1000 }, () => archive.tasks[0]!)] };
    expect(errorOf(await analyze(importForm(many)))).toEqual({
      status: 413,
      error: { code: 'payload_too_large', message: 'The archive has more entries than this instance accepts.' },
    });
    const deep = { ...archive, activity: [{ ...archive.activity[0]!, data: JSON.parse('['.repeat(70) + ']'.repeat(70)) }] };
    expect(errorOf(await analyze(importForm(deep)))).toEqual({
      status: 400,
      error: { code: 'bad_request', message: 'The file is nested too deeply to be an export file' },
    });
  });

  it("the format and version: today's messages, and both versions named", async () => {
    const { analyze, archive } = await owner();
    expect(errorOf(await analyze(importForm({ format: 'something' })))).toEqual({
      status: 400,
      error: {
        code: 'validation_error',
        message: 'This is not a Lyren Plan export file',
        details: [{ path: 'format', message: 'Expected "lyren-plan-space" or "lyren-plan-export"' }],
      },
    });
    for (const [format, version] of [
      ['lyren-plan-space', 3],
      ['lyren-plan-space', 1],
      ['lyren-plan-export', 2],
    ] as const) {
      expect(errorOf(await analyze(importForm({ ...archive, format, formatVersion: version })))).toEqual({
        status: 400,
        error: {
          code: 'validation_error',
          message: `Unsupported export format version ${version}`,
          details: [{ path: 'formatVersion', message: 'Only versions 1 and 2 are supported' }],
        },
      });
    }
    expect((await analyze(importForm([archive]))).body.error.message).toBe('This is not a Lyren Plan export file');
  });

  it('a refusal never repeats the file: a long version is not named, unknown tag ids are listed up to 10, details are clipped', async () => {
    const { analyze, archive, client } = await owner();
    const long = await analyze(importForm({ ...archive, formatVersion: `v${'9'.repeat(100_000)}` }));
    expect(long.body.error.message).toBe('Unsupported export format version');
    expect((await analyze(importForm({ ...archive, formatVersion: 'v3' }))).body.error.message).toBe('Unsupported export format version "v3"');
    const tags = { ...archive, tasks: archive.tasks.map((t, i) => (i === 0 ? { ...t, tagIds: Array.from({ length: 5_000 }, (_, j) => 900_000 + j) } : t)) };
    const unknown = await analyze(importForm(tags));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toBe(
      `The export file is inconsistent (1 problem): Task ${archive.tasks[0]!.id}: unknown tag ids 900000, 900001, 900002, 900003, 900004, 900005, 900006, 900007, 900008, 900009 and 4990 more`,
    );
    // A zod issue's path holds the body's own keys (a record's), which can be as long as the body.
    const key = 'k'.repeat(100_000);
    const res = await client.post('/api/boards', { name: 'B', config: { columns: { prefs: { status: { wipLimits: { [key]: 1 } } } } } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe(`config.columns.prefs.status.wipLimits.${'k'.repeat(300 - 'config.columns.prefs.status.wipLimits.'.length - 1)}…`);
    expect(JSON.stringify(res.body).length).toBeLessThan(2_000);
  });
});

describe('archive v2: its users (§8.7)', () => {
  async function owner() {
    const ctx = createTestContext();
    const { client, user } = await ctx.signedIn({ createSampleData: true });
    const archive = (await downloadArchive(client)).archive!;
    const analyze = (a: SpaceArchiveDTO) => client.post('/api/data/import/analyze?mode=replace', importForm(a));
    return { ctx, client, user, archive, analyze };
  }

  it('ids unique, kinds matching their sign, every reference one of them, the exporter too', async () => {
    const { archive, analyze, user } = await owner();
    const broken = structuredClone(archive);
    broken.users.push({ id: user.id, kind: 'account', displayName: 'Twin', email: null }, { id: -2, kind: 'account', displayName: 'Minus', email: null });
    broken.users.push({ id: 5, kind: 'placeholder', displayName: 'Plus', email: null });
    broken.space.exportedBy = 77;
    broken.tasks[0]!.createdBy = 88;
    broken.comments[0]!.authorId = 89;
    broken.comments[1]!.importedBy = 90;
    broken.worklogs[0]!.authorId = -91;
    broken.activity[0]!.actorId = 92;
    broken.activity[1]!.importedBy = 93;
    const res = await analyze(broken);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^The export file is inconsistent \(10 problems\): Duplicate user id /);
    expect(res.body.error.details).toEqual([
      { path: 'users.1.id', message: `Duplicate user id ${user.id}` },
      { path: 'users.2.kind', message: 'User -2: an account has a positive id, a placeholder a negative one' },
      { path: 'users.3.kind', message: 'User 5: an account has a positive id, a placeholder a negative one' },
      { path: 'space.exportedBy', message: 'The exporting user 77 is not in users' },
      { path: 'tasks.0.createdBy', message: `Task ${broken.tasks[0]!.id}: user 88 is not in users` },
      { path: 'comments.0.authorId', message: `Comment ${broken.comments[0]!.id}: user 89 is not in users` },
      { path: 'comments.1.importedBy', message: `Comment ${broken.comments[1]!.id}: user 90 is not in users` },
      { path: 'worklogs.0.authorId', message: `Work log ${broken.worklogs[0]!.id}: user -91 is not in users` },
      { path: 'activity.0.actorId', message: `Activity ${broken.activity[0]!.id}: user 92 is not in users` },
      { path: 'activity.1.importedBy', message: `Activity ${broken.activity[1]!.id}: user 93 is not in users` },
    ]);
  });

  it('the rows of users are checked one at a time, up to 50 problems; a zero reference is no user', async () => {
    const { archive, analyze } = await owner();
    const many = { ...archive, users: Array.from({ length: 200 }, (_, i) => ({ id: i + 1, kind: 'robot', displayName: '', email: 5 })) };
    const res = await analyze(many as unknown as SpaceArchiveDTO);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^Invalid export file \(more than 50 problems\): users\.0\.kind/);
    expect(res.body.error.details).toHaveLength(51);
    const zero = structuredClone(archive);
    zero.tasks[0]!.createdBy = 0;
    expect((await analyze(zero)).body.error.details).toEqual([{ path: 'tasks.0.createdBy', message: 'Must not be 0' }]);
  });

  it("an address is normalized on use; an invalid one, or a placeholder's, counts as none", async () => {
    const { archive, analyze, user } = await owner();
    const a = structuredClone(archive);
    a.users = [
      { id: user.id, kind: 'account', displayName: 'Owner', email: ' OWNER@Example.COM ' },
      { id: 50, kind: 'account', displayName: 'Bad address', email: 'not an address' },
      { id: -1, kind: 'placeholder', displayName: 'Ghost', email: 'ghost@example.com' },
    ];
    a.tasks[0]!.createdBy = 50;
    a.tasks[1]!.createdBy = -1;
    const res = await analyze(a);
    expect(res.status).toBe(200);
    expect((res.body as ImportAnalysisDTO).users.map((u) => [u.archiveId, u.email])).toEqual([
      [user.id, 'OWNER@example.com'],
      [50, null],
      [-1, null],
    ]);
    // Matched by its normalized key.
    expect(res.body.suggestions[0]).toEqual({ archiveId: user.id, target: { kind: 'user', userId: user.id } });
  });

  it('the mapping field: JSON of ImportMappingInput, bounded', async () => {
    const { client, archive } = await owner();
    const commit = (mapping: unknown) => client.post('/api/data/import/commit?mode=replace', importForm(archive, { mapping }));
    expect(errorOf(await commit('{nope'))).toEqual({
      status: 400,
      error: { code: 'validation_error', message: 'The mapping is not valid JSON', details: [{ path: 'mapping', message: 'Expected an ImportMappingInput as JSON' }] },
    });
    expect((await commit(`[${Array(100_001).fill('0').join(',')}]`)).body.error.message).toBe('The mapping is too large');
    const typed = await commit({ mapping: [{ archiveId: 0, target: { kind: 'robot' } }], skipActivity: 'yes' });
    expect(typed.status).toBe(400);
    expect(typed.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['mapping.0.archiveId', 'mapping.0.target', 'skipActivity']);
  });
});

const errorOf = (res: { status: number; body: { error: unknown } }) => ({ status: res.status, error: res.body.error });
