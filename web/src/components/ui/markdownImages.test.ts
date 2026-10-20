// Which Markdown images MarkdownRenderer loads (design §13.4): data: rasters and same-origin files, never a
// path the API answers, whatever its spelling.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rendersAsImage } from './MarkdownRenderer';

const g = globalThis as { window?: unknown };
let saved: unknown;
beforeAll(() => {
  saved = g.window;
  g.window = { location: new URL('https://plan.example.com/s/0123456789abcdef/tasks/WEB-1') };
});
afterAll(() => {
  g.window = saved;
});

describe('rendersAsImage', () => {
  it('loads data: rasters and same-origin files', () => {
    expect(rendersAsImage('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
    expect(rendersAsImage('/icons/icon-192.png')).toBe(true);
    expect(rendersAsImage('https://plan.example.com/icons/icon-192.png')).toBe(true);
    // Relative to the page: /s/<id>/tasks/api/…, not the API.
    expect(rendersAsImage('api/admin/backup')).toBe(true);
  });

  it('never loads an API path, however it is written', () => {
    for (const url of [
      '/api/admin/backup',
      '/api/admin/backup?1',
      '/api/s/0123456789abcdef/data/export',
      'https://plan.example.com/api/admin/backup',
      '//plan.example.com/api/admin/backup',
      '/API/admin/backup',
      '/icons/../api/admin/backup',
      '../../../api/admin/backup',
      '/api',
    ]) {
      expect(rendersAsImage(url), url).toBe(false);
    }
  });

  it('does not load other origins (CSP would block them anyway)', () => {
    expect(rendersAsImage('https://elsewhere.example/a.png')).toBe(false);
  });
});
