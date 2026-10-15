// Pure Markdown editing operations for MarkdownEditor (unit-tested). Each returns a
// TextEdit: replace text[from, to) with `insert`, then select [selectionStart, selectionEnd)
// in the resulting text.

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  selectionStart: number;
  selectionEnd: number;
}

export function applyTextEdit(text: string, edit: TextEdit): string {
  return text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
}

export type InlineFormat = 'bold' | 'italic' | 'code' | 'strike';

const INLINE_MARKERS: Record<InlineFormat, string> = { bold: '**', italic: '_', code: '`', strike: '~~' };

/** Wrap the selection in a marker, or unwrap it when it is already wrapped. */
export function toggleInline(text: string, start: number, end: number, format: InlineFormat): TextEdit {
  const m = INLINE_MARKERS[format];
  const n = m.length;
  // Markers just outside the selection: **|word|**
  if (start >= n && text.slice(start - n, start) === m && text.slice(end, end + n) === m) {
    return { from: start - n, to: end + n, insert: text.slice(start, end), selectionStart: start - n, selectionEnd: end - n };
  }
  const selected = text.slice(start, end);
  // Markers inside the selection: |**word**|
  if (selected.length >= 2 * n && selected.startsWith(m) && selected.endsWith(m)) {
    const inner = selected.slice(n, selected.length - n);
    return { from: start, to: end, insert: inner, selectionStart: start, selectionEnd: start + inner.length };
  }
  // Keep surrounding whitespace outside the markers ("word " → "**word** ").
  const lead = /^\s*/.exec(selected)![0];
  const trail = selected.length > lead.length ? /\s*$/.exec(selected)![0] : '';
  const core = selected.slice(lead.length, selected.length - trail.length);
  const insert = `${lead}${m}${core}${m}${trail}`;
  const coreStart = start + lead.length + n;
  return { from: start, to: end, insert, selectionStart: coreStart, selectionEnd: coreStart + core.length };
}

/** Insert a link: "[sel]()" with the caret in the parentheses, or "[](url)" when a URL is selected. */
export function insertLink(text: string, start: number, end: number): TextEdit {
  const selected = text.slice(start, end);
  if (/^(https?:\/\/|mailto:)\S+$/i.test(selected.trim())) {
    const insert = `[](${selected.trim()})`;
    return { from: start, to: end, insert, selectionStart: start + 1, selectionEnd: start + 1 };
  }
  const insert = `[${selected}]()`;
  const caret = start + selected.length + 3;
  if (!selected) return { from: start, to: end, insert, selectionStart: start + 1, selectionEnd: start + 1 };
  return { from: start, to: end, insert, selectionStart: caret, selectionEnd: caret };
}

export type LineFormat = 'bullet' | 'number' | 'task' | 'quote';

const LINE_PATTERNS: Record<LineFormat, RegExp> = {
  task: /^(\s*)[-*+] \[[ xX]\] /,
  bullet: /^(\s*)[-*+] (?!\[[ xX]\] )/,
  number: /^(\s*)\d+[.)] /,
  quote: /^(\s*)> ?/,
};
const ANY_LIST_PREFIX = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)/;

function lineBounds(text: string, start: number, end: number): [number, number] {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  // A selection ending right after a newline does not include the next line.
  const effectiveEnd = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', effectiveEnd);
  return [lineStart, nl === -1 ? text.length : nl];
}

/** Toggle a line prefix (list / checklist / numbered / quote) on every selected line. */
export function toggleLinePrefix(text: string, start: number, end: number, format: LineFormat): TextEdit {
  const [lineStart, lineEnd] = lineBounds(text, start, end);
  const lines = text.slice(lineStart, lineEnd).split('\n');
  const pattern = LINE_PATTERNS[format];
  const content = lines.filter((l) => l.trim() !== '');
  const remove = content.length > 0 && content.every((l) => pattern.test(l));

  let counter = 0;
  const out = lines.map((line) => {
    if (remove) return line.replace(pattern, '$1');
    if (line.trim() === '' && lines.length > 1) return line;
    const indent = /^\s*/.exec(line)![0];
    const body = line.replace(ANY_LIST_PREFIX, '').trimStart();
    counter++;
    const prefix = format === 'bullet' ? '- ' : format === 'task' ? '- [ ] ' : format === 'number' ? `${counter}. ` : '> ';
    return `${indent}${prefix}${body}`;
  });
  const insert = out.join('\n');

  if (lines.length === 1 && start === end) {
    // Keep the caret on the same character of the line content.
    const delta = insert.length - (lineEnd - lineStart);
    const caret = Math.max(lineStart, Math.min(lineStart + insert.length, start + delta));
    return { from: lineStart, to: lineEnd, insert, selectionStart: caret, selectionEnd: caret };
  }
  return { from: lineStart, to: lineEnd, insert, selectionStart: lineStart, selectionEnd: lineStart + insert.length };
}

const CONTINUABLE = /^(\s*)(?:([-*+]) \[[ xX]\] |([-*+]) |(\d+)([.)]) |(>) ?)/;

/**
 * Enter inside a list item: continue the list on the next line ("- ", "- [ ] ", "2. ", "> ").
 * Enter on an empty item ends the list (removes the marker). Returns null when the caret is
 * not in a list item (let the textarea insert a plain newline).
 */
export function continueList(text: string, start: number, end: number = start): TextEdit | null {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', start);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);
  const m = CONTINUABLE.exec(line);
  if (!m) return null;
  const markerEnd = lineStart + m[0].length;
  if (start < markerEnd) return null;
  const indent = m[1] ?? '';

  if (line.slice(m[0].length).trim() === '' && end === start) {
    // Empty item: end the list.
    return { from: lineStart, to: lineEnd, insert: '', selectionStart: lineStart, selectionEnd: lineStart };
  }
  let marker: string;
  if (m[2]) marker = `${m[2]} [ ] `;
  else if (m[3]) marker = `${m[3]} `;
  else if (m[4]) marker = `${Number(m[4]) + 1}${m[5]} `;
  else marker = '> ';
  const insert = `\n${indent}${marker}`;
  const caret = start + insert.length;
  return { from: start, to: end, insert, selectionStart: caret, selectionEnd: caret };
}
