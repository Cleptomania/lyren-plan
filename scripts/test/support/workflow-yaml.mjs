// A reader for the YAML of this repository's GitHub workflows, for the tests that check them: the repository
// has no YAML package, and actionlint is not part of npm run check. It reads block mappings and sequences,
// plain and quoted scalars (all kept as strings), flow sequences of scalars ([a, 'b']), literal blocks (|, |-)
// and comments. Anything else (flow mappings, anchors, aliases, tags, folded or multi-line plain scalars,
// tabs, duplicate keys, a ": " inside a plain scalar) throws, so a workflow it cannot read fails its test
// instead of being misread.

/** The value of a workflow file. */
export function parseWorkflowYaml(text) {
  const lines = text.split('\n').map((raw, n) => {
    if (/^\s*\t/.test(raw)) throw new Error(`Line ${n + 1}: tab in the indentation`);
    return { n: n + 1, raw, indent: raw.length - raw.trimStart().length };
  });
  const state = { lines, i: 0 };
  skipBlank(state);
  if (state.i >= lines.length) return null;
  const value = parseBlock(state, lines[state.i].indent);
  skipBlank(state);
  if (state.i < lines.length) throw new Error(`Line ${lines[state.i].n}: unexpected indentation`);
  return value;
}

const isBlank = (line) => line.raw.trim() === '' || line.raw.trimStart().startsWith('#');

function skipBlank(state) {
  while (state.i < state.lines.length && isBlank(state.lines[state.i])) state.i++;
}

/** The line's text from `from` on, without a comment (a # after white space, outside quotes). */
function content(line, from = line.indent) {
  const text = line.raw.slice(from);
  let quote = null;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (k === 0 || /[\s[,]/.test(text[k - 1]))) {
      quote = c;
    } else if (c === '#' && (k === 0 || /\s/.test(text[k - 1]))) {
      return text.slice(0, k).trimEnd();
    }
  }
  return text.trimEnd();
}

function parseBlock(state, indent) {
  const line = state.lines[state.i];
  const text = content(line);
  return text === '-' || text.startsWith('- ') ? parseSequence(state, indent) : parseMapping(state, indent);
}

function parseSequence(state, indent) {
  const items = [];
  for (;;) {
    skipBlank(state);
    const line = state.lines[state.i];
    if (!line || line.indent < indent) return items;
    if (line.indent > indent) throw new Error(`Line ${line.n}: unexpected indentation`);
    const text = content(line);
    if (text !== '-' && !text.startsWith('- ')) throw new Error(`Line ${line.n}: expected a list item`);
    const rest = text.slice(1).trimStart();
    if (rest === '') {
      state.i++;
      items.push(nested(state, indent));
    } else if (keyOf(rest) !== null) {
      // A mapping that starts on the item's line: its keys are where this one is.
      const at = line.indent + text.indexOf(rest);
      state.lines[state.i] = { ...line, indent: at, raw: ' '.repeat(at) + line.raw.slice(at) };
      items.push(parseMapping(state, at));
    } else {
      state.i++;
      items.push(scalar(rest, line));
    }
  }
}

/** The key of `key: value` or `key:` text, or null. */
function keyOf(text) {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#[\]{},&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s|$)/.exec(text);
  return m ? { key: unquote(m[1]), rest: text.slice(m[0].length).trim() } : null;
}

function parseMapping(state, indent) {
  const map = {};
  for (;;) {
    skipBlank(state);
    const line = state.lines[state.i];
    if (!line || line.indent < indent) return map;
    if (line.indent > indent) throw new Error(`Line ${line.n}: unexpected indentation`);
    const entry = keyOf(content(line));
    if (entry === null) throw new Error(`Line ${line.n}: expected key: value`);
    if (Object.hasOwn(map, entry.key)) throw new Error(`Line ${line.n}: duplicate key ${entry.key}`);
    state.i++;
    if (entry.rest === '') map[entry.key] = nested(state, indent);
    else if (entry.rest === '|' || entry.rest === '|-') map[entry.key] = literal(state, indent, entry.rest === '|');
    else map[entry.key] = scalar(entry.rest, line);
  }
}

/** The block under a key or a "-" with nothing after it, or null when none is indented below. */
function nested(state, indent) {
  skipBlank(state);
  const line = state.lines[state.i];
  if (!line || line.indent <= indent) return null;
  return parseBlock(state, line.indent);
}

/** A literal block (| or |-): the lines indented below the key, that indentation removed. */
function literal(state, indent, keepNewline) {
  const body = [];
  let at = null;
  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (line.raw.trim() === '') {
      body.push('');
    } else {
      if (line.indent <= indent) break;
      at ??= line.indent;
      if (line.indent < at) throw new Error(`Line ${line.n}: literal block indented less than its first line`);
      body.push(line.raw.slice(at));
    }
    state.i++;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return body.join('\n') + (keepNewline && body.length > 0 ? '\n' : '');
}

function scalar(text, line) {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`Line ${line.n}: a flow sequence must end on its line`);
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(/,(?=(?:[^'"]|'[^']*'|"[^"]*")*$)/).map((part) => scalar(part.trim(), line));
  }
  if (/^["']/.test(text)) {
    const value = unquote(text);
    if (value === null) throw new Error(`Line ${line.n}: bad quoted scalar ${text}`);
    return value;
  }
  if (/^[{&*!|>%@`]/.test(text) || /:(\s|$)/.test(text)) {
    throw new Error(`Line ${line.n}: unsupported scalar ${text}`);
  }
  return text;
}

function unquote(text) {
  if (text.startsWith("'")) {
    return /^'(?:[^']|'')*'$/.test(text) ? text.slice(1, -1).replaceAll("''", "'") : null;
  }
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}
