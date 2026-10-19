// Reading an import request (design §8.4, "Request handling"): POST …/data/import/{analyze,commit} send the file
// as the multipart field `file` (commit also `mapping`, JSON). The gate has read the whole body under
// IMPORT_BODY_LIMIT already. Then:
//   1. `file` must be a File;
//   2. gzip (its first two bytes are 1f 8b) is unpacked through DecompressionStream, the unpacked bytes counted
//      and the read stopped past IMPORT_BODY_LIMIT (413; a zip bomb ends at the counter);
//   3. TextDecoder, fatal (the file must be UTF-8);
//   4. the JSON values counted before parsing (values.ts; 413 past IMPORT_MAX_JSON_VALUES, 400 nested too deeply);
//   5. JSON.parse (400 "The file is not valid JSON");
//   6. the format, its version and everything else validate.ts checks.
// The caller runs this inside Deps.space.importGate (one import at a time: in the process on Node, in the space on
// Cloudflare).

import type { Context } from 'hono';
import { isGzip } from '@shared/archive';
import { importMappingInput } from '@shared/schemas';
import type { SpaceAppConfig } from '../../core/config';
import type { AppEnv } from '../../env';
import { badRequest, payloadTooLarge } from '../../http/errors';
import { parseInput } from '../../http/validate';
import type { ImportMapping } from './commit';
import { validateArchive, type ImportArchive } from './validate';
import { jsonShapeProblem } from './values';

const KIB = 1024;
const MIB = 1024 * KIB;

/** A byte count as the refusals name it: "4 MB", "1.5 MB", "512 KB". */
export function sizeText(bytes: number): string {
  if (bytes >= MIB) return `${Math.round((bytes / MIB) * 10) / 10} MB`;
  if (bytes >= KIB) return `${Math.round((bytes / KIB) * 10) / 10} KB`;
  return `${bytes} bytes`;
}

/** The fatal decoder: bytes that are not UTF-8 make the file no JSON at all. */
const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** A form field's value (FormDataEntryValue). */
export type FormValue = string | File;

const notJson = () => badRequest('The file is not valid JSON');

/** The file's text: unpacked when it is gzip, counted against `limit` (step 2), decoded (step 3). */
async function fileText(file: File, limit: number): Promise<string> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  if (!isGzip(head)) {
    try {
      return decoder().decode(await file.arrayBuffer());
    } catch {
      throw notJson();
    }
  }
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const text = decoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch {
      throw badRequest('The file is not a valid gzip file');
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      // Not awaited: nothing is left to wait for.
      reader.cancel().catch(() => {});
      throw payloadTooLarge(`The archive is larger than ${sizeText(limit)} unpacked`);
    }
    try {
      parts.push(text.decode(chunk.value, { stream: true }));
    } catch {
      reader.cancel().catch(() => {});
      throw notJson();
    }
  }
  try {
    parts.push(text.decode());
  } catch {
    throw notJson();
  }
  return parts.join('');
}

/** The request's form; 400 when the body is no multipart form or has no file. */
async function readForm(c: Context<AppEnv>): Promise<{ file: File; mapping: FormValue | null }> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest('Send the file as the multipart field "file"', [{ path: 'file', message: 'Required' }]);
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('Choose a file to import', [{ path: 'file', message: 'Required' }]);
  return { file, mapping: form.get('mapping') };
}

/** Steps 1-6 (see the header): the request's archive, validated, and its `mapping` field as sent. */
export async function readImportRequest(
  c: Context<AppEnv>,
  config: Pick<SpaceAppConfig, 'importBodyLimit' | 'importMaxJsonValues'>,
): Promise<{ archive: ImportArchive; mapping: FormValue | null }> {
  const { file, mapping } = await readForm(c);
  const text = await fileText(file, config.importBodyLimit);
  const shape = jsonShapeProblem(text, config.importMaxJsonValues);
  if (shape === 'values') throw payloadTooLarge('The archive has more entries than this instance accepts.');
  if (shape === 'depth') throw badRequest('The file is nested too deeply to be an export file');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw notJson();
  }
  return { archive: validateArchive(body), mapping };
}

/** JSON values a mapping holds at most: its 10,000 entries of a few values each. */
const MAPPING_MAX_VALUES = 100_000;

/** A commit's `mapping` field (JSON ImportMappingInput, counted, then parsed bounded); none is an empty mapping. */
export function readMapping(field: FormValue | null): ImportMapping {
  if (field === null) return { mapping: [] };
  const invalid = (message: string) => badRequest(message, [{ path: 'mapping', message: 'Expected an ImportMappingInput as JSON' }]);
  if (typeof field !== 'string') throw invalid('The mapping must be text');
  if (jsonShapeProblem(field, MAPPING_MAX_VALUES) !== null) throw invalid('The mapping is too large');
  let value: unknown;
  try {
    value = JSON.parse(field);
  } catch {
    throw invalid('The mapping is not valid JSON');
  }
  return parseInput(importMappingInput, value);
}
