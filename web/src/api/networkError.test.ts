import { describe, expect, it } from 'vitest';
import { isLoopbackHost, unreachableText } from './networkError';

describe('unreachable server text', () => {
  it('on this computer (the desktop app): start Lyren Plan, not "check your connection"', () => {
    for (const host of ['127.0.0.1', '127.0.1.1', 'localhost', 'LOCALHOST', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true);
      const t = unreachableText(host);
      expect(t.title).toBe('Can’t reach Lyren Plan');
      expect(t.body).toContain('start it again (it must keep running while you use it)');
      expect(t.message).not.toMatch(/connection/);
    }
  });

  it('elsewhere: the connection', () => {
    for (const host of ['plan.example.org', '192.168.1.20', '127.0.0.1.example.org', '', '[::2]']) {
      expect(isLoopbackHost(host), host).toBe(false);
      expect(unreachableText(host)).toEqual({
        title: 'Can’t reach the server',
        body: 'Check your connection and try again.',
        message: 'Can’t reach the server. Check your connection and try again.',
      });
    }
  });
});
