// React.memo comparison for TaskCard / TaskRow: shallow, except that `fields` (object) and
// `hide` (array) compare by content, so inline literals like hide={['project']} don't
// defeat memoization of long lists.

type Props = Record<string, unknown>;

function shallowEqualObjects(a: object, b: object): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Props)[k], (b as Props)[k]));
}

function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

const CONTENT_KEYS = new Set(['fields', 'hide']);

export function taskItemPropsEqual<P extends object>(prev: P, next: P): boolean {
  const p = prev as Props;
  const n = next as Props;
  const keys = new Set([...Object.keys(p), ...Object.keys(n)]);
  for (const key of keys) {
    const a = p[key];
    const b = n[key];
    if (Object.is(a, b)) continue;
    if (!CONTENT_KEYS.has(key) || typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const equal = Array.isArray(a) ? sameArray(a, b as unknown[]) : shallowEqualObjects(a, b);
    if (!equal) return false;
  }
  return true;
}
