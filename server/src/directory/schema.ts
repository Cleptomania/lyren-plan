// The directory database (design §3.2): accounts, sessions, device and email tokens, spaces and
// memberships, invitations, passkeys and their ceremonies, throttles, security events and the
// instance settings. One per instance: DB_PATH on Node, the DirectoryDO named 'directory' on
// Cloudflare. Migrations run through core/migrate.ts (state in _meta, §3.7); append new ones to
// DIRECTORY_MIGRATIONS and never edit one that has shipped.
//
// Conventions as in db/schema.ts: AUTOINCREMENT ids, ISO-8601 UTC TEXT timestamps from
// toISOString(), INTEGER 0/1 booleans, JSON as TEXT. No BLOB columns (binary values are base64url
// TEXT, so node:sqlite's Uint8Array and a DO's ArrayBuffer never differ) and no SQL functions of
// our own: every comparison key (email_key) is computed in JS and stored.

import type { Migration, MigrationSet } from '../core/migrate';

/** Migration 1 (§3.2). */
export const DIRECTORY_V1 = /* sql */ `
CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  email               TEXT,                         -- as entered; domain IDNA→ASCII lower-cased (§5.2); NULL only for legacy accounts
  email_key           TEXT UNIQUE,                  -- lower(local) || '@' || ascii-domain
  email_verified_at   TEXT,                         -- NULL = not verified
  username            TEXT UNIQUE COLLATE NOCASE,   -- legacy sign-in name (pre-upgrade accounts); NULL for new accounts
  display_name        TEXT NOT NULL,
  password_hash       TEXT,                         -- self-describing (§5.5); NULL = passkey-only
  password_changed_at TEXT,
  webauthn_user_id    TEXT NOT NULL UNIQUE,         -- base64url of 32 random bytes: the WebAuthn user handle
  is_instance_admin   INTEGER NOT NULL DEFAULT 0 CHECK (is_instance_admin IN (0, 1)),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  auth_epoch          INTEGER NOT NULL DEFAULT 0,   -- bumped by password reset/change and email change: older email tokens die
  preferences         TEXT NOT NULL DEFAULT '{}',   -- JSON UserPreferences (§3.6), validated on read
  notices_seen_at     TEXT,                         -- AuthStatusDTO.notices shows security notices newer than this (§5.8.11)
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_login_at       TEXT,
  CHECK ((email IS NULL) = (email_key IS NULL)),
  CHECK (email IS NOT NULL OR username IS NOT NULL)
);

CREATE TABLE sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash          TEXT NOT NULL UNIQUE,         -- sha256(token) hex, as today
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auth_method         TEXT NOT NULL CHECK (auth_method IN ('legacy', 'setup', 'password', 'passkey', 'signup', 'invite')),
  reauth_at           TEXT NOT NULL,                -- last credential proof in this session (§5.4.4)
  created_at          TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  expires_at          TEXT NOT NULL,                -- sliding (SESSION_TTL_DAYS)
  absolute_expires_at TEXT,                         -- hard cap (SESSION_MAX_DAYS); NULL = none
  user_agent          TEXT,
  ip                  TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE device_tokens (                        -- OWASP device cookies (§5.8.2): trusted browsers per account
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                -- sha256(token) hex
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL                        -- created_at + 365 days
);
CREATE INDEX device_tokens_user ON device_tokens(user_id);

CREATE TABLE email_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,                 -- sha256(token) hex; the raw token exists only in the link
  purpose     TEXT NOT NULL CHECK (purpose IN ('signup', 'verify_email', 'change_email', 'reset_password')),
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                        -- where the link was sent (the NEW address for change_email)
  email_key   TEXT NOT NULL,
  auth_epoch  INTEGER,                              -- users.auth_epoch when issued; must match on redeem (NULL for signup)
  issued_by   INTEGER REFERENCES users(id) ON DELETE SET NULL, -- admin-generated reset links (§5.8.11)
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  request_ip  TEXT,
  CHECK ((purpose = 'signup') = (user_id IS NULL))
);
CREATE INDEX email_tokens_user ON email_tokens(user_id, purpose);
CREATE INDEX email_tokens_key ON email_tokens(email_key, purpose);
CREATE INDEX email_tokens_expires ON email_tokens(expires_at);

CREATE TABLE spaces (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,   -- internal only, never in an API
  public_id    TEXT NOT NULL UNIQUE,                -- the space id (§4.2): URLs, DO name, file name
  name         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('provisioning', 'importing', 'active')),
  sync_version INTEGER NOT NULL DEFAULT 1,          -- bumped on every change the space's mirror must learn (§3.5)
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,                                -- soft delete (§5.8.16)
  deleted_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  purge_after  TEXT,                                -- deleted_at + SPACE_DELETE_GRACE_DAYS
  CHECK ((deleted_at IS NULL) = (purge_after IS NULL))
);
CREATE INDEX spaces_purge ON spaces(purge_after);
CREATE INDEX spaces_status ON spaces(status, created_at);

CREATE TABLE memberships (
  space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  added_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
) WITHOUT ROWID;
CREATE INDEX memberships_user ON memberships(user_id);

CREATE TABLE space_people (                         -- every account a space's mirror may hold (§3.5): members past
  space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,  -- and present, and authors mapped by imports
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (space_id, user_id)
) WITHOUT ROWID;
CREATE INDEX space_people_user ON space_people(user_id);

CREATE TABLE invitations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,                -- sha256(token); rotated on resend
  space_id     INTEGER REFERENCES spaces(id) ON DELETE CASCADE,   -- NULL = instance invitation (account only)
  email        TEXT NOT NULL,
  email_key    TEXT NOT NULL,
  role         TEXT CHECK (role IN ('admin', 'member', 'viewer')), -- never 'owner'; NULL iff space_id IS NULL
  invited_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  delivery     TEXT NOT NULL CHECK (delivery IN ('mail', 'link')), -- 'link' only with the log transport: shown to the inviter
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_sent_at TEXT NOT NULL,
  send_count   INTEGER NOT NULL DEFAULT 1,
  accepted_at  TEXT,
  accepted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   TEXT,                                -- also set on decline and on expiry replacement
  revoked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((space_id IS NULL) = (role IS NULL))
);
CREATE UNIQUE INDEX invitations_open ON invitations(COALESCE(space_id, 0), email_key)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_email ON invitations(email_key);
CREATE INDEX invitations_space ON invitations(space_id);

CREATE TABLE passkeys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,               -- base64url (registrationInfo.credential.id)
  public_key    TEXT NOT NULL,                      -- base64url COSE_Key
  algorithm     INTEGER NOT NULL CHECK (algorithm IN (-8, -7, -257)),
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT NOT NULL DEFAULT '[]',         -- JSON array of AuthenticatorTransport
  device_type   TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up     INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  aaguid        TEXT,
  rp_id         TEXT NOT NULL,                      -- RP ID at registration (detects domain moves)
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE webauthn_challenges (                  -- 'login' rows are written only when a signed login ceremony is
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,  -- consumed (§5.6); every other purpose at options time
  ceremony_hash       TEXT NOT NULL UNIQUE,         -- sha256 hex of the ceremony id handed to the client
  challenge           TEXT NOT NULL,                -- base64url, from generate*Options()
  purpose             TEXT NOT NULL CHECK (purpose IN ('login', 'register', 'reauth', 'signup', 'invite', 'reset')),
  user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,          -- register, reauth, reset
  session_id          INTEGER REFERENCES sessions(id) ON DELETE CASCADE,       -- register, reauth
  email_token_id      INTEGER REFERENCES email_tokens(id) ON DELETE CASCADE,   -- signup, reset
  invitation_id       INTEGER REFERENCES invitations(id) ON DELETE CASCADE,    -- invite
  pending_user_handle TEXT,                         -- signup/invite: the future users.webauthn_user_id
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges(expires_at);

CREATE TABLE auth_throttle (                        -- written on counted events only, some from their 3rd hit (§5.9)
  key           TEXT PRIMARY KEY,
  window_start  TEXT NOT NULL,
  count         INTEGER NOT NULL,
  blocked_until TEXT
) WITHOUT ROWID;

CREATE TABLE security_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- who did it, when not the user (admins)
  type        TEXT NOT NULL,                        -- §5.11
  ip          TEXT,
  user_agent  TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX security_events_user ON security_events(user_id, id);
CREATE INDEX security_events_created ON security_events(created_at);

CREATE TABLE instance_settings (                    -- admin-editable values (§5.3); JSON per key
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

const MIGRATIONS: ReadonlyArray<Migration> = [{ up: (db) => db.exec(DIRECTORY_V1) }];

export const DIRECTORY_MIGRATIONS: MigrationSet = { schema: 'directory', migrations: MIGRATIONS };
