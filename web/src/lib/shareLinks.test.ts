// Links passed on to someone else (design §5.8.8 step 7): absolute, at a chosen origin, warned about on loopback.
import { describe, expect, it } from 'vitest';
import { absoluteLink, linkAt, linkOrigins, loopbackWarning } from './shareLinks';

const TOKEN = 'A'.repeat(43);

describe('share links', () => {
  it('a path gets the page’s origin; an absolute link stays as the server built it', () => {
    expect(absoluteLink(`/invite#t=${TOKEN}`, 'http://192.168.1.4:8080')).toBe(`http://192.168.1.4:8080/invite#t=${TOKEN}`);
    expect(absoluteLink(`https://plan.example.com/reset#t=${TOKEN}`, 'http://localhost:5173')).toBe(`https://plan.example.com/reset#t=${TOKEN}`);
  });

  it('the origins to choose from, and the same link at another one', () => {
    expect(linkOrigins([], 'http://localhost:8080')).toEqual(['http://localhost:8080']);
    expect(linkOrigins(['http://192.168.1.4:43771', 'http://10.0.0.2:43771'], 'http://localhost:43771')).toEqual([
      'http://192.168.1.4:43771',
      'http://10.0.0.2:43771',
    ]);
    expect(linkAt(`http://192.168.1.4:43771/invite#t=${TOKEN}`, 'http://10.0.0.2:43771')).toBe(`http://10.0.0.2:43771/invite#t=${TOKEN}`);
  });

  it('warns when the link works only on this computer', () => {
    for (const host of ['localhost:8080', '127.0.0.1:8080', '127.1.2.3', '[::1]:8080']) {
      expect(loopbackWarning(`http://${host}/invite#t=${TOKEN}`), host).toBe('This link works only on this computer. Set PUBLIC_URL, or start the app with --lan.');
    }
    for (const link of [`http://192.168.1.4:8080/invite#t=${TOKEN}`, `https://plan.example.com/invite#t=${TOKEN}`, 'not a url']) {
      expect(loopbackWarning(link), link).toBeNull();
    }
  });
});
