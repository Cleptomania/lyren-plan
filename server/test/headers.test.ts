// The security headers of the static site on both runtimes (design §10.7, §13.12). On Node the gateway puts
// http/headers.ts' headers on every response, the static site's included; on Cloudflare static assets never
// reach the Worker, so web/public/_headers gives them the same ones. The two must not drift.

import fs from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../src/http/headers';

/** The rules of a _headers file: path pattern → header name (lower-cased) → value. */
function parseHeadersFile(text: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const colon = line.indexOf(':');
    if (!current || colon < 0) throw new Error(`Unexpected _headers line: ${line}`);
    current.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return rules;
}

async function nodeHeaders(): Promise<Headers> {
  const app = new Hono();
  app.use('*', securityHeaders());
  app.get('/', (c) => c.text('page'));
  return (await app.request('/')).headers;
}

describe('web/public/_headers (static assets on Cloudflare)', () => {
  const rules = parseHeadersFile(fs.readFileSync(new URL('../../web/public/_headers', import.meta.url), 'utf8'));

  it('has one rule for every path, whose CSP equals the one secureHeaders sets on Node', async () => {
    expect([...rules.keys()]).toEqual(['/*']);
    const all = rules.get('/*')!;
    const node = await nodeHeaders();
    expect(all.get('content-security-policy')).toBe(node.get('Content-Security-Policy'));
  });

  it('and the other headers both set, with the same values; HSTS on Cloudflare only (Node leaves it to its proxy)', async () => {
    const all = rules.get('/*')!;
    const node = await nodeHeaders();
    for (const name of ['x-frame-options', 'x-content-type-options', 'referrer-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy']) {
      expect(all.get(name), name).toBe(node.get(name));
    }
    expect(all.get('strict-transport-security')).toBe('max-age=31536000');
    expect(node.get('Strict-Transport-Security')).toBeNull();
  });

  it('gives /assets/* no long-lived caching (a missing chunk is answered with index.html, §10.6)', () => {
    for (const [, headers] of rules) expect(headers.has('cache-control')).toBe(false);
  });
});
