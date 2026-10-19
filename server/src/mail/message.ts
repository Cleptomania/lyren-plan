// The message format (design §5.10.3): what every transport checks before it sends, and the MIME text
// the SMTP client sends (the HTTP drivers hand over subject, text and html and build no MIME).
//
// - multipart/alternative: text/plain first (with the full link), then simple text/html with inline
//   styles only; both parts UTF-8, base64 in lines of 76 characters, CRLF line endings;
// - headers From ("<MAIL_FROM_NAME>" <MAIL_FROM>), To, Subject (RFC 2047 encoded words when it is not
//   plain ASCII), Date (RFC 5322), Message-ID (<random@MAIL_FROM's domain>), MIME-Version,
//   Auto-Submitted: auto-generated and Reply-To when MAIL_REPLY_TO is set. No user-controlled header.
// - Every header value is refused when it holds CR, LF or any other control character, and when its
//   line (name, colon, space and value, before encoding) is longer than 998 octets. Every address must
//   pass normalizeEmail (an address that normalizes to something else is refused too, so what is sent is
//   exactly what was checked).
//
// mailSafeName (§5.10.3) is the rule for names people chose (display names, space names, passkey names)
// that a message shows. See its comment for what counts as URL- or address-like.

import { toBase64 } from '../core/crypto';
import { normalizeEmail } from '../core/email';
import { MailError } from './errors';

const encoder = new TextEncoder();

/** RFC 5322's limit for a line of a message, CRLF excluded. */
export const MAX_LINE_OCTETS = 998;
/** Base64 bodies are written in lines of this many characters (RFC 2045). */
const BASE64_LINE = 76;
/**
 * UTF-8 bytes per encoded word: 42 bytes are 56 base64 characters, a word of 68 (RFC 2047: at most 75),
 * so even "Subject: " and the first word stay within RFC 5322's recommended 78 characters a line.
 */
const WORD_BYTES = 42;

/** A message refused before anything was sent (an invalid header or address). */
export class InvalidMessageError extends MailError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMessageError';
  }
}

// ---------------------------------------------------------------------------
// Headers and addresses
// ---------------------------------------------------------------------------

/** `value` as a header value of `name`: no control characters (CR and LF above all), and a line of at most 998 octets. */
export function checkHeader(name: string, value: string): string {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new InvalidMessageError(`The ${name} header contains a line break or a control character`);
  if (encoder.encode(`${name}: ${value}`).length > MAX_LINE_OCTETS) {
    throw new InvalidMessageError(`The ${name} header is longer than ${MAX_LINE_OCTETS} octets`);
  }
  return value;
}

/** An address as it is sent: it must pass normalizeEmail unchanged (so no CR, LF, quotes or brackets). */
export function checkAddress(name: string, address: string): string {
  const email = normalizeEmail(address);
  if (!email.ok || email.address !== address) throw new InvalidMessageError(`The ${name} address is not a valid email address`);
  return address;
}

/** Printable ASCII only, and nothing a decoder could take for an encoded word. */
const isPlainAscii = (s: string) => /^[\x20-\x7e]*$/.test(s) && !s.includes('=?');

/**
 * RFC 2047 encoded words (B encoding, UTF-8) for text that is not plain ASCII: words of at most 42
 * bytes of text, never splitting a character, one per line (folded with CRLF and a space).
 */
export function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (chunk !== '' && encoder.encode(chunk + char).length > WORD_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk !== '' || words.length === 0) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${toBase64(encoder.encode(w))}?=`).join('\r\n ');
}

/** A header value as written: plain ASCII as it is, anything else as encoded words. */
function headerText(name: string, value: string): string {
  checkHeader(name, value);
  return isPlainAscii(value) ? value : encodeWords(value);
}

const quoted = (name: string) => `"${name.replace(/[\\"]/g, '\\$&')}"`;

/** `"Name" <address>` for a header: a quoted ASCII name (backslash escapes), or encoded words. */
export function formatMailbox(name: string, address: string): string {
  checkHeader('From', name);
  return `${isPlainAscii(name) ? quoted(name) : encodeWords(name)} <${address}>`;
}

/** `"Name" <address>` for an HTTP API, which encodes the name itself (UTF-8 kept, never folded). */
export function quotedMailbox(name: string, address: string): string {
  checkHeader('From', name);
  return `${quoted(name)} <${address}>`;
}

// ---------------------------------------------------------------------------
// Dates, ids, bodies
// ---------------------------------------------------------------------------

/** RFC 5322 date-time in UTC: `Sun, 18 Oct 2026 12:00:00 +0000`. */
export function formatDate(ms: number): string {
  return new Date(ms).toUTCString().replace(/GMT$/, '+0000');
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every line break as CRLF. */
export function crlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

/** The UTF-8 bytes of `text` (CRLF-normalized) in base64 lines of 76 characters, each ending in CRLF. */
export function base64Body(text: string): string {
  const encoded = toBase64(encoder.encode(crlf(text)));
  let out = '';
  for (let i = 0; i < encoded.length; i += BASE64_LINE) out += `${encoded.slice(i, i + BASE64_LINE)}\r\n`;
  return out;
}

/** SMTP transparency (RFC 5321 §4.5.2): CRLF line endings, a line starting with '.' gets another one. */
export function dotStuff(data: string): string {
  return crlf(data).replace(/^\./gm, '..');
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

export interface Envelope {
  /** MAIL_FROM (normalized) and MAIL_FROM_NAME. */
  from: { address: string; name: string };
  /** MAIL_REPLY_TO, or null. */
  replyTo: string | null;
}

export interface MimeInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MimeMessage {
  /** The Message-ID header's value, angle brackets included. */
  messageId: string;
  /** The whole message, CRLF line endings, ready to be dot-stuffed. */
  data: string;
}

/** Checks a message as every transport must (§5.10.3): the addresses, and the subject as a header. */
export function checkMessage(message: MimeInput, envelope: Envelope): void {
  checkAddress('To', message.to);
  checkAddress('From', envelope.from.address);
  if (envelope.replyTo !== null) checkAddress('Reply-To', envelope.replyTo);
  checkHeader('From', envelope.from.name);
  checkHeader('Subject', message.subject);
}

/** The MIME text of a message (§5.10.3). Throws InvalidMessageError for a header or address it refuses. */
export function buildMimeMessage(message: MimeInput, envelope: Envelope, nowMs: number = Date.now()): MimeMessage {
  checkMessage(message, envelope);
  const domain = envelope.from.address.slice(envelope.from.address.lastIndexOf('@') + 1);
  const messageId = `<${randomHex(16)}@${domain}>`;
  const boundary = `=_lyren_${randomHex(12)}`;
  const headers: Array<[string, string]> = [
    ['From', formatMailbox(envelope.from.name, envelope.from.address)],
    ['To', message.to],
    ['Subject', headerText('Subject', message.subject)],
    ['Date', formatDate(nowMs)],
    ['Message-ID', messageId],
    ['MIME-Version', '1.0'],
    ['Auto-Submitted', 'auto-generated'],
  ];
  if (envelope.replyTo !== null) headers.push(['Reply-To', envelope.replyTo]);
  headers.push(['Content-Type', `multipart/alternative; boundary="${boundary}"`]);
  const part = (type: string, body: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Body(body)}`;
  const data =
    headers.map(([name, value]) => `${name}: ${value}\r\n`).join('') +
    '\r\n' +
    part('text/plain', message.text) +
    part('text/html', message.html) +
    `--${boundary}--\r\n`;
  return { messageId, data };
}

// ---------------------------------------------------------------------------
// Names people chose
// ---------------------------------------------------------------------------

/** Longest name a message shows (§5.10.3), in characters (code points). */
export const MAIL_NAME_MAX = 60;

/** A name for a message: `text` for the text part, `html` (escaped) for the HTML part. */
export interface SafeName {
  text: string;
  html: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Invisible characters: controls, format characters (zero-width, bidi controls), default-ignorables (Hangul fillers, variation selectors). */
const INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}]/gu;
/**
 * Punctuation that reads as no dot between two letters or digits: ASCII's ! " # % & ' * , / : ; ? \
 * ("R&D", "O'Brien", "Design/Build", "1,000"; `@` and `://` are tested apart), the inverted marks, § and
 * ¶, and the Hebrew geresh and gershayim (U+05F3, U+05F4), which are part of names.
 */
const NOT_DOTS = String.raw`!"#%&'*,/:;?\\¡§¶¿׳״`;
/**
 * Characters that read as a dot (after NFKC, which already maps U+FF0E, U+FE52, U+2024 and U+0387): every
 * other punctuation mark (\p{Po}: the full stops of every script, middle dots, bullets, the Tibetan tsheg,
 * …); the letters Canadian syllabics final middle dot and Latin letter sinological dot (U+1427, U+A78F,
 * both allowed in domain names); and the symbols that are a dot or a spot: U+02D9, the dot operators
 * U+2218, U+2219 and U+22C5, the Z notation spot U+2981 and the circles U+25CF, U+25E6, U+26AB and U+2B24.
 */
const DOT = `(?:(?![${NOT_DOTS}])\\p{Po}|[\\u1427\\uA78F\\u02D9\\u2218\\u2219\\u22C5\\u25CF\\u25E6\\u26AB\\u2981\\u2B24])`;
/** NFKC maps the fullwidth and small at signs (U+FF20, U+FE6B) to '@'. */
const AT = /@/;
/**
 * Something that reads as `://`: colons (also U+A789, U+2236, U+02D0, U+02D1, U+02F8, U+0589, U+05C3,
 * U+1365, U+16EC, U+205A, U+2982) and slashes (also U+2044, U+2215, U+29F8, U+2571, U+27CB).
 */
const SCHEME = /[:꞉∶ːˑ˸։׃፥᛬⁚⦂]\s*[/⁄∕⧸╱⟋]{2}/u;
/** A dot between two letters or digits ("paypal.example", "1.2.3.4"). */
const DOTTED = new RegExp(`[\\p{L}\\p{N}]${DOT}[\\p{L}\\p{N}]`, 'u');
const WWW = new RegExp(`www${DOT}`, 'iu');

/** Whether a name could be read, or linked by a mail client, as an address or a URL (§5.10.3). */
export function looksLikeLinkOrAddress(value: string): boolean {
  const folded = value.replace(INVISIBLE, '').normalize('NFKC').replace(INVISIBLE, '');
  // Without combining marks (NFKD takes them off precomposed letters too): a mark next to a dot, on
  // either side, hides nothing ("paypal.́example", "wwẃ.evil").
  const bare = folded.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC');
  return AT.test(bare) || SCHEME.test(bare) || WWW.test(bare) || DOTTED.test(bare);
}

/**
 * A name someone chose, as a message may show it (§5.10.3): invisible characters removed, white space
 * collapsed, cut to 60 characters, and HTML-escaped for the HTML part; `fallback` ("a member of
 * <INSTANCE_NAME>", "a space") instead when it is empty or looks like a link or an address.
 *
 * What counts (checked on the whole value, after removing invisible characters and applying NFKC, so
 * fullwidth and other compatibility forms read as their ASCII twins): any at sign; `://` (look-alike
 * colons and slashes included, spaces allowed between them); `www` before a dot; and a dot between two
 * letters or digits (any script), where a dot is any of the dot-like characters of DOT above, so
 * "paypal。example" and "paypal​.example" count as much as "paypal.example". Dots next to a space
 * ("Dr. Smith", "St. John") do not count; "J.R. Smith" and "v1.2" do, and show the fallback.
 */
export function mailSafeName(value: string | null | undefined, fallback: string): SafeName {
  // Line breaks and other white space become one space each before the invisible characters go.
  const cleaned = (value ?? '').replace(/\s+/gu, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim().normalize('NFC');
  const text = cleaned === '' || looksLikeLinkOrAddress(cleaned) ? fallback : Array.from(cleaned).slice(0, MAIL_NAME_MAX).join('').trim();
  return { text, html: escapeHtml(text) };
}
