// The source tree must build on case-insensitive file systems (NTFS on Windows, APFS on macOS).
// There `./Estimate` resolves to estimate.ts when both estimate.ts and Estimate.tsx exist (module
// resolution tries .ts before .tsx), so two modules whose names differ only in letter case break
// the build there, while Linux, where the project is usually developed, never notices.
// tsconfig's forceConsistentCasingInFileNames does not catch this on a case-sensitive disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_DIRS = ['web', 'shared', 'server', 'scripts'];
const SKIP = new Set(['node_modules', 'dist', '.cache']);
const MODULE_EXT = /\.(?:[cm]?[jt]sx?|d\.ts)$/i;

/**
 * Names in one folder that a case-insensitive file system or module resolution can't tell apart:
 * entries equal ignoring case (Readme.md / README.md), and modules or folders equal ignoring case
 * once the extension is dropped (Estimate.tsx / estimate.ts, utils/ / Utils.ts).
 */
export function caseCollisions(names) {
  const groups = new Map();
  const add = (key, name) => {
    const list = groups.get(key) ?? [];
    if (!list.includes(name)) list.push(name);
    groups.set(key, list);
  };
  for (const { name, dir } of names) {
    add(`entry:${name.toLowerCase()}`, name);
    if (dir) add(`module:${name.toLowerCase()}`, name);
    else if (MODULE_EXT.test(name)) add(`module:${name.replace(MODULE_EXT, '').toLowerCase()}`, name);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // Only a problem when the spellings really differ in case (foo.ts + foo.tsx is fine).
    const stems = new Set(list.map((n) => n.replace(MODULE_EXT, '')));
    if (stems.size > 1 || new Set(list).size !== new Set(list.map((n) => n.toLowerCase())).size) out.push(list.sort());
  }
  return out;
}

function walk(dir, found, recurse = true) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = entries.filter((e) => !SKIP.has(e.name)).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  for (const group of caseCollisions(names)) found.push(`${path.relative(ROOT, dir) || '.'}: ${group.join(', ')}`);
  if (recurse) for (const e of names) if (e.dir) walk(path.join(dir, e.name), found);
}

describe('case-insensitive file systems', () => {
  it('finds names that differ only in letter case', () => {
    const f = (name, dir = false) => ({ name, dir });
    expect(caseCollisions([f('Estimate.tsx'), f('estimate.ts')])).toEqual([['Estimate.tsx', 'estimate.ts']]);
    expect(caseCollisions([f('README.md'), f('Readme.md')])).toEqual([['README.md', 'Readme.md']]);
    expect(caseCollisions([f('utils', true), f('Utils.ts')])).toEqual([['Utils.ts', 'utils']]);
    // Same stem, same case: different files a resolver tells apart by extension or picks by order.
    expect(caseCollisions([f('Estimate.tsx'), f('estimateInput.ts'), f('index.ts'), f('index.css')])).toEqual([]);
    expect(caseCollisions([f('foo.ts'), f('foo.test.ts'), f('foo', true)])).toEqual([]);
  });

  it('no two files or modules in one folder of the source tree differ only in case', () => {
    const found = [];
    for (const d of SOURCE_DIRS) walk(path.join(ROOT, d), found);
    walk(ROOT, found, false);
    expect(found).toEqual([]);
  });
});
