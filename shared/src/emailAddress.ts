// Email addresses (design §5.2): one normalization for the server (accounts, invitations, mail, the
// configuration's MAIL_FROM and MAIL_REPLY_TO) and the web client (forms). It gives the same result on Node,
// workerd and browsers, because the domain goes through WHATWG URL host parsing (UTS #46 / IDNA) on all three.
//
// - address: what is stored (users.email) and mailed to: the local part as entered, the domain in
//   lower-case ASCII ('bob@bücher.example' -> 'bob@xn--bcher-kva.example').
// - key: what is compared (users.email_key, UNIQUE): the address with a lower-cased local part.
//   +tags and Gmail dots are never removed.
// Only ASCII dot-atom local parts are accepted (no quoted or SMTPUTF8 ones), and only domains with an
// alphabetic or xn-- TLD (no IP literals, no localhost). A valid address is not a deliverable one:
// only an emailed link proves that.
//
// It imports no package, zod included (emailSchema, the API inputs' form of it, is in email.ts, which
// re-exports this): server/src/core/config.ts reads its addresses with it, and a deploy runs that parser
// bundled from the app's own code alone, next to the Cloudflare token (scripts/lib/app-config.mjs).

import { LIMITS } from './constants';

const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
/** At least two labels of 1-63 characters, and an alphabetic or punycode TLD. */
const ASCII_DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(xn--[a-z0-9-]{1,59}|[a-z]{2,63})$/;
/** The URL parser would percent-decode or split at these, so they are refused before it runs. */
const DOMAIN_SPECIALS = /[%\/\\?#:@\s]/;

export type NormalizedEmail = { ok: true; address: string; key: string } | { ok: false; reason: string };

export function normalizeEmail(input: string): NormalizedEmail {
  if (typeof input !== 'string') return { ok: false, reason: 'type' };
  const s = input.trim().normalize('NFC');
  if (/[\x00-\x1f\x7f\s]/.test(s)) return { ok: false, reason: 'whitespace/control' };
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return { ok: false, reason: 'no @' };
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL_ATOM.test(local)) return { ok: false, reason: 'local part' };
  if (domain.startsWith('[')) return { ok: false, reason: 'ip literal' };
  if (DOMAIN_SPECIALS.test(domain)) return { ok: false, reason: 'domain chars' };
  let ascii: string;
  try {
    ascii = new URL(`http://${domain}/`).hostname;
  } catch {
    return { ok: false, reason: 'domain (idna)' };
  }
  if (ascii !== ascii.toLowerCase() || !ASCII_DOMAIN.test(ascii)) return { ok: false, reason: 'domain syntax' };
  const address = `${local}@${ascii}`;
  if (address.length > LIMITS.emailMax) return { ok: false, reason: 'too long' };
  return { ok: true, address, key: `${local.toLowerCase()}@${ascii}` };
}
