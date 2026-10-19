import { describe, expect, it } from 'vitest';
import { checkArchive, checkArchiveText, MAX_PROBLEMS, readImportFile, sizeText } from './archiveFile';

const tables = { tags: [], projects: [], milestones: [], epics: [], tasks: [], comments: [], worklogs: [], activity: [], boards: [] };
const statuses = [{ id: 1, name: 'Todo', category: 'unstarted', color: '#64748b', position: 0 }];

const v1 = {
  format: 'lyren-plan-export',
  formatVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  appVersion: '1.0.0',
  settings: { weekStartsOn: 1, estimateUnit: 'points', defaultBoardId: null, homePage: 'dashboard' },
  statuses,
  ...tables,
};

const v2 = {
  format: 'lyren-plan-space',
  formatVersion: 2,
  exportedAt: '2026-10-18T12:00:00.000Z',
  appVersion: '1.1.0',
  space: { id: '7k2m9q4w8x1c3v5b', name: 'Team space', exportedBy: 3 },
  users: [
    { id: 3, kind: 'account', displayName: 'Alice', email: 'alice@example.com' },
    { id: -1, kind: 'placeholder', displayName: 'Carol', email: null },
  ],
  settings: { estimateUnit: 'hours', defaultBoardId: null },
  statuses,
  ...tables,
  projects: [
    {
      id: 1,
      key: 'WEB',
      name: 'Website',
      description: '',
      color: '#6366f1',
      status: 'active',
      position: 0,
      taskCounter: 1,
      createdAt: '2026-09-19T01:50:17.059Z',
      updatedAt: '2026-09-19T01:50:17.059Z',
    },
  ],
  comments: [{ id: 1, taskId: 1, body: 'Hi', authorId: -1, createdAt: '2026-10-18T01:48:17.059Z', updatedAt: '2026-10-18T01:48:17.059Z', editedAt: null, importedBy: 3, importedAt: '2026-10-18T02:00:00.000Z' }],
};

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

describe('checkArchive', () => {
  it('summarises a v1 export: no space name, no people', () => {
    const res = checkArchiveText(JSON.stringify(v1));
    expect(res).toMatchObject({ ok: true, summary: { version: 1, appVersion: '1.0.0', spaceName: null, people: 0 } });
    if (!res.ok) return;
    expect(res.summary.counts.find((c) => c.key === 'statuses')?.count).toBe(1);
    expect(res.summary.counts.map((c) => c.label)).toEqual([
      'Projects',
      'Milestones',
      'Epics',
      'Tasks',
      'Comments',
      'Work logs',
      'Tags',
      'Statuses',
      'Boards',
      'Activity entries',
    ]);
  });

  it('summarises a v2 archive: its space name and people (rows with provenance included)', () => {
    const res = checkArchive(v2);
    expect(res).toMatchObject({ ok: true, summary: { version: 2, exportedAt: '2026-10-18T12:00:00.000Z', spaceName: 'Team space', people: 2 } });
    if (!res.ok) return;
    expect(res.summary.counts.find((c) => c.key === 'projects')?.count).toBe(1);
    expect(res.summary.counts.find((c) => c.key === 'comments')?.count).toBe(1);
  });

  it('refuses what is no export, or another format version', () => {
    expect(checkArchiveText('{nope')).toEqual({ ok: false, error: 'The file is not valid JSON.', problems: [] });
    expect(checkArchive([])).toMatchObject({ ok: false, error: 'This is not a Lyren Plan export file.' });
    expect(checkArchive({ ...v2, format: 'other' })).toMatchObject({ ok: false, error: 'This is not a Lyren Plan export file.' });
    expect(checkArchive({ ...v1, formatVersion: 2 })).toMatchObject({ ok: false, error: expect.stringMatching(/format version 2,/) });
    expect(checkArchive({ ...v2, formatVersion: 3 })).toMatchObject({ ok: false, error: expect.stringMatching(/format version 3,/) });
    expect(checkArchive({ ...v2, formatVersion: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/format version 1,/) });
    // A version that is no short value is not repeated.
    const long = checkArchive({ ...v2, formatVersion: 'v'.repeat(100_000) });
    expect(long).toEqual({ ok: false, error: 'This export uses a format version, which this version of Lyren Plan cannot import.', problems: [] });
  });

  it('says that text which is no JSON object at all is no archive, and a damaged export that it is no valid JSON', () => {
    const notArchive = { ok: false, error: 'This is not a Lyren Plan archive (.json.gz) or 1.x export (.json).', problems: [] };
    expect(checkArchiveText('Shopping list:\n- milk')).toEqual(notArchive);
    expect(checkArchiveText('')).toEqual(notArchive);
    expect(checkArchiveText('\uFEFF \n{"format": ')).toMatchObject({ error: 'The file is not valid JSON.' });
  });

  it('lists the first problems of the frame and of the rows, one row at a time', () => {
    const bad = checkArchive({ ...v1, statuses: [], tags: [{ id: 'x' }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBe('The file does not match the export format.');
    expect(bad.problems[0]).toMatch(/^statuses: /);
    expect(bad.problems.some((p) => p.startsWith('tags.0.'))).toBe(true);

    // A v2 user with a bad id and a row user reference of 0.
    const users = checkArchive({ ...v2, users: [{ id: 0, kind: 'account', displayName: 'X', email: null }] });
    expect(users).toMatchObject({ ok: false, problems: [expect.stringMatching(/^users\.0\.id: /)] });
  });

  it('stops after the first problems, whatever the file holds', () => {
    const many = checkArchive({ ...v1, tags: Array.from({ length: 10_000 }, () => ({ id: 0 })) });
    expect(many.ok).toBe(false);
    if (many.ok) return;
    expect(many.problems).toHaveLength(MAX_PROBLEMS + 1);
    expect(many.problems.at(-1)).toBe('…and more problems');
    // A row too large to describe is one problem.
    const big = checkArchive({ ...v1, tags: [{ id: 1, name: Array(6000).fill(0), color: '#000000', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'y' }] });
    expect(big.ok).toBe(false);
    if (big.ok) return;
    expect(big.problems[0]).toBe('tags.0: Invalid row (too many values to list its problems)');
  });
});

describe('readImportFile', () => {
  it('reads plain JSON and gzip (as exported) alike', async () => {
    expect(await readImportFile(new Blob([JSON.stringify(v1)]), null)).toMatchObject({ ok: true, summary: { version: 1 } });
    expect(await readImportFile(await gzip(JSON.stringify(v2)), 1024 * 1024)).toMatchObject({ ok: true, summary: { version: 2, spaceName: 'Team space' } });
  });

  it('refuses a file over the instance’s limit, packed or unpacked', async () => {
    const text = JSON.stringify(v2);
    expect(await readImportFile(new Blob([text]), 100)).toEqual({
      ok: false,
      error: 'The file is larger than this instance accepts (100 bytes).',
      problems: [],
    });
    const packed = await gzip(text + ' '.repeat(10_000));
    expect(packed.size).toBeLessThan(4096);
    expect(await readImportFile(packed, 4096)).toEqual({
      ok: false,
      error: 'The archive is larger than 4 KB unpacked, which is more than this instance accepts.',
      problems: [],
    });
  });

  it('refuses damaged gzip and bytes that are not UTF-8', async () => {
    const packed = new Uint8Array(await (await gzip(JSON.stringify(v2))).arrayBuffer());
    expect(await readImportFile(new Blob([packed.slice(0, packed.length - 12)]), null)).toMatchObject({ ok: false, error: 'The file is not a valid gzip file.' });
    expect(await readImportFile(new Blob([new Uint8Array([0x7b, 0xff, 0x7d])]), null)).toMatchObject({ ok: false, error: 'The file is not valid JSON.' });
    // A picture: neither gzip nor UTF-8, nor anything like an export.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    expect(await readImportFile(new Blob([png]), null)).toMatchObject({ ok: false, error: 'This is not a Lyren Plan archive (.json.gz) or 1.x export (.json).' });
  });
});

describe('sizeText', () => {
  it('writes MB and KB with one decimal at most, as the server does', () => {
    expect(sizeText(50 * 1024 * 1024)).toBe('50 MB');
    expect(sizeText(4 * 1024 * 1024 + 300_000)).toBe('4.3 MB');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(12)).toBe('12 bytes');
  });
});
