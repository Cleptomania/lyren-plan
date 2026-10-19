// Every page of a space lives under /s/<spaceId>/ (design §12.2, §12.3): an in-app link to a space
// route is built with useSpacePath() (sp('/projects')) or spaceLink(spaceId, path), and API paths
// go through spaceApi(spaceId). This scans the source text of web/src for absolute space-route
// literals ('/dashboard', `/tasks/${ref}`, "/settings/tags", …) anywhere else, and for the space API's
// own paths ('/bootstrap', '/worklogs', …) given to any client call but spaceApi(…)'s, so a new
// unprefixed link or request fails here instead of leading to the old redirect (or a 404) in the browser.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_SRC = fileURLToPath(new URL('..', import.meta.url));

/** Modules whose business is the paths themselves: the space helpers and the old links' redirect. */
const PATH_MODULES: ReadonlySet<string> = new Set(['app/space.ts', 'app/legacyRedirect.ts']);

/** Exact exceptions, each with the reason it is no in-app link. */
const EXCEPTIONS: ReadonlyArray<{ file: string; literal: string; reason: string }> = [
  {
    file: 'api/client.ts',
    literal: "'/tasks/query'",
    reason: 'CONDITIONAL_POSTS names an API path of the space app (the conditional POST of §6.4.2), compared with what spaceApi() is given',
  },
];

/**
 * The start of a space route in a string literal: a quote, then the route's first segment(s). The
 * settings sections named are a space's only (/settings and /settings/danger are the account's too).
 */
const LITERAL = /(['"`])\/(?:dashboard|projects|boards|tasks|activity|worklog|settings\/(?:statuses|tags|data|members|invitations))(?![\w-])/g;

/**
 * The first segments of the space API's paths that are no page route (server/src/space/app.ts; the page
 * routes above are its paths too): wrong in any call but spaceApi(…)'s, whose prefix they need.
 */
const API_LITERAL = /(['"`])\/(?:bootstrap|milestones|epics|comments|worklogs|tags|statuses|settings|data|search|people)(?![\w-])/g;

/** What may come right before a space-route literal: sp(…), spaceLink(id, …) or a call of a space's API. */
const ALLOWED_BEFORE = /(?:\bsp\(|\bspaceLink\([^()]*,|\bspaceApi\([^()]*\)\.(?:get|post|patch|put|del)(?:<[^()]*>)?\()\s*$/;

/** A client call whose first argument a space API literal is: a method of any object, or request(method, …). */
const CALL_BEFORE = /(?:\.(?:get|post|patch|put|del)(?:<[^()]*>)?\(|\brequest(?:<[^()]*>)?\([^,()]*,)\s*$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.test(?:-utils)?\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return [full];
  });
}

/**
 * The line with its comment blanked out (same length, so offsets stay): a line comment, a line inside a
 * block comment ('* …'), or a block comment that opens the line, up to its end only ('/* x *\/ code').
 */
function codeOf(line: string): string {
  const indent = line.length - line.trimStart().length;
  const trimmed = line.slice(indent);
  if (trimmed.startsWith('//') || (trimmed.startsWith('*') && !trimmed.startsWith('*/'))) return ' '.repeat(line.length);
  if (trimmed.startsWith('/*')) {
    const end = trimmed.indexOf('*/', 2);
    if (end < 0) return ' '.repeat(line.length);
    return ' '.repeat(indent + end + 2) + trimmed.slice(end + 2);
  }
  return line;
}

/** The literal from its opening quote to its closing one (or the end of the line). */
function literalAt(line: string, start: number): string {
  const quote = line[start]!;
  const end = line.indexOf(quote, start + 1);
  return end < 0 ? line.slice(start) : line.slice(start, end + 1);
}

interface Hit {
  file: string;
  line: number;
  literal: string;
}

/** The hits of one source file (`file`: its path under web/src), and the allowed exceptions among them. */
function scanSource(file: string, text: string): { hits: Hit[]; allowed: Hit[] } {
  const hits: Hit[] = [];
  const allowed: Hit[] = [];
  const lines = text.split('\n').map(codeOf);
  const code = lines.join('\n');
  let offset = 0;
  lines.forEach((line, i) => {
    const lineStart = offset;
    offset += line.length + 1;
    // The call may open on a line before (a wrapped argument list).
    const before = (index: number) => code.slice(Math.max(0, lineStart + index - 300), lineStart + index);
    for (const m of line.matchAll(LITERAL)) {
      if (ALLOWED_BEFORE.test(before(m.index))) continue;
      const hit = { file, line: i + 1, literal: literalAt(line, m.index) };
      (EXCEPTIONS.some((x) => x.file === file && x.literal === hit.literal) ? allowed : hits).push(hit);
    }
    for (const m of line.matchAll(API_LITERAL)) {
      const context = before(m.index);
      if (CALL_BEFORE.test(context) && !ALLOWED_BEFORE.test(context)) hits.push({ file, line: i + 1, literal: literalAt(line, m.index) });
    }
  });
  return { hits, allowed };
}

function scan(): { hits: Hit[]; allowed: Hit[] } {
  const hits: Hit[] = [];
  const allowed: Hit[] = [];
  for (const full of sourceFiles(WEB_SRC)) {
    const file = path.relative(WEB_SRC, full).split(path.sep).join('/');
    if (PATH_MODULES.has(file)) continue;
    const found = scanSource(file, readFileSync(full, 'utf8'));
    hits.push(...found.hits);
    allowed.push(...found.allowed);
  }
  return { hits, allowed };
}

describe('space-route literals in web/src', () => {
  const { hits, allowed } = scan();

  it('go through sp() / spaceLink() / spaceApi() everywhere', () => {
    expect(hits.map((h) => `${h.file}:${h.line}: ${h.literal}`)).toEqual([]);
  });

  it('the exceptions are exact and still needed', () => {
    for (const x of EXCEPTIONS) expect(allowed.some((h) => h.file === x.file && h.literal === x.literal), `${x.file} ${x.literal}`).toBe(true);
  });

  it('the scan finds what it is meant to find', () => {
    const probe = (source: string) => scanSource('features/probe/Probe.tsx', source).hits.map((h) => h.literal);
    // Links to space pages.
    expect(probe(`<Link to="/projects">`)).toEqual(['"/projects"']);
    expect(probe("<Link to={'/projects'}>")).toEqual(["'/projects'"]);
    expect(probe("navigate(`/tasks/${task.ref}`)")).toEqual(['`/tasks/${task.ref}`']);
    expect(probe('navigate(\n  `/tasks/${1}`,\n)')).toEqual(['`/tasks/${1}`']);
    expect(probe("{ to: '/settings/tags' }")).toEqual(["'/settings/tags'"]);
    expect(probe('<Link to="/settings/members">')).toEqual(['"/settings/members"']);
    // A block comment opening the line hides only itself.
    expect(probe("/* c */ navigate('/dashboard')")).toEqual(["'/dashboard'"]);
    expect(probe("/* navigate('/dashboard') */")).toEqual([]);
    expect(probe("// navigate('/dashboard')")).toEqual([]);
    expect(probe(" * navigate('/dashboard')")).toEqual([]);
    // The space API through anything but spaceApi(…).
    expect(probe("http.get('/bootstrap')")).toEqual(["'/bootstrap'"]);
    expect(probe("http.get<WorklogReport>('/worklogs')")).toEqual(["'/worklogs'"]);
    expect(probe("http.post('/statuses', {})")).toEqual(["'/statuses'"]);
    expect(probe("request<{ ok: true }>('POST', '/data/import', body)")).toEqual(["'/data/import'"]);
    expect(probe("const api = http; api.get('/tasks/query'); api.post('/projects', {}); api.patch('/settings', {})")).toEqual([
      "'/tasks/query'",
      "'/projects'",
      "'/settings'",
    ]);
    // What is right.
    expect(probe("<Link to={sp('/projects')}>")).toEqual([]);
    expect(probe("spaceLink(spaceId, '/settings/members')")).toEqual([]);
    expect(probe("spaceApi(sid).get<BootstrapDTO>('/bootstrap')")).toEqual([]);
    expect(probe("spaceApi(spaceId).patch<SpaceSettings>(\n  '/settings',\n  space,\n)")).toEqual([]);
    expect(probe("go('/settings')")).toEqual([]);
    expect(probe("navigate('/settings/danger')")).toEqual([]);
    expect(probe("http.patch('/account/preferences', patch)")).toEqual([]);
    expect(probe("'/spaces'")).toEqual([]);
    expect(probe("'/projectsx'")).toEqual([]);
    expect(probe("const SECTIONS = ['/tags', '/statuses']")).toEqual([]);
    // Every kind of source file is read, tests and their helpers excepted.
    const files = sourceFiles(WEB_SRC).map((f) => path.basename(f));
    expect(files).toContain('main.tsx');
    expect(files.some((f) => f.includes('.test.'))).toBe(false);
    expect(['probe.js', 'probe.jsx', 'probe.mjs'].every((f) => /\.[cm]?[jt]sx?$/.test(f))).toBe(true);
  });
});
