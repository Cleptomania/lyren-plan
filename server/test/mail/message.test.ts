// The message format (mail/message.ts, design §5.10.3, §13.8): the multipart layout, the headers and
// their encoding, the refusals (CR/LF and other control characters, the 998-octet line, addresses that do
// not normalize), base64 lines, dot-stuffing, and mailSafeName with look-alike characters.

import { describe, expect, it } from 'vitest';
import {
  base64Body,
  buildMimeMessage,
  checkHeader,
  dotStuff,
  encodeWords,
  formatDate,
  formatMailbox,
  InvalidMessageError,
  looksLikeLinkOrAddress,
  mailSafeName,
  MAX_LINE_OCTETS,
  quotedMailbox,
  type Envelope,
} from '../../src/mail/message';

const envelope: Envelope = { from: { address: 'no-reply@plan.example.com', name: 'Lyren Plan' }, replyTo: null };
const message = {
  to: 'alice@example.com',
  subject: 'Reset your password for Lyren Plan',
  text: 'Hello\nOpen https://plan.example.com/reset#t=abc\n.a line starting with a dot',
  html: '<p>Hello <a href="https://plan.example.com/reset#t=abc">reset</a></p>',
};

/** The headers (unfolded) and the decoded parts of a built message. */
function parse(data: string) {
  const [head = '', ...rest] = data.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n /g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    headers.set(line.slice(0, colon), line.slice(colon + 2));
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get('Content-Type') ?? '')?.[1] ?? '';
  const parts = body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [partHead = '', partBody = ''] = part.replace(/^\r\n/, '').split('\r\n\r\n');
      return { head: partHead, raw: partBody, decoded: Buffer.from(partBody.replace(/\r\n/g, ''), 'base64').toString('utf8') };
    });
  return { headers, parts, boundary, body };
}

/** RFC 2047 B-encoded words of a header value, decoded. */
const decodeWords = (value: string) =>
  value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=\s*/g, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));

describe('buildMimeMessage', () => {
  it('writes multipart/alternative: text/plain first, then text/html, both UTF-8 base64 with CRLF line endings', () => {
    const { data, messageId } = buildMimeMessage(message, envelope, Date.parse('2026-10-18T12:34:56Z'));
    const { headers, parts, body } = parse(data);
    expect(headers.get('From')).toBe('"Lyren Plan" <no-reply@plan.example.com>');
    expect(headers.get('To')).toBe('alice@example.com');
    expect(headers.get('Subject')).toBe(message.subject);
    expect(headers.get('Date')).toBe('Sun, 18 Oct 2026 12:34:56 +0000');
    expect(headers.get('Message-ID')).toBe(messageId);
    expect(messageId).toMatch(/^<[0-9a-f]{32}@plan\.example\.com>$/);
    expect(headers.get('MIME-Version')).toBe('1.0');
    expect(headers.get('Auto-Submitted')).toBe('auto-generated');
    expect(headers.has('Reply-To')).toBe(false);
    expect(headers.get('Content-Type')).toMatch(/^multipart\/alternative; boundary="=_lyren_[0-9a-f]{24}"$/);
    // No other header: nothing user-controlled, no List-Unsubscribe, no tracking.
    expect([...headers.keys()]).toEqual(['From', 'To', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Auto-Submitted', 'Content-Type']);
    expect(parts.map((p) => p.head)).toEqual([
      'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64',
      'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64',
    ]);
    expect(parts[0]!.decoded).toBe(message.text.replace(/\n/g, '\r\n'));
    expect(parts[1]!.decoded).toBe(message.html);
    expect(body.endsWith(`--${parse(data).boundary}--\r\n`)).toBe(true);
    // Every line ends in CRLF, and no bare CR or LF is left anywhere.
    expect(data.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('adds Reply-To when configured, and Message-ID ids are random', () => {
    const a = buildMimeMessage(message, { ...envelope, replyTo: 'help@example.com' });
    const b = buildMimeMessage(message, envelope);
    expect(parse(a.data).headers.get('Reply-To')).toBe('help@example.com');
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('encodes a non-ASCII subject and sender name as RFC 2047 words, folded, never splitting a character', () => {
    const subject = 'Bestätige deine E-Mail-Adresse für Lyren Plan — ein ziemlich langer Betreff mit Ümläuten und 😀';
    const { data } = buildMimeMessage({ ...message, subject }, { ...envelope, from: { ...envelope.from, name: 'Planung für Ärzte' } });
    const head = data.split('\r\n\r\n')[0]!;
    const subjectLines = /^Subject: [^]*?(?=\r\nDate:)/m.exec(head)![0].split('\r\n');
    expect(subjectLines.length).toBeGreaterThan(1);
    for (const line of subjectLines) {
      expect(line.length).toBeLessThanOrEqual(78);
      expect(line).toMatch(/^(Subject: | )=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    const { headers } = parse(data);
    expect(decodeWords(headers.get('Subject')!)).toBe(subject);
    expect(headers.get('From')).toMatch(/^=\?UTF-8\?B\?.+\?= <no-reply@plan\.example\.com>$/);
    expect(decodeWords(headers.get('From')!.replace(/ <.*$/, ''))).toBe('Planung für Ärzte');
    // Each word decodes on its own (no character is split across two words).
    for (const word of encodeWords(subject).split('\r\n ')) {
      expect(Buffer.from(/\?B\?(.*)\?=/.exec(word)![1]!, 'base64').toString('utf8')).not.toContain('�');
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('quotes an ASCII sender name and escapes its quotes and backslashes; an HTTP API gets a quoted UTF-8 name', () => {
    expect(formatMailbox('Ops "Team" \\ Plan', 'no-reply@example.com')).toBe('"Ops \\"Team\\" \\\\ Plan" <no-reply@example.com>');
    expect(formatMailbox('=?UTF-8?B?eA==?=', 'no-reply@example.com')).toMatch(/^=\?UTF-8\?B\?/);
    expect(quotedMailbox('Planung für Ärzte', 'no-reply@example.com')).toBe('"Planung für Ärzte" <no-reply@example.com>');
  });

  it.each([
    ['CRLF', 'Hello\r\nBcc: victim@example.com'],
    ['LF', 'Hello\nX-Injected: yes'],
    ['CR', 'Hello\rX-Injected: yes'],
    ['NUL', 'Hello\0'],
    ['another control character', 'Hello\x1b[2J'],
  ])('refuses a subject with %s (header injection)', (_label, subject) => {
    expect(() => buildMimeMessage({ ...message, subject }, envelope)).toThrow(InvalidMessageError);
    expect(() => buildMimeMessage({ ...message, subject }, envelope)).toThrow(/Subject header contains a line break or a control character/);
  });

  it('refuses a sender name with a line break', () => {
    expect(() => buildMimeMessage(message, { ...envelope, from: { ...envelope.from, name: 'Plan\r\nBcc: x@example.com' } })).toThrow(/From header/);
  });

  it('caps a header line at 998 octets (UTF-8, before encoding)', () => {
    const fits = 'x'.repeat(MAX_LINE_OCTETS - 'Subject: '.length);
    expect(() => buildMimeMessage({ ...message, subject: fits }, envelope)).not.toThrow();
    expect(() => buildMimeMessage({ ...message, subject: `${fits}x` }, envelope)).toThrow(/longer than 998 octets/);
    // Octets, not characters: 'ä' is two.
    const umlauts = 'ä'.repeat(Math.floor((MAX_LINE_OCTETS - 'Subject: '.length) / 2) + 1);
    expect(() => checkHeader('Subject', umlauts)).toThrow(/longer than 998 octets/);
  });

  it.each([
    ['a recipient with CRLF', { ...message, to: 'alice@example.com\r\nRCPT TO:<evil@example.com>' }, envelope],
    ['a recipient in angle brackets', { ...message, to: '<alice@example.com>' }, envelope],
    ['a recipient with a display name', { ...message, to: 'Alice <alice@example.com>' }, envelope],
    ['a recipient that normalizes to something else', { ...message, to: 'alice@EXAMPLE.com' }, envelope],
    ['a quoted local part', { ...message, to: '"a b"@example.com' }, envelope],
    ['a sender that is no address', message, { ...envelope, from: { ...envelope.from, address: 'no-reply' } }],
    ['a Reply-To that is no address', message, { ...envelope, replyTo: 'help@example.com>, x@example.com' }],
  ])('refuses %s', (_label, m, e) => {
    expect(() => buildMimeMessage(m, e)).toThrow(InvalidMessageError);
  });
});

describe('bodies and SMTP data', () => {
  it('writes base64 in lines of at most 76 characters, each ending in CRLF', () => {
    const text = 'Ünïcödé '.repeat(200);
    const out = base64Body(text);
    const lines = out.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines.slice(0, -1)) expect(line).toHaveLength(76);
    expect(lines.at(-1)!.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(lines.join(''), 'base64').toString('utf8')).toBe(text);
  });

  it('normalizes CR, LF and CRLF to CRLF before encoding', () => {
    expect(Buffer.from(base64Body('a\nb\rc\r\nd').replace(/\r\n/g, ''), 'base64').toString()).toBe('a\r\nb\r\nc\r\nd');
  });

  it('dot-stuffs every line that starts with a dot', () => {
    expect(dotStuff('.first\r\nsecond\n.third\r\n..fourth\r\n.')).toBe('..first\r\nsecond\r\n..third\r\n...fourth\r\n..');
    expect(dotStuff('no dots\r\n')).toBe('no dots\r\n');
  });

  it('formats dates as RFC 5322 in UTC', () => {
    expect(formatDate(Date.parse('2026-01-02T03:04:05Z'))).toBe('Fri, 02 Jan 2026 03:04:05 +0000');
  });
});

describe('mailSafeName (§5.10.3)', () => {
  const fallback = 'a member of Lyren Plan';

  it('keeps an ordinary name, HTML-escaped for the HTML part and as it is for the text part', () => {
    expect(mailSafeName('Alice <b>&</b> "Bob"', fallback)).toEqual({ text: 'Alice <b>&</b> "Bob"', html: 'Alice &#60;b&#62;&#38;&#60;/b&#62; &#34;Bob&#34;' });
    expect(mailSafeName("O'Brien", fallback).html).toBe('O&#39;Brien');
    expect(mailSafeName('Zoë Ñúñez 李小龍', fallback).text).toBe('Zoë Ñúñez 李小龍');
    // Dots next to a space are no domain.
    for (const name of ['Dr. Smith', 'St. John', 'Smith Jr.', 'Team A. B.', 'A Space.']) expect(mailSafeName(name, fallback).text).toBe(name);
    // Punctuation that reads as no dot, between letters or digits; combining marks are kept in what is shown.
    for (const name of ['R&D', "O'Brien", 'Design/Build', '1,000 goals', 'Q4: plan', 'Who?Me', 'ג׳ורג׳', 'Nguyễn Thị Ánh', 'Rock-n-Roll']) {
      expect(mailSafeName(name, fallback).text).toBe(name);
    }
  });

  it('cuts to 60 characters (code points, never half a surrogate pair)', () => {
    expect(mailSafeName('x'.repeat(80), fallback).text).toBe('x'.repeat(60));
    const emoji = mailSafeName('😀'.repeat(70), fallback).text;
    expect(Array.from(emoji)).toHaveLength(60);
    expect(emoji).not.toMatch(/[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
  });

  it('removes invisible characters and collapses white space; an empty result is the fallback', () => {
    expect(mailSafeName('  Al​ice \n\t  Smith‮ ', fallback).text).toBe('Alice Smith');
    expect(mailSafeName('ㅤᅟ‍', fallback).text).toBe(fallback);
    expect(mailSafeName('', fallback).text).toBe(fallback);
    expect(mailSafeName(null, fallback).text).toBe(fallback);
  });

  it.each([
    ['a domain', 'paypal.example'],
    ['a domain in a sentence', 'Your account: verify at paypal.example now'],
    ['a URL', 'https://evil.example/login'],
    ['a scheme without a dot', 'http://localhost'],
    ['www.', 'www.'],
    ['WWW in capitals', 'Go to WWW.evil'],
    ['an address', 'alice@example'],
    ['an at sign alone', 'me @ home'],
    ['an IPv4 address', 'Visit 192.0.2.10'],
    ['digits around a dot', 'v1.2'],
    ['initials', 'J.R. Smith'],
    ['a fullwidth dot (U+FF0E)', 'paypal．example'],
    ['an ideographic full stop (U+3002)', 'paypal。example'],
    ['a halfwidth ideographic full stop (U+FF61)', 'paypal｡example'],
    ['a one dot leader (U+2024)', 'paypal․example'],
    ['a small full stop (U+FE52)', 'paypal﹒example'],
    ['a middle dot (U+00B7)', 'paypal·example'],
    ['a Greek ano teleia (U+0387)', 'paypal·example'],
    ['a hyphenation point (U+2027)', 'paypal‧example'],
    ['a katakana middle dot (U+30FB)', 'paypal・example'],
    ['a Canadian syllabics final middle dot (U+1427)', 'paypalᐧexample'],
    ['a Latin letter sinological dot (U+A78F)', 'paypalꞏexample'],
    ['an Arabic full stop (U+06D4)', 'paypal۔example'],
    ['a fullwidth at sign (U+FF20)', 'alice＠example'],
    ['a small commercial at (U+FE6B)', 'alice﹫example'],
    ['fullwidth letters and dot', 'ｐａｙｐａｌ．ｃｏｍ'],
    ['a zero-width space before the dot', 'paypal​.example'],
    ['a zero-width joiner after the dot', 'paypal.‍example'],
    ['a soft hyphen around the dot', 'paypal­.­example'],
    ['a word joiner (U+2060)', 'paypal⁠.example'],
    ['a BOM inside a scheme', 'https:﻿//x'],
    ['a right-to-left override hiding a reversed domain', '‮elpmaxe.lapyap'],
    ['fullwidth colon and slashes', 'https：／／evil'],
    ['a modifier letter colon and fraction slashes', 'https꞉⁄⁄evil'],
    ['a combining mark before the dot', 'paypaĺ.example'],
    ['a combining acute after the dot', 'paypal.\u0301example'],
    ['a combining dot below after the dot', 'paypal.\u0323example'],
    ['combining three dots above after the dot', 'paypal.\u20DBexample'],
    ['a combining mark on a w of www', 'ww\u0301w.evil'],
    ['a Mongolian full stop (U+1803)', 'paypal\u1803example'],
    ['a runic single punctuation (U+16EB)', 'paypal\u16EBexample'],
    ['a Tibetan tsheg (U+0F0B)', 'paypal\u0F0Bexample'],
    ['a ring point (U+2E30)', 'paypal\u2E30example'],
    ['a Vai full stop (U+A60E)', 'paypal\uA60Eexample'],
    ['a bullet (U+2022)', 'paypal\u2022example'],
    ['a Z notation spot (U+2981)', 'paypal\u2981example'],
    ['a black circle (U+25CF)', 'paypal\u25CFexample'],
    ['a ring operator (U+2218)', 'paypal\u2218example'],
    ['a modifier letter triangular colon (U+02D0)', 'https\u02D0//evil'],
    ['a modifier letter raised colon (U+02F8)', 'https\u02F8//evil'],
    ['an Armenian full stop as the colon (U+0589)', 'https\u0589//evil'],
    ['box drawing slashes (U+2571)', 'https:\u2571\u2571evil'],
    ['an NFKC square that spells a.m.', 'Meet ㏂ now'],
    ['an address cut past 60 characters', `${'x'.repeat(58)} alice@example.com`],
  ])('falls back for %s', (_label, value) => {
    expect(looksLikeLinkOrAddress(value.replace(/\s+/gu, ' '))).toBe(true);
    expect(mailSafeName(value, fallback)).toEqual({ text: fallback, html: fallback });
  });

  it('escapes the fallback for the HTML part too', () => {
    expect(mailSafeName('evil.example', 'a member of <Ops & Co>').html).toBe('a member of &#60;Ops &#38; Co&#62;');
  });
});
