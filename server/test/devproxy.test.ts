// The Vite dev server's /api proxy target (web/devProxy.ts, used by web/vite.config.ts) follows
// the API server's PORT/HOST so `PORT=9000 npm run dev` keeps both processes in step.

import { describe, expect, it } from 'vitest';
import { apiProxyTarget, DEFAULT_API_PORT } from '../../web/devProxy';
import { loadConfig } from '../src/config';

describe('apiProxyTarget', () => {
  it('defaults to the API default port on loopback', () => {
    expect(apiProxyTarget({})).toBe('http://127.0.0.1:8080');
    expect(apiProxyTarget({ PORT: '', HOST: '' })).toBe('http://127.0.0.1:8080');
  });

  it('agrees with the server on the default port', () => {
    const saved = process.env.PORT;
    delete process.env.PORT;
    try {
      expect(loadConfig().port).toBe(DEFAULT_API_PORT);
    } finally {
      if (saved !== undefined) process.env.PORT = saved;
    }
  });

  it('follows PORT, and HOST unless it is a wildcard address', () => {
    expect(apiProxyTarget({ PORT: '9000' })).toBe('http://127.0.0.1:9000');
    expect(apiProxyTarget({ PORT: ' 9001 ', HOST: '0.0.0.0' })).toBe('http://127.0.0.1:9001');
    expect(apiProxyTarget({ PORT: '9002', HOST: '::' })).toBe('http://127.0.0.1:9002');
    expect(apiProxyTarget({ PORT: '9003', HOST: '192.168.1.20' })).toBe('http://192.168.1.20:9003');
    expect(apiProxyTarget({ HOST: '::1' })).toBe('http://[::1]:8080');
    expect(apiProxyTarget({ HOST: 'localhost' })).toBe('http://localhost:8080');
  });

  it('LYREN_API_URL wins, normalised to an origin', () => {
    expect(apiProxyTarget({ LYREN_API_URL: 'http://10.0.0.5:8080/', PORT: '9000' })).toBe('http://10.0.0.5:8080');
    expect(apiProxyTarget({ LYREN_API_URL: 'https://plan.example.test' })).toBe('https://plan.example.test');
    expect(apiProxyTarget({ LYREN_API_URL: '  ', PORT: '9000' })).toBe('http://127.0.0.1:9000');
  });

  it('rejects values that would make every /api request fail', () => {
    for (const PORT of ['abc', '0', '70000', '80.5', '-1']) {
      expect(() => apiProxyTarget({ PORT }), PORT).toThrow(/PORT must be a port number/);
    }
    for (const LYREN_API_URL of ['localhost:8080', 'ftp://host', 'not a url']) {
      expect(() => apiProxyTarget({ LYREN_API_URL }), LYREN_API_URL).toThrow(/LYREN_API_URL must be an http/);
    }
    expect(() => apiProxyTarget({ LYREN_API_URL: 'http://host:8080/api' })).toThrow(/without a path/);
  });
});
