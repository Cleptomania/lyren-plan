// The quick check of an import file in the browser (design §12.10), before anything is sent: a space archive
// (`lyren-plan-space`, version 2, gzip-compressed as Download space archive writes it) or an export of Lyren Plan
// 1.x (`lyren-plan-export`, version 1, plain JSON). The file is read, unpacked with DecompressionStream when it
// starts with gzip's magic bytes, decoded and parsed, then checked as the server begins its check
// (shared/src/archive.ts, export.ts): the format and version, the frame (the header, each table a list within
// its cap), then each row on its own through parseBounded, stopping at the first few problems, so that a large
// file of bad rows never makes millions of issues (Appendix D 44). What it holds is summarised for the steps
// that follow. The server reads and validates the file again, references included (SPEC §5.10); the file
// itself is what both requests send. Pure apart from reading the Blob, so it is unit-tested.

import type { z } from 'zod';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  archiveFrameSchema,
  archiveRowSchemas,
  archiveUserSchema,
  EXPORT_FORMAT,
  formatVersionText,
  isGzip,
} from '@shared/archive';
import { parseBounded } from '@shared/bounded';
import { EXPORT_TABLES, exportFrameSchema, exportRowSchemas, type ExportTable } from '@shared/export';

export interface ImportCount {
  key: ExportTable;
  label: string;
  count: number;
}

export interface ArchiveSummary {
  version: 1 | 2;
  exportedAt: string;
  appVersion: string;
  /** The archive's space name (v2); null for a v1 export, which has none. */
  spaceName: string | null;
  counts: ImportCount[];
  /** The people a v2 archive lists (0 for v1, whose every entry becomes the importer's). */
  people: number;
}

export type ArchiveCheck = { ok: true; summary: ArchiveSummary } | { ok: false; error: string; problems: string[] };

/** The tables as the summary lists them. */
export const COUNTED: ReadonlyArray<[key: ExportTable, label: string]> = [
  ['projects', 'Projects'],
  ['milestones', 'Milestones'],
  ['epics', 'Epics'],
  ['tasks', 'Tasks'],
  ['comments', 'Comments'],
  ['worklogs', 'Work logs'],
  ['tags', 'Tags'],
  ['statuses', 'Statuses'],
  ['boards', 'Boards'],
  ['activity', 'Activity entries'],
];

/** Problems listed at most; the server lists 50 when the file is sent anyway. */
export const MAX_PROBLEMS = 5;

const MIB = 1024 * 1024;
const KIB = 1024;

/** A size as the server's messages write it (space/archive/read.ts sizeText): MB or KB, one decimal at most. */
export function sizeText(bytes: number): string {
  if (bytes >= MIB) return `${Math.round((bytes / MIB) * 10) / 10} MB`;
  if (bytes >= KIB) return `${Math.round((bytes / KIB) * 10) / 10} KB`;
  return `${bytes} bytes`;
}

const refused = (error: string, problems: string[] = []): ArchiveCheck => ({ ok: false, error, problems });

const NOT_JSON = 'The file is not valid JSON.';
/** A file that is no JSON text at all (a picture, a text file picked by mistake), rather than a damaged export. */
const NOT_ARCHIVE = 'This is not a Lyren Plan archive (.json.gz) or 1.x export (.json).';

/** Whether `bytes` start as a JSON object does: an optional UTF-8 BOM, white space, then `{`. */
function startsLikeObject(bytes: Uint8Array): boolean {
  let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return bytes[i] === 0x7b;
}

/** Thrown while reading: the check's answer. */
class Unreadable extends Error {}

/** The file's text: unpacked when it is gzip (at most `maxBytes` unpacked), decoded as UTF-8 (fatal). */
export async function fileText(file: Blob, maxBytes: number | null): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const decoder = new TextDecoder('utf-8', { fatal: true });
  if (!isGzip(head)) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return decoder.decode(bytes);
    } catch {
      // Neither gzip nor UTF-8: a damaged export when it starts like one, else no export at all (a picture).
      throw new Unreadable(startsLikeObject(bytes) ? NOT_JSON : NOT_ARCHIVE);
    }
  }
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new Unreadable('The file is not a valid gzip file.');
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (maxBytes !== null && size > maxBytes) {
      reader.cancel().catch(() => {});
      throw new Unreadable(`The archive is larger than ${sizeText(maxBytes)} unpacked, which is more than this instance accepts.`);
    }
    try {
      parts.push(decoder.decode(chunk.value, { stream: true }));
    } catch {
      reader.cancel().catch(() => {});
      throw new Unreadable(NOT_JSON);
    }
  }
  try {
    parts.push(decoder.decode());
  } catch {
    throw new Unreadable(NOT_JSON);
  }
  return parts.join('');
}

/**
 * Read and check `file` (see the header). `maxBytes` is the instance's IMPORT_BODY_LIMIT
 * (InstanceInfoDTO.limits.importMaxBytes), which the upload and the unpacked archive must both keep to.
 */
export async function readImportFile(file: Blob, maxBytes: number | null): Promise<ArchiveCheck> {
  if (maxBytes !== null && file.size > maxBytes) {
    return refused(`The file is larger than this instance accepts (${sizeText(maxBytes)}).`);
  }
  let text: string;
  try {
    text = await fileText(file, maxBytes);
  } catch (err) {
    return refused(err instanceof Unreadable ? err.message : 'The file could not be read.');
  }
  return checkArchiveText(text);
}

export function checkArchiveText(text: string): ArchiveCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // An export is a JSON object: text that does not start like one was never an export.
    return refused(/^\uFEFF?[ \t\n\r]*\{/.test(text) ? NOT_JSON : NOT_ARCHIVE);
  }
  return checkArchive(raw);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function issueText(issue: z.core.$ZodIssue, prefix: string): string {
  const where = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/** Check a parsed file (see the header). */
export function checkArchive(raw: unknown): ArchiveCheck {
  if (!isPlainObject(raw) || (raw.format !== ARCHIVE_FORMAT && raw.format !== EXPORT_FORMAT)) {
    return refused('This is not a Lyren Plan export file.');
  }
  const version = raw.format === ARCHIVE_FORMAT ? ARCHIVE_FORMAT_VERSION : 1;
  if (raw.formatVersion !== version) {
    const named = formatVersionText(raw.formatVersion);
    return refused(`This export uses ${named === null ? 'a format version' : `format version ${named}`}, which this version of Lyren Plan cannot import.`);
  }

  const problems: string[] = [];
  let more = false;
  const add = (text: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(text);
    else more = true;
  };
  const frame = (version === 2 ? archiveFrameSchema : exportFrameSchema).safeParse(raw);
  const frameIssues = frame.success ? [] : frame.error.issues;
  for (const issue of frameIssues) add(issueText(issue, ''));
  const schemas: Array<[ExportTable | 'users', z.ZodType]> = [
    ...(version === 2 ? [['users', archiveUserSchema] as [ExportTable | 'users', z.ZodType]] : []),
    ...EXPORT_TABLES.map((table): [ExportTable, z.ZodType] => [table, (version === 2 ? archiveRowSchemas : exportRowSchemas)[table]]),
  ];
  for (const [table, schema] of schemas) {
    const list = raw[table];
    if (!Array.isArray(list) || frameIssues.some((issue) => issue.path[0] === table)) continue;
    for (let i = 0; i < list.length && !more; i++) {
      const row = parseBounded(schema, list[i]);
      if (row === null) add(`${table}.${i}: Invalid row (too many values to list its problems)`);
      else if (!row.success) for (const issue of row.error.issues) add(issueText(issue, `${table}.${i}`));
    }
  }
  if (problems.length > 0 || !frame.success) {
    return refused('The file does not match the export format.', more ? [...problems, '…and more problems'] : problems);
  }

  const data = frame.data as unknown as Record<string, unknown[]>;
  const space = version === 2 ? (frame.data as z.output<typeof archiveFrameSchema>).space : null;
  return {
    ok: true,
    summary: {
      version,
      exportedAt: frame.data.exportedAt,
      appVersion: frame.data.appVersion,
      spaceName: space?.name ?? null,
      counts: COUNTED.map(([key, label]) => ({ key, label, count: data[key]?.length ?? 0 })),
      people: version === 2 ? (data.users?.length ?? 0) : 0,
    },
  };
}
