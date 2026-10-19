// What the archive tests share (design §8, §14.5): the multipart body an import sends (the file as text, JSON,
// bytes or gzip, and the mapping), unpacking an exported archive, the import's two requests in a row, and
// comparing two archives (exportedAt, the only field that legitimately differs, left out). Runtime-neutral, so
// the workers tests use it as well (their client sends the form).

import { gunzipSync, gzipSync } from 'node:zlib';
import { DEFAULT_PREFERENCES, type ImportMode } from '@shared/schemas';
import type { ExportDTO, ImportAnalysisDTO, SpaceArchiveDTO } from '@shared/types';
import type { Db } from '../../src/core/db';
import { archivePieces, type ArchiveInfo } from '../../src/space/archive/export';

/** The multipart body of an analyze or commit: `file` (text as it is, bytes, or anything else as JSON), gzipped when asked. */
export function importForm(file: unknown, o: { mapping?: unknown; gzip?: boolean; name?: string } = {}): FormData {
  let bytes: Uint8Array =
    file instanceof Uint8Array ? file : new TextEncoder().encode(typeof file === 'string' ? file : JSON.stringify(file));
  if (o.gzip) bytes = gzipSync(bytes);
  const form = new FormData();
  form.set('file', new File([bytes], o.name ?? (o.gzip ? 'archive.json.gz' : 'archive.json')));
  if (o.mapping !== undefined) form.set('mapping', typeof o.mapping === 'string' ? o.mapping : JSON.stringify(o.mapping));
  return form;
}

/** A form as the multipart bytes a browser sends, and their Content-Type (with the boundary). */
export async function formBytes(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const encoded = new Response(form);
  return { body: new Uint8Array(await encoded.arrayBuffer()), contentType: encoded.headers.get('content-type')! };
}

/** An exported archive's JSON. */
export function unpackArchive(bytes: Uint8Array): SpaceArchiveDTO {
  return JSON.parse(new TextDecoder().decode(gunzipSync(bytes))) as SpaceArchiveDTO;
}

/** An archive without exportedAt, for comparing two exports. */
export const comparableArchive = (a: SpaceArchiveDTO) => ({ ...a, exportedAt: '' });

/** The mapping an analysis suggests (every referenced user to its suggestion), with `extra` (skipActivity). */
export const suggestedMapping = (analysis: Pick<ImportAnalysisDTO, 'suggestions'>, extra: { skipActivity?: boolean } = {}) => ({
  mapping: analysis.suggestions,
  ...extra,
});

/** A client that sends a form: the test harnesses' and the Worker's. */
export interface FormClient {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
}

/**
 * Analyze, then commit with the suggested mapping (or `mapping`): what the web does. `path` is the space's data
 * prefix ('/api/data' for the test harnesses, '/api/s/<id>/data' through the Worker). Returns both answers; the
 * commit is not sent when the analysis fails.
 */
export async function importArchive(
  client: FormClient,
  o: { path?: string; mode: ImportMode; file: unknown; gzip?: boolean; mapping?: unknown; skipActivity?: boolean },
) {
  const prefix = o.path ?? '/api/data';
  const analysis = await client.request('POST', `${prefix}/import/analyze?mode=${o.mode}`, importForm(o.file, { gzip: o.gzip }));
  if (analysis.status !== 200) return { analysis, commit: analysis };
  const mapping = o.mapping ?? suggestedMapping(analysis.body as ImportAnalysisDTO, o.skipActivity ? { skipActivity: true } : {});
  const commit = await client.request('POST', `${prefix}/import/commit?mode=${o.mode}`, importForm(o.file, { gzip: o.gzip, mapping }));
  return { analysis, commit };
}

/** The archive of the space in `db` as archivePieces writes it, parsed (exportedAt fixed, for comparisons). */
export function archiveOf(db: Db, info: Partial<ArchiveInfo> = {}): SpaceArchiveDTO {
  const pieces = archivePieces(db, { spaceId: 'test', name: 'Test', exportedBy: 1, appVersion: 'test', exportedAt: '', ...info });
  return JSON.parse([...pieces].join('')) as SpaceArchiveDTO;
}

/** A test client's export: GET …/data/export, its status and headers, and the archive unpacked. */
export async function downloadArchive(client: { raw(method: string, path: string): Promise<Response> }, path = '/api/data/export') {
  const res = await client.raw('GET', path);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, archive: res.status === 200 ? unpackArchive(bytes) : null };
}

/** A replace import in one request: a v1 file needs no mapping, an archive gets `mapping`. */
export function replaceImport(client: FormClient, file: unknown, o: { mapping?: unknown; gzip?: boolean; path?: string } = {}) {
  return client.request('POST', `${o.path ?? '/api/data'}/import/commit?mode=replace`, importForm(file, o));
}

/**
 * A v1 export with the rows of `archive` (an archive whose users are all accounts: v1 references are positive
 * ids), as the export before archive v2 wrote it.
 */
export function v1Of(archive: SpaceArchiveDTO): ExportDTO {
  const strip = <T extends { importedBy?: unknown; importedAt?: unknown }>({ importedBy: _by, importedAt: _at, ...row }: T) => row;
  return {
    format: 'lyren-plan-export',
    formatVersion: 1,
    exportedAt: archive.exportedAt,
    appVersion: archive.appVersion,
    settings: { ...DEFAULT_PREFERENCES, ...archive.settings },
    statuses: archive.statuses,
    tags: archive.tags,
    projects: archive.projects,
    milestones: archive.milestones,
    epics: archive.epics,
    tasks: archive.tasks,
    comments: archive.comments.map(strip),
    worklogs: archive.worklogs.map(strip),
    activity: archive.activity.map(strip),
    boards: archive.boards,
  };
}

/**
 * The mapping that gives every user of `archive` its own id again (accounts) or a new placeholder, for an
 * instance whose accounts have the archive's ids (the cross-runtime fixture, server/test/fixtures/spaceArchive.json).
 */
export const identityMapping = (archive: Pick<SpaceArchiveDTO, 'users'>) => ({
  mapping: archive.users.map((u) => ({
    archiveId: u.id,
    target: u.kind === 'account' ? { kind: 'user' as const, userId: u.id } : { kind: 'placeholder' as const },
  })),
});

/** Two exports of the same content compared: exportedAt, the app version and the space named left out. */
export const sameContent = (a: SpaceArchiveDTO) => ({ ...a, exportedAt: '', appVersion: '', space: { ...a.space, id: '', name: '' } });
