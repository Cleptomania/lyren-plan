// The coarse rate-limit key (core/net.ts netKey); limiterKey's own tests are in ratelimit.test.ts. The
// address checks core/net.ts carries (so node:net stays out of the Worker) decide as node:net does.

import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { isIPv4, isIPv6, limiterKey, netKey } from '../src/core/net';

describe('isIPv4 and isIPv6', () => {
  it('decide as node:net does, on known cases and on random strings of address characters', () => {
    const known = [
      '0.0.0.0', '192.0.2.1', '255.255.255.255', '256.0.0.1', '01.2.3.4', '1.2.3', '1.2.3.4.5', ' 1.2.3.4', '1.2.3.4 ',
      '::', '::1', '1::', '2001:db8::1', '2001:DB8:0:0:8:800:200C:417A', '::ffff:192.0.2.1', '::ffff:192.0.2.256', '1:2:3:4:5:6:7:8',
      '1:2:3:4:5:6:7:8:9', '1::2::3', 'fe80::1%eth0', 'fe80::1%', '[::1]', ':::', '12345::', 'g::1', '1:2:3:4:5:6:1.2.3.4', '',
    ];
    let seed = 20261018;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alphabet = '0123456789abcdefABCDEF:.%e';
    const samples = [...known];
    for (let i = 0; i < 20_000; i++) {
      const length = 1 + Math.floor(random() * 40);
      let text = '';
      for (let j = 0; j < length; j++) text += alphabet[Math.floor(random() * alphabet.length)];
      samples.push(text);
    }
    // Also well-formed addresses, so that both answers are exercised.
    for (let i = 0; i < 2_000; i++) {
      const groups = Array.from({ length: 8 }, () => Math.floor(random() * 65536).toString(16));
      const cut = Math.floor(random() * 8);
      samples.push(groups.join(':'), `${groups.slice(0, cut).join(':')}::${groups.slice(cut + 1).join(':')}`);
      samples.push(Array.from({ length: 4 }, () => Math.floor(random() * 300)).join('.'));
    }
    for (const sample of samples) {
      expect([sample, isIPv4(sample)]).toEqual([sample, net.isIPv4(sample)]);
      expect([sample, isIPv6(sample)]).toEqual([sample, net.isIPv6(sample)]);
    }
  });
});

describe('netKey', () => {
  it('groups IPv4 by /24, IPv4-mapped IPv6 included', () => {
    expect(netKey('192.0.2.77')).toBe('192.0.2.0/24');
    expect(netKey(' 192.0.2.1 ')).toBe('192.0.2.0/24');
    expect(netKey('::ffff:192.0.2.200')).toBe('192.0.2.0/24');
    expect(netKey('198.51.100.1')).not.toBe(netKey('192.0.2.1'));
  });

  it('groups IPv6 by /48', () => {
    expect(netKey('2001:db8:1:2::1')).toBe('2001:db8:1::/48');
    expect(netKey('2001:db8:1:ffff:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1::/48');
    expect(netKey('[2001:DB8:ABCD:12::9]')).toBe('2001:db8:abcd::/48');
    expect(netKey('fe80::1%eth0')).toBe('fe80:0:0::/48');
    expect(netKey('::1')).toBe('0:0:0::/48');
    expect(netKey('2001:db8:2::1')).not.toBe(netKey('2001:db8:1::1'));
  });

  it('uses anything else as-is, like limiterKey', () => {
    expect(netKey('unknown')).toBe('unknown');
    expect(netKey('')).toBe('');
    expect(netKey('not:an:address')).toBe('not:an:address');
  });
});
