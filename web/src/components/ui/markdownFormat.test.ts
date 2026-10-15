import { describe, expect, it } from 'vitest';
import { applyTextEdit, continueList, insertLink, toggleInline, toggleLinePrefix, type TextEdit } from './markdownFormat';

/** Apply an edit and render the selection as [ ] markers for readable assertions. */
function run(text: string, edit: TextEdit): string {
  const out = applyTextEdit(text, edit);
  if (edit.selectionStart === edit.selectionEnd) return `${out.slice(0, edit.selectionStart)}|${out.slice(edit.selectionStart)}`;
  return `${out.slice(0, edit.selectionStart)}[${out.slice(edit.selectionStart, edit.selectionEnd)}]${out.slice(edit.selectionEnd)}`;
}

describe('toggleInline', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(run('a word b', toggleInline('a word b', 2, 6, 'bold'))).toBe('a **[word]** b');
  });
  it('inserts an empty pair with the caret inside', () => {
    expect(run('ab', toggleInline('ab', 1, 1, 'italic'))).toBe('a_|_b');
  });
  it('unwraps when markers surround the selection', () => {
    const text = 'a **word** b';
    expect(run(text, toggleInline(text, 4, 8, 'bold'))).toBe('a [word] b');
  });
  it('unwraps when the selection includes the markers', () => {
    const text = 'a `x` b';
    expect(run(text, toggleInline(text, 2, 5, 'code'))).toBe('a [x] b');
  });
  it('keeps surrounding whitespace outside the markers', () => {
    expect(run('word ', toggleInline('word ', 0, 5, 'bold'))).toBe('**[word]** ');
  });
});

describe('insertLink', () => {
  it('wraps selected text and puts the caret in the URL slot', () => {
    expect(run('see docs', insertLink('see docs', 4, 8))).toBe('see [docs](|)');
  });
  it('uses a selected URL as the target', () => {
    const t = 'https://example.com';
    expect(run(t, insertLink(t, 0, t.length))).toBe('[|](https://example.com)');
  });
  it('inserts an empty link at the caret', () => {
    expect(run('', insertLink('', 0, 0))).toBe('[|]()');
  });
});

describe('toggleLinePrefix', () => {
  it('adds a bullet to the current line keeping the caret position in the text', () => {
    expect(run('hello', toggleLinePrefix('hello', 3, 3, 'bullet'))).toBe('- hel|lo');
  });
  it('removes the prefix when every selected line has it', () => {
    const text = '- a\n- b';
    expect(applyTextEdit(text, toggleLinePrefix(text, 0, text.length, 'bullet'))).toBe('a\nb');
  });
  it('numbers lines and skips blank ones', () => {
    const text = 'a\n\nb';
    expect(applyTextEdit(text, toggleLinePrefix(text, 0, text.length, 'number'))).toBe('1. a\n\n2. b');
  });
  it('converts a bullet list to a checklist', () => {
    const text = '- a\n- b';
    expect(applyTextEdit(text, toggleLinePrefix(text, 0, text.length, 'task'))).toBe('- [ ] a\n- [ ] b');
  });
  it('does not treat a checklist as a bullet list', () => {
    const text = '- [ ] a';
    expect(applyTextEdit(text, toggleLinePrefix(text, 0, 0, 'bullet'))).toBe('- a');
  });
  it('preserves indentation', () => {
    const text = '  a';
    expect(applyTextEdit(text, toggleLinePrefix(text, 0, 0, 'task'))).toBe('  - [ ] a');
  });
  it('ignores the line after a selection that ends with a newline', () => {
    const text = 'a\nb';
    expect(applyTextEdit(text, toggleLinePrefix(text, 0, 2, 'quote'))).toBe('> a\nb');
  });
});

describe('continueList', () => {
  it('continues bullets, checklists, numbers and quotes', () => {
    expect(run('- a', continueList('- a', 3)!)).toBe('- a\n- |');
    expect(run('- [x] a', continueList('- [x] a', 7)!)).toBe('- [x] a\n- [ ] |');
    expect(run('9) a', continueList('9) a', 4)!)).toBe('9) a\n10) |');
    expect(run('> a', continueList('> a', 3)!)).toBe('> a\n> |');
  });
  it('keeps indentation', () => {
    expect(run('  * a', continueList('  * a', 5)!)).toBe('  * a\n  * |');
  });
  it('splits an item when the caret is mid-line', () => {
    expect(run('- ab', continueList('- ab', 3)!)).toBe('- a\n- |b');
  });
  it('ends the list on an empty item', () => {
    expect(run('- a\n- ', continueList('- a\n- ', 6)!)).toBe('- a\n|');
  });
  it('returns null outside lists or inside the marker', () => {
    expect(continueList('plain', 5)).toBeNull();
    expect(continueList('- a', 1)).toBeNull();
  });
});
