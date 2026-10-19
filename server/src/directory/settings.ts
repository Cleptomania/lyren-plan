// Instance settings (design §5.3): admin-editable values in instance_settings, one JSON value per key.
// The environment seeds them when the directory is created (SIGNUP_POLICY, PASSWORD_MIN_LENGTH); later
// the admin UI or the CLI changes them, and the environment no longer overrides them.
//
//   signupPolicy       open / invite_only / closed (open needs a transport that delivers mail)
//   passwordMinLength  8-64, for passwords set from then on
//   ceremonyKey        32 random bytes, base64url: signs passkey login ceremonies (§5.6); never shown
//   setupCode          Cloudflare only: the generated first-run setup code, until the first account
//   legacySpaceId      Node only: the space the legacy upgrade made of the old data (§3.8)
//
// Also here: the first-run setup code itself (§5.8.1).

import { randomBytes } from 'node:crypto';
import { SIGNUP_POLICIES, type SignupPolicy } from '@shared/constants';
import { SIGNUP_SEED_WARNING, type DirectoryConfig } from '../core/config';
import { randomToken, toHex } from '../core/crypto';
import type { Db } from '../core/db';
import type { RuntimeInfo } from '../core/runtime';
import { HttpError } from '../http/errors';

export interface InstanceSettings {
  signupPolicy: SignupPolicy;
  passwordMinLength: number;
}

type SettingKey = 'signupPolicy' | 'passwordMinLength' | 'ceremonyKey' | 'setupCode' | 'legacySpaceId';

const UPSERT = `INSERT INTO instance_settings (key, value) VALUES (:key, :value)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value`;

function readSetting(db: Db, key: SettingKey): unknown {
  const row = db.get<{ value: string }>('SELECT value FROM instance_settings WHERE key = :key', { key });
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function writeSetting(db: Db, key: SettingKey, value: unknown): void {
  db.run(UPSERT, { key, value: JSON.stringify(value) });
}

const isPolicy = (v: unknown): v is SignupPolicy => typeof v === 'string' && (SIGNUP_POLICIES as readonly string[]).includes(v);
const isMinLength = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 8 && (v as number) <= 64;

/**
 * Create the settings the directory does not have yet: the seeds from the configuration and a new
 * ceremony key. Returns whether signupPolicy was seeded now (its seed warning is only true then).
 */
export function seedInstanceSettings(db: Db, config: Pick<DirectoryConfig, 'seed'>): { seededPolicy: boolean } {
  return db.tx(() => {
    const present = new Set(db.all<{ key: string }>('SELECT key FROM instance_settings').map((r) => r.key));
    const seed = (key: SettingKey, value: () => unknown) => {
      if (present.has(key)) return false;
      writeSetting(db, key, value());
      return true;
    };
    const seededPolicy = seed('signupPolicy', () => config.seed.signupPolicy);
    seed('passwordMinLength', () => config.seed.passwordMinLength);
    seed('ceremonyKey', () => randomToken(32));
    return { seededPolicy };
  });
}

/** The configuration's warnings worth printing after seeding (the SIGNUP_POLICY one only when seeded now). */
export function seedWarnings(config: Pick<DirectoryConfig, 'warnings'>, seededPolicy: boolean): string[] {
  return config.warnings.filter((w) => seededPolicy || w !== SIGNUP_SEED_WARNING);
}

/** The current settings; a missing or damaged value reads as the configuration's seed. */
export function getInstanceSettings(db: Db, config: Pick<DirectoryConfig, 'seed'>): InstanceSettings {
  const policy = readSetting(db, 'signupPolicy');
  const minLength = readSetting(db, 'passwordMinLength');
  return {
    signupPolicy: isPolicy(policy) ? policy : config.seed.signupPolicy,
    passwordMinLength: isMinLength(minLength) ? minLength : config.seed.passwordMinLength,
  };
}

/**
 * 409 mail_not_configured for `open` while sign-up links cannot be mailed (§5.3; `sendsTokens`, Mailer's:
 * a transport that delivers mail, or MAIL_LOG_BODIES in development, which writes them to the log).
 */
export function assertPolicyPossible(policy: SignupPolicy, sendsTokens: boolean): void {
  if (policy === 'open' && !sendsTokens) {
    throw new HttpError(409, 'mail_not_configured', 'Open sign-up needs a mail transport (MAIL_TRANSPORT)');
  }
}

/** Set the signup policy (CLI `policy`, the admin settings). `open` needs links that can be mailed. */
export function setSignupPolicy(db: Db, policy: SignupPolicy, sendsTokens: boolean): void {
  assertPolicyPossible(policy, sendsTokens);
  writeSetting(db, 'signupPolicy', policy);
}

/** Set the minimum length of passwords set from now on (the admin settings); existing passwords keep working. */
export function setPasswordMinLength(db: Db, minLength: number): void {
  if (!isMinLength(minLength)) throw new Error(`passwordMinLength must be an integer from 8 to 64, not ${minLength}`);
  writeSetting(db, 'passwordMinLength', minLength);
}

/**
 * The key that signs passkey sign-in ceremonies (§5.6): 32 random bytes in base64url, made when the directory
 * was created (seedInstanceSettings) and never shown. A damaged value is replaced (the ceremonies it signed,
 * at most 10 minutes' worth, stop working).
 */
export function getCeremonyKey(db: Db): string {
  const value = readSetting(db, 'ceremonyKey');
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  const fresh = randomToken(32);
  writeSetting(db, 'ceremonyKey', fresh);
  return fresh;
}

/** The space the legacy upgrade created (Node), or null. */
export function getLegacySpaceId(db: Db): string | null {
  const value = readSetting(db, 'legacySpaceId');
  return typeof value === 'string' ? value : null;
}

export function setLegacySpaceId(db: Db, spaceId: string): void {
  writeSetting(db, 'legacySpaceId', spaceId);
}

// ---------------------------------------------------------------------------
// The first-run setup code (§5.8.1)
// ---------------------------------------------------------------------------

/**
 * Where the setup code comes from: SETUP_TOKEN when set; otherwise 12 random hex characters, generated
 * when setup is required and no code is set, held in memory on Node and in instance_settings.setupCode
 * on Cloudflare (a Durable Object's memory does not survive eviction), and dropped with the first account.
 * Since the last account can never be deleted (§5.8.17), a running instance returns to setup only when
 * its data is deleted; generating lazily is defence in depth.
 */
export class SetupCode {
  /** Node: the generated code. */
  private memory: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Pick<DirectoryConfig, 'setupToken'>,
    private readonly runtime: RuntimeInfo['kind'],
    /** Called with every newly generated code. */
    private readonly announce: (code: string) => void,
  ) {}

  /** The code setup needs now, or null when none is set yet. */
  current(): string | null {
    if (this.config.setupToken !== null) return this.config.setupToken;
    if (this.runtime === 'node') return this.memory;
    const stored = readSetting(this.db, 'setupCode');
    return typeof stored === 'string' ? stored : null;
  }

  /** The code, generated now when none is set; `generated` says whether it was (it is not announced). */
  ensure(): { code: string; generated: boolean } {
    const code = this.current();
    if (code !== null) return { code, generated: false };
    const fresh = toHex(randomBytes(6));
    if (this.runtime === 'node') this.memory = fresh;
    else writeSetting(this.db, 'setupCode', fresh);
    return { code: fresh, generated: true };
  }

  /** ensure(), announcing a newly generated code. */
  ensureAnnounced(): string {
    const { code, generated } = this.ensure();
    if (generated) this.announce(code);
    return code;
  }

  /** Cloudflare: a failed setup attempt logs the code again (Workers Logs are the only place it is shown). */
  afterFailure(): void {
    if (this.runtime === 'cloudflare' && this.config.setupToken === null) {
      const code = this.current();
      if (code !== null) this.announce(code);
    }
  }

  /** The first account exists: drop a generated code (inside its transaction on Cloudflare). */
  clear(): void {
    this.memory = null;
    if (this.runtime === 'cloudflare') this.db.run("DELETE FROM instance_settings WHERE key = 'setupCode'");
  }
}

/** How a generated setup code is announced when the runtime gives no hook (§5.8.1). */
export function logSetupCode(runtime: RuntimeInfo['kind']): (code: string) => void {
  return runtime === 'node'
    ? (code) => console.log(`  Setup code: ${code}`)
    : (code) => console.log(`[lyren] Setup code: ${code}`);
}
