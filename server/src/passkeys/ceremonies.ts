// WebAuthn ceremonies (design §4.1, §5.6): the challenge an options call handed out, checked once by the
// call that verifies the browser's answer. A ceremony works for 5 minutes (10 for the sign-in field's
// autofill), and its id reaches only the client that asked for it.
//
// - Signing in (purpose 'login') is anonymous, so its options call stores nothing: anyone can ask, and a
//   table that anyone can fill would cost rows written on Cloudflare and could crowd out the others. The
//   ceremony id carries its own state, signed: base64url(payload) + '.' + base64url(HMAC-SHA256(ceremonyKey,
//   base64url(payload))), payload { v: 1, purpose: 'login', challenge, exp }, under the instance setting
//   ceremonyKey. The sign-in checks the signature (in constant time) and exp, and consumes the ceremony
//   before it verifies by inserting its row: the UNIQUE ceremony_hash refuses every later use. The id is
//   canonical (the signature is compared as text), so its sha256 names one ceremony only.
// - Every other purpose is bound to a session (register, reauth: the user and the session), to an email
//   token (signup; reset, with its user) or to an invitation (invite), and stores its row when its options
//   are made: at most 5 unexpired rows per binding (the oldest goes when a sixth is made), so nothing
//   anonymous can block anyone's registration. The verifying call deletes the row (DELETE … RETURNING)
//   before it verifies, so the ceremony is used once whatever the verification says, then checks the
//   bindings against its own request.
// - Maintenance deletes expired rows of every purpose (directory/service.ts).

import { createHmac } from 'node:crypto';
import { fromBase64Url, randomToken, safeEqual, sha256Hex, toBase64Url } from '../core/crypto';
import type { Db } from '../core/db';

/** A ceremony's lifetime: 5 minutes, 10 for the sign-in field's autofill (conditional UI). */
export const CEREMONY_TTL_MS = 5 * 60_000;
export const CONDITIONAL_CEREMONY_TTL_MS = 10 * 60_000;

/** Unexpired ceremonies one binding may hold. */
export const CEREMONIES_PER_BINDING = 5;

export type CeremonyPurpose = 'login' | 'register' | 'reauth' | 'signup' | 'invite' | 'reset';

/** What a stored ceremony is bound to, by purpose (§5.6). */
export type CeremonyBinding =
  | { purpose: 'register' | 'reauth'; userId: number; sessionId: number }
  | { purpose: 'signup'; emailTokenId: number }
  | { purpose: 'reset'; emailTokenId: number; userId: number }
  | { purpose: 'invite'; invitationId: number };

export interface CeremonyRow {
  id: number;
  ceremony_hash: string;
  challenge: string;
  purpose: CeremonyPurpose;
  user_id: number | null;
  session_id: number | null;
  email_token_id: number | null;
  invitation_id: number | null;
  /** signup and invite: the users.webauthn_user_id of the account to be created. */
  pending_user_handle: string | null;
  created_at: string;
  expires_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Signed sign-in ceremonies
// ---------------------------------------------------------------------------

interface LoginPayload {
  v: 1;
  purpose: 'login';
  challenge: string;
  /** ms epoch. */
  exp: number;
}

const mac = (key: string, payload: string) => toBase64Url(createHmac('sha256', key).update(payload).digest());

/** The id of a sign-in ceremony: its challenge and expiry, signed with the instance's ceremony key. */
export function signLoginCeremony(key: string, o: { challenge: string; exp: number }): string {
  const payload: LoginPayload = { v: 1, purpose: 'login', challenge: o.challenge, exp: o.exp };
  const text = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${text}.${mac(key, text)}`;
}

/**
 * The challenge and expiry of a sign-in ceremony id, when its signature is good and it has not expired;
 * null otherwise (tampered, expired, another purpose, not a sign-in ceremony at all).
 */
export function openLoginCeremony(key: string, ceremonyId: string, nowMs: number): { challenge: string; exp: number } | null {
  const dot = ceremonyId.indexOf('.');
  if (dot <= 0 || ceremonyId.length > 200) return null;
  const text = ceremonyId.slice(0, dot);
  // Compared as text (in constant time), so only the canonical encoding of the signature is accepted.
  if (!safeEqual(ceremonyId.slice(dot + 1), mac(key, text))) return null;
  let payload: Partial<LoginPayload> | null;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(text))) as Partial<LoginPayload> | null;
  } catch {
    return null;
  }
  if (payload?.v !== 1 || payload.purpose !== 'login' || typeof payload.challenge !== 'string' || typeof payload.exp !== 'number') return null;
  if (!(payload.exp > nowMs) || payload.exp > nowMs + CONDITIONAL_CEREMONY_TTL_MS) return null;
  return { challenge: payload.challenge, exp: payload.exp };
}

/**
 * Use up a sign-in ceremony (before its answer is verified): its row is inserted, and the UNIQUE
 * ceremony_hash refuses a second insert. False when it was used already.
 */
export function consumeLoginCeremony(db: Db, ceremonyId: string, o: { challenge: string; exp: number }, nowMs: number): boolean {
  const row = db.get<{ id: number }>(
    `INSERT INTO webauthn_challenges (ceremony_hash, challenge, purpose, created_at, expires_at)
     VALUES (:hash, :challenge, 'login', :now, :exp)
     ON CONFLICT (ceremony_hash) DO NOTHING
     RETURNING id`,
    { hash: sha256Hex(ceremonyId), challenge: o.challenge, now: iso(nowMs), exp: iso(o.exp) },
  );
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Stored ceremonies
// ---------------------------------------------------------------------------

/** The column that holds each purpose's binding, which the 5-row cap counts on. */
const BINDING_COLUMN = {
  register: 'session_id',
  reauth: 'session_id',
  signup: 'email_token_id',
  reset: 'email_token_id',
  invite: 'invitation_id',
} as const satisfies Record<CeremonyBinding['purpose'], string>;

function bindingValue(b: CeremonyBinding): number {
  switch (b.purpose) {
    case 'register':
    case 'reauth':
      return b.sessionId;
    case 'signup':
    case 'reset':
      return b.emailTokenId;
    case 'invite':
      return b.invitationId;
  }
}

/**
 * Store a ceremony for `binding` and return its id (32 random bytes, base64url; the row keeps its sha256).
 * The binding keeps its 5 newest unexpired ceremonies; older and expired ones are deleted.
 */
export function storeCeremony(
  db: Db,
  o: { binding: CeremonyBinding; challenge: string; pendingUserHandle?: string | null; nowMs: number; ttlMs?: number },
): string {
  const ceremonyId = randomToken();
  const b = o.binding;
  const column = BINDING_COLUMN[b.purpose];
  const now = iso(o.nowMs);
  db.tx(() => {
    db.run(
      `INSERT INTO webauthn_challenges (ceremony_hash, challenge, purpose, user_id, session_id, email_token_id, invitation_id,
         pending_user_handle, created_at, expires_at)
       VALUES (:hash, :challenge, :purpose, :userId, :sessionId, :emailTokenId, :invitationId, :handle, :now, :expires)`,
      {
        hash: sha256Hex(ceremonyId),
        challenge: o.challenge,
        purpose: b.purpose,
        userId: 'userId' in b ? b.userId : null,
        sessionId: 'sessionId' in b ? b.sessionId : null,
        emailTokenId: 'emailTokenId' in b ? b.emailTokenId : null,
        invitationId: 'invitationId' in b ? b.invitationId : null,
        handle: o.pendingUserHandle ?? null,
        now,
        expires: iso(o.nowMs + (o.ttlMs ?? CEREMONY_TTL_MS)),
      },
    );
    db.run(
      `DELETE FROM webauthn_challenges WHERE purpose = :purpose AND ${column} = :value
         AND (expires_at <= :now OR id NOT IN (
           SELECT id FROM webauthn_challenges WHERE purpose = :purpose AND ${column} = :value AND expires_at > :now
           ORDER BY id DESC LIMIT ${CEREMONIES_PER_BINDING}))`,
      { purpose: b.purpose, value: bindingValue(b), now },
    );
  });
  return ceremonyId;
}

/**
 * Use up the stored ceremony `ceremonyId` of `purpose` while it has not expired (deleted, so it works once
 * whatever follows); null when there is none. The caller checks the row's bindings (ceremonyMatches).
 */
export function consumeCeremony(db: Db, ceremonyId: string, purpose: CeremonyBinding['purpose'], nowMs: number): CeremonyRow | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ceremonyId)) return null;
  return (
    db.get<CeremonyRow>('DELETE FROM webauthn_challenges WHERE ceremony_hash = :hash AND purpose = :purpose AND expires_at > :now RETURNING *', {
      hash: sha256Hex(ceremonyId),
      purpose,
      now: iso(nowMs),
    }) ?? null
  );
}

/** Whether a consumed ceremony was made for this request's binding (the same session, token or invitation). */
export function ceremonyMatches(row: CeremonyRow, binding: CeremonyBinding): boolean {
  if (row.purpose !== binding.purpose) return false;
  switch (binding.purpose) {
    case 'register':
    case 'reauth':
      return row.user_id === binding.userId && row.session_id === binding.sessionId;
    case 'signup':
      return row.email_token_id === binding.emailTokenId && row.pending_user_handle !== null;
    case 'reset':
      return row.email_token_id === binding.emailTokenId && row.user_id === binding.userId;
    case 'invite':
      return row.invitation_id === binding.invitationId && row.pending_user_handle !== null;
  }
}
