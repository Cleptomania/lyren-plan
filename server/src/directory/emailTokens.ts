// Link tokens (design §5.7): sign-up, email verification, email change and password reset, in
// email_tokens. A token is 32 random bytes in base64url; it exists only in the link (`#t=<token>`) and the
// directory keeps its sha256, so lookups are by hash.
//
// - Issuing a token of one purpose for a user (for sign-up: for an address) marks the older unused ones as
//   used: only the newest link works.
// - User-bound tokens carry the account's auth_epoch. A password set or reset and an email change bump it,
//   which kills every outstanding link of the account.
// - Inspecting reads a token without consuming it; redeeming consumes it atomically, so it works once.
// The routes answer every invalid, used, expired or stale token alike (400 invalid_token, one count on
// tk:<ip>).

import { randomToken, sha256Hex } from '../core/crypto';
import type { Db } from '../core/db';
import type { TrustedMeta } from '../core/ports';
import type { DirectoryContext } from './context';
import type { UserRow } from './users';

export type EmailTokenPurpose = 'signup' | 'verify_email' | 'change_email' | 'reset_password';

export interface EmailTokenRow {
  id: number;
  token_hash: string;
  purpose: EmailTokenPurpose;
  user_id: number | null;
  /** Where the link was sent (the new address of an email change). */
  email: string;
  email_key: string;
  auth_epoch: number | null;
  issued_by: number | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  request_ip: string | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How long each kind of link works (§5.7). */
export const TOKEN_TTL_MS: Readonly<Record<EmailTokenPurpose, number>> = {
  signup: 24 * HOUR,
  verify_email: 24 * HOUR,
  change_email: HOUR,
  reset_password: 30 * MINUTE,
};

/** A reset link handed to someone rather than mailed: an admin's (§5.8.11) and the recovery token's (§5.8.19). */
export const HANDED_RESET_TTL_MS = 24 * HOUR;

/** What randomToken() mints (32 bytes, 43 characters of base64url): anything else is no link token. */
export function isLinkToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A new token for `purpose`; the older unused ones of the same user (sign-up: the same address) stop working. */
export function issueEmailToken(
  db: Db,
  o: {
    purpose: EmailTokenPurpose;
    /** The account (and its auth_epoch now); null for sign-up. */
    user: { id: number; auth_epoch: number } | null;
    email: { address: string; key: string };
    ttlMs?: number;
    /** The admin who created a reset link (§5.8.11). */
    issuedBy?: number | null;
    meta: TrustedMeta | null;
    nowMs: number;
  },
): { token: string; expiresAt: string } {
  const token = randomToken();
  const now = iso(o.nowMs);
  const expiresAt = iso(o.nowMs + (o.ttlMs ?? TOKEN_TTL_MS[o.purpose]));
  db.tx(() => {
    if (o.user === null) {
      db.run('UPDATE email_tokens SET used_at = :now WHERE email_key = :key AND purpose = :purpose AND user_id IS NULL AND used_at IS NULL', {
        key: o.email.key,
        purpose: o.purpose,
        now,
      });
    } else {
      db.run('UPDATE email_tokens SET used_at = :now WHERE user_id = :userId AND purpose = :purpose AND used_at IS NULL', {
        userId: o.user.id,
        purpose: o.purpose,
        now,
      });
    }
    db.run(
      `INSERT INTO email_tokens (token_hash, purpose, user_id, email, email_key, auth_epoch, issued_by, created_at, expires_at, request_ip)
       VALUES (:hash, :purpose, :userId, :email, :key, :epoch, :issuedBy, :now, :expiresAt, :ip)`,
      {
        hash: sha256Hex(token),
        purpose: o.purpose,
        userId: o.user?.id ?? null,
        email: o.email.address,
        key: o.email.key,
        epoch: o.user?.auth_epoch ?? null,
        issuedBy: o.issuedBy ?? null,
        now,
        expiresAt,
        ip: o.meta?.clientIp ? o.meta.clientIp.slice(0, 100) : null,
      },
    );
  });
  return { token, expiresAt };
}

/** A user-bound token still carries its account's auth_epoch (sign-up tokens have no account). */
function current(db: Db, row: EmailTokenRow): boolean {
  if (row.user_id === null) return true;
  const user = db.get<{ auth_epoch: number }>('SELECT auth_epoch FROM users WHERE id = :id', { id: row.user_id });
  return user !== undefined && user.auth_epoch === row.auth_epoch;
}

/** The token while it works, for one of `purposes`, without consuming it (the inspect endpoints); else null. */
export function findEmailToken(db: Db, token: string, purposes: readonly EmailTokenPurpose[], nowMs: number): EmailTokenRow | null {
  if (!isLinkToken(token)) return null;
  const row = db.get<EmailTokenRow>('SELECT * FROM email_tokens WHERE token_hash = :hash AND used_at IS NULL AND expires_at > :now', {
    hash: sha256Hex(token),
    now: iso(nowMs),
  });
  if (!row || !purposes.includes(row.purpose) || !current(db, row)) return null;
  return row;
}

/**
 * Consume the token for `purpose` (single use: the UPDATE succeeds once); null when it does not work, and
 * for a stale auth_epoch (consumed all the same: it could never work again).
 */
export function redeemEmailToken(db: Db, token: string, purpose: EmailTokenPurpose, nowMs: number): EmailTokenRow | null {
  if (!isLinkToken(token)) return null;
  const now = iso(nowMs);
  const row = db.get<EmailTokenRow>(
    `UPDATE email_tokens SET used_at = :now
     WHERE token_hash = :hash AND purpose = :purpose AND used_at IS NULL AND expires_at > :now
     RETURNING *`,
    { hash: sha256Hex(token), purpose, now },
  );
  if (!row || !current(db, row)) return null;
  return row;
}

/**
 * A verify_email link for the account's current address (24 hours, bound to the address and the
 * auth_epoch), mailed later (§5.8.6). The caller has checked that links can be sent (mailer.sendsTokens).
 */
export function sendVerification(ctx: DirectoryContext, user: UserRow, meta: TrustedMeta | null): void {
  if (user.email === null || user.email_key === null) return;
  const { token } = issueEmailToken(ctx.db, {
    purpose: 'verify_email',
    user,
    email: { address: user.email, key: user.email_key },
    meta,
    nowMs: ctx.now(),
  });
  ctx.mailer.verifyEmail({ user, token, meta });
}
