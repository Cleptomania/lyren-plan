// The configuration both runtimes share (design Appendix B), parsed from a plain string map:
// process.env on Node (server/src/config.ts adds the Node-only settings), the Worker's variables and
// secrets on Cloudflare (runtime/cloudflare/config.ts). Each runtime has its own defaults, so a
// Cloudflare deployment with no variables at all gets the limits that fit the free plan.
//
// Rules for every variable:
// - an empty value (or one of spaces) counts as unset: dashboards and the Deploy button make empty
//   values easy to create;
// - an invalid value throws a ConfigError that names the variable (Node: exit code 2; Cloudflare: the
//   directory answers 503 with the reason), and never repeats a secret's value;
// - booleans are true for 1, true, yes or on (any case), false for anything else;
// - counts and limits of 0 mean "no limit" where the comment says so.
//
// Parsed elsewhere: PORT, HOST, DATA_DIR, DB_PATH, WEB_DIR, TRUST_PROXY, COOKIE_SECURE,
// SPACES_OPEN_MAX and ALLOW_ADMIN_BACKUP_DOWNLOAD (Node-only, server/src/config.ts, which uses the
// helpers below), and LYREN_DB_STRICT (read by NodeDb when it opens a database).
//
// Derived values: the passkey relying party (§5.6), the mail settings a transport needs (§5.10.1),
// the instance-settings seeds (§5.3) and warnings for the startup log and the admin overview.

import { APP_NAME, SIGNUP_POLICIES, type SignupPolicy } from '@shared/constants';
import { normalizeEmail } from './email';
import type { RuntimeInfo } from './runtime';

export type RuntimeKind = RuntimeInfo['kind'];

/** A runtime's variables: process.env, or the Worker's env with its bindings left out. */
export type ConfigVars = Readonly<Record<string, string | undefined>>;

/** Snapshots of each kind kept by default (SNAPSHOT_KEEP; Node). */
export const DEFAULT_SNAPSHOT_KEEP = 10;

/** RECOVERY_TOKEN must be at least this long (§5.8.19). */
export const RECOVERY_TOKEN_MIN_LENGTH = 32;

/** Body limit of the public directory endpoints (setup, login, signup, …; §7.1). Not configurable. */
export const AUTH_BODY_LIMIT = 64 * 1024;

/** Public directory paths outside /api/auth/: an invitation's page works signed out (§5.8.8). */
const PUBLIC_INVITATION_PATHS: ReadonlySet<string> = new Set([
  '/api/invitations/inspect',
  '/api/invitations/accept',
  '/api/invitations/accept/passkey/options',
  '/api/invitations/accept/passkey',
]);

/**
 * The directory endpoints that need no session (each checks what it needs itself) and take
 * AUTH_BODY_LIMIT: /api/auth/… and the invitation page's inspect and accept.
 */
export function isPublicDirectoryPath(path: string): boolean {
  return path.startsWith('/api/auth/') || PUBLIC_INVITATION_PATHS.has(path);
}

/**
 * The warning for SIGNUP_POLICY=open with the log transport. It is only true while the directory is
 * created (later the instance setting decides), so the directory prints it only when it seeds.
 */
export const SIGNUP_SEED_WARNING = 'SIGNUP_POLICY=open needs a mail transport (MAIL_TRANSPORT); using invite_only';

export const MAIL_TRANSPORTS = ['log', 'smtp', 'resend', 'cloudflare'] as const;
export type MailTransportKind = (typeof MAIL_TRANSPORTS)[number];

export const PASSWORD_KDFS = ['scrypt', 'pbkdf2'] as const;
export type PasswordKdf = (typeof PASSWORD_KDFS)[number];

export const SMTP_SECURITIES = ['tls', 'starttls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

/**
 * The warning of §5.10.2 (startup log, admin overview) while MAIL_LOG_BODIES makes the log transport print
 * links, unless PUBLIC_URL is on this machine (Node; on Cloudflare only `wrangler dev` is local).
 */
export const MAIL_LOG_BODIES_WARNING = 'MAIL_LOG_BODIES is on: sign-in links are written to the logs';

/** A configuration value the app cannot run with. `variable` is the environment variable's name. */
export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// The configuration
// ---------------------------------------------------------------------------

export interface AppConfig {
  runtime: RuntimeKind;
  /**
   * PUBLIC_URL as an origin ('https://plan.example.com'), or null when unset. Emailed links and
   * passkeys need it; on Cloudflare it is also the only host the API answers (§10.2).
   */
  publicUrl: string | null;
  /** LOG_REQUESTS: log each request (Node: stdout; Cloudflare: Workers Logs). */
  logRequests: boolean;
  /** BODY_LIMIT: bytes of a request body, except the public directory endpoints and imports. */
  bodyLimit: number;
  /** IMPORT_BODY_LIMIT: bytes of a space import, uploaded and unpacked. */
  importBodyLimit: number;
  directory: DirectoryConfig;
  space: SpaceAppConfig;
}

/** What the directory app and service need: accounts, sessions, passkeys, mail and quotas. */
export interface DirectoryConfig {
  /** INSTANCE_NAME (default "Lyren Plan"): shown in mail and as the passkey relying party's name. */
  instanceName: string;
  /** PUBLIC_URL's origin, or null (AppConfig.publicUrl). */
  publicUrl: string | null;
  /**
   * SETUP_TOKEN: the first-run setup code. null = the directory generates one whenever setup is
   * required and no code is set (§5.8.1).
   */
  setupToken: string | null;
  /** Tests only: setup needs no code. Never set from the environment (§5.8.1). */
  setupCodeDisabled: boolean;
  /** BODY_LIMIT (AppConfig.bodyLimit): bytes of a request body to a signed-in directory endpoint. */
  bodyLimit: number;
  /** RECOVERY_TOKEN (at least 32 characters), or null: POST /api/auth/recover answers 404 (§5.8.19). */
  recoveryToken: string | null;
  /** Seeds of the instance settings when the directory is created; later the admin UI decides (§5.3). */
  seed: {
    /**
     * SIGNUP_POLICY (default invite_only). 'open' needs a transport that delivers mail: with the log
     * transport it is seeded as invite_only, with a warning.
     */
    signupPolicy: SignupPolicy;
    /** PASSWORD_MIN_LENGTH, 8-64 (default 8 on Node, 12 on Cloudflare). */
    passwordMinLength: number;
  };
  /** PASSWORD_KDF (default scrypt): the algorithm of new password hashes (§5.5). */
  passwordKdf: PasswordKdf;
  /**
   * PASSWORD_SCRYPT_P (default 5 on Node, 1 on Cloudflare): scrypt's parallelization for new hashes
   * (N = 16384, r = 8). At most 8, since verification accepts N·r·p up to 2^20.
   */
  passwordScryptP: number;
  /** SESSION_TTL_DAYS (default 30, at most 400): the sliding session lifetime. */
  sessionTtlDays: number;
  /** SESSION_MAX_DAYS (default 0 = none on Node, 90 on Cloudflare): the absolute session lifetime. */
  sessionMaxDays: number;
  /** REAUTH_MINUTES (default 10): how long a password or passkey proof opens the re-auth window. */
  reauthMinutes: number;
  /** INVITATION_TTL_DAYS (default 7). */
  invitationTtlDays: number;
  /** SPACE_DELETE_GRACE_DAYS (default 7; 0 = purge at once): how long a deleted space can be restored. */
  spaceDeleteGraceDays: number;
  passkeys: PasskeyConfig;
  mail: MailConfig;
  quotas: QuotaConfig;
  /**
   * Configuration that works but is probably not what the operator meant, for the startup log and the
   * admin overview. (The SIGNUP_POLICY one only matters while the directory is created: later the
   * instance setting decides.)
   */
  warnings: string[];
}

/**
 * Passkeys (§5.6): on when PUBLIC_URL is an https origin (or http://localhost) whose host is not an
 * IP address. rpId is WEBAUTHN_RP_ID or PUBLIC_URL's host; origin is PUBLIC_URL's. Neither is ever
 * taken from a request's Host header.
 */
export interface PasskeyConfig {
  enabled: boolean;
  /** null while disabled. */
  rpId: string | null;
  /** null while disabled. */
  origin: string | null;
  /** INSTANCE_NAME. */
  rpName: string;
  /** Why passkeys are off (for the admin overview); null while enabled. */
  disabledReason: string | null;
}

export interface MailFrom {
  /** MAIL_FROM, normalized (normalizeEmail's address). */
  address: string;
  /** MAIL_FROM_NAME (default INSTANCE_NAME). */
  name: string;
}

export interface SmtpConfig {
  /** SMTP_HOST. */
  host: string;
  /** SMTP_PORT (default 465 with tls, 587 with starttls, 25 with none). */
  port: number;
  /**
   * SMTP_SECURITY (default tls): implicit TLS, or STARTTLS (which the server must offer), the certificate
   * verified against SMTP_HOST either way; or none, only for a mail server on this machine (SMTP_HOST
   * localhost, 127.x.x.x or [::1]) and without AUTH: a local relay or a development mail catcher.
   */
  security: SmtpSecurity;
  /** SMTP_USER and SMTP_PASS, both or neither; null = no AUTH. */
  user: string | null;
  pass: string | null;
  /** SMTP_EHLO_NAME (default PUBLIC_URL's host). */
  ehloName: string;
}

/** Mail (§5.10.1). Every transport but log needs MAIL_FROM and PUBLIC_URL (links). */
export interface MailConfig {
  /** MAIL_TRANSPORT (default log): only log does not deliver mail. */
  transport: MailTransportKind;
  /** null only with the log transport when MAIL_FROM is unset. */
  from: MailFrom | null;
  /** MAIL_REPLY_TO, normalized, or null. */
  replyTo: string | null;
  /** MAIL_DAILY_CAP (default 200): messages per UTC day; 40% of them for anonymous-triggered mail. */
  dailyCap: number;
  /** MAIL_LOG_BODIES (development only): the log transport prints whole messages, links included. */
  logBodies: boolean;
  /** With MAIL_TRANSPORT=smtp; null otherwise. */
  smtp: SmtpConfig | null;
  /** RESEND_API_KEY, with MAIL_TRANSPORT=resend; null otherwise. */
  resendApiKey: string | null;
}

/** Instance quotas (§11.4); 0 = no limit. */
export interface QuotaConfig {
  /** MAX_SPACES_PER_USER (Node 0, Cloudflare 5): owned spaces, soft-deleted ones until purged. */
  maxSpacesPerUser: number;
  /** SPACES_CREATED_PER_DAY (Node 0, Cloudflare 10): per account. */
  spacesCreatedPerDay: number;
  /** MAX_MEMBERS_PER_SPACE (Node 0, Cloudflare 20): members plus open invitations. */
  maxMembersPerSpace: number;
  /** MAX_OPEN_INVITATIONS_PER_SPACE (50). */
  maxOpenInvitationsPerSpace: number;
  /** INVITATIONS_PER_DAY (20): per inviter (5 for accounts younger than 24 hours, instance admins excepted). */
  invitationsPerDay: number;
  /** IMPORT_BODY_LIMIT (never 0): what InstanceInfoDTO.limits.importMaxBytes shows. */
  importMaxBytes: number;
  /** IMPORT_MAX_ROW_WRITES (Node 0, Cloudflare 50,000): estimated rows written per import. */
  importMaxRowWrites: number;
  /** IMPORT_DAILY_ROW_WRITES (Node 0, Cloudflare 60,000): estimated import row writes per UTC day, instance-wide. */
  importDailyRowWrites: number;
}

/** What a space app and its host need (Deps.config). */
export interface SpaceAppConfig {
  /** BODY_LIMIT (AppConfig.bodyLimit). */
  bodyLimit: number;
  /** IMPORT_BODY_LIMIT (AppConfig.importBodyLimit). */
  importBodyLimit: number;
  /**
   * IMPORT_MAX_JSON_VALUES (Node 1,000,000, Cloudflare 300,000): objects, arrays and list items
   * counted before an import is parsed. Parsing takes about 90 bytes of heap per value at worst
   * (objects), so Node's default fits the 128 MB old space V8 gives a 512 MB machine (Appendix D 62).
   */
  importMaxJsonValues: number;
  /** IMPORT_MAX_ROW_WRITES (QuotaConfig.importMaxRowWrites); 0 = no limit. */
  importMaxRowWrites: number;
  /** SPACE_DAILY_ROW_WRITES (Node 0, Cloudflare 20,000): billed row writes per space and UTC day; 0 = no limit. */
  spaceDailyRowWrites: number;
  /** SPACE_MAX_BYTES (Node 0, Cloudflare 200 MiB): above it most writes are refused; 0 = no limit. */
  spaceMaxBytes: number;
  /** SNAPSHOT_KEEP (Node; default 10, 0 = keep all): pre-import and pre-upgrade snapshots of each kind to keep. */
  snapshotKeep: number;
  /** AUTH_CACHE_SECONDS (Cloudflare; default 30, 0 = none): how long a space host reuses an authorization. Node: 0. */
  authCacheSeconds: number;
  /** REAUTH_MINUTES (DirectoryConfig.reauthMinutes): the re-auth window the gate checks (§5.4.4, §6.4). */
  reauthMinutes: number;
}

// ---------------------------------------------------------------------------
// Reading variables (also used by server/src/config.ts)
// ---------------------------------------------------------------------------

/** The trimmed value, or undefined when unset or empty. */
export function readText(vars: ConfigVars, name: string): string | undefined {
  const v = vars[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

/** A secret, exactly as given (not trimmed), or undefined when unset or empty. */
function readSecret(vars: ConfigVars, name: string): string | undefined {
  const v = vars[name];
  return v === undefined || v === '' ? undefined : v;
}

/** A boolean variable: unset or empty -> `fallback`; else true only for 1, true, yes or on (any case). */
export function readBool(vars: ConfigVars, name: string, fallback: boolean): boolean {
  const v = readText(vars, name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** An integer variable within min..max: unset or empty -> `fallback`. */
export function readInt(vars: ConfigVars, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER, min = 1): number {
  const v = vars[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(name, `Invalid value for ${name}: ${v} (expected ${min}..${max})`);
  }
  return n;
}

/** One of `values`, compared case-insensitively: unset or empty -> `fallback`. */
function readChoice<T extends string>(vars: ConfigVars, name: string, values: readonly T[], fallback: T): T {
  const v = readText(vars, name);
  if (v === undefined) return fallback;
  const choice = values.find((value) => value === v.toLowerCase());
  if (choice === undefined) {
    throw new ConfigError(name, `Invalid value for ${name}: ${v} (expected ${values.join(', ')})`);
  }
  return choice;
}

/** A name for people to read (INSTANCE_NAME, MAIL_FROM_NAME): 1-100 characters, no control characters. */
function readName(vars: ConfigVars, name: string, fallback: string): string {
  const v = readText(vars, name);
  if (v === undefined) return fallback;
  if (v.length > 100 || /[\x00-\x1f\x7f]/.test(v)) {
    const expected = 'expected up to 100 characters, no line breaks';
    throw new ConfigError(name, `Invalid value for ${name}: ${JSON.stringify(v)} (${expected})`);
  }
  return v;
}

function readAddress(vars: ConfigVars, name: string): string | undefined {
  const v = readText(vars, name);
  if (v === undefined) return undefined;
  const email = normalizeEmail(v);
  if (!email.ok) throw new ConfigError(name, `Invalid value for ${name}: ${v} (expected an email address)`);
  return email.address;
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

/** Public suffixes a relying party ID must not be (§5.6). */
const PUBLIC_SUFFIX_RP_IDS = new Set(['workers.dev', 'pages.dev']);

const isIpHost = (host: string): boolean => host.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);

/**
 * PUBLIC_URL: an http(s) origin, a trailing slash allowed. On Cloudflare an https one, or http on this machine
 * (wrangler dev): the Worker answers no other origin (gateway/guards.ts#checkHost), so an http PUBLIC_URL
 * would serve sign-ins over cleartext and put http links in mail.
 */
function readPublicUrl(vars: ConfigVars, runtime: RuntimeKind): URL | null {
  const v = readText(vars, 'PUBLIC_URL');
  if (v === undefined) return null;
  let url: URL | null = null;
  try {
    url = new URL(v);
  } catch {
    // reported below
  }
  if (
    url === null ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    /[?#]/.test(v)
  ) {
    const expected = 'expected an origin such as https://plan.example.com';
    throw new ConfigError('PUBLIC_URL', `Invalid value for PUBLIC_URL: ${v} (${expected})`);
  }
  if (runtime === 'cloudflare' && url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    const expected = 'expected an https origin such as https://plan.example.com; http only for localhost under wrangler dev';
    throw new ConfigError('PUBLIC_URL', `Invalid value for PUBLIC_URL: ${v} (${expected})`);
  }
  return url;
}

/** The passkey relying party (§5.6), from PUBLIC_URL and WEBAUTHN_RP_ID. */
function passkeyConfig(vars: ConfigVars, url: URL | null, rpName: string): PasskeyConfig {
  const rpIdVar = readText(vars, 'WEBAUTHN_RP_ID');
  const off = (reason: string): PasskeyConfig => {
    if (rpIdVar !== undefined) {
      throw new ConfigError('WEBAUTHN_RP_ID', `WEBAUTHN_RP_ID is set, but passkeys are off: ${reason}`);
    }
    return { enabled: false, rpId: null, origin: null, rpName, disabledReason: reason };
  };
  if (url === null) return off('PUBLIC_URL is not set');
  const host = url.hostname;
  if (url.protocol !== 'https:' && host !== 'localhost') {
    return off('PUBLIC_URL is not an https origin (or http://localhost)');
  }
  if (isIpHost(host)) return off('PUBLIC_URL is an IP address, not a host name');
  let rpId = host;
  if (rpIdVar !== undefined) {
    let candidate = '';
    try {
      // The same IDNA conversion as PUBLIC_URL's host; characters the URL parser treats specially are refused.
      if (!/[%\/\\?#:@\s\[\]]/.test(rpIdVar)) candidate = new URL(`http://${rpIdVar}/`).hostname;
    } catch {
      // reported below
    }
    const fits = candidate === host || (candidate.includes('.') && host.endsWith(`.${candidate}`));
    if (!fits || PUBLIC_SUFFIX_RP_IDS.has(candidate)) {
      const expected =
        `expected PUBLIC_URL's host, ${host}, or a parent domain of it with at least two labels, ` +
        'other than workers.dev or pages.dev';
      throw new ConfigError('WEBAUTHN_RP_ID', `Invalid value for WEBAUTHN_RP_ID: ${rpIdVar} (${expected})`);
    }
    rpId = candidate;
  }
  return { enabled: true, rpId, origin: url.origin, rpName, disabledReason: null };
}

/** localhost, 127.0.0.0/8 or [::1]: a mail server, or under wrangler dev the Worker, on this machine. */
export const isLoopbackHost = (host: string): boolean =>
  host.toLowerCase() === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';

/** An EHLO name for a host: an address literal for IP addresses. */
function ehloNameFor(host: string): string {
  if (host.startsWith('[')) return `[IPv6:${host.slice(1, -1)}]`;
  return isIpHost(host) ? `[${host}]` : host;
}

/** Mail (§5.10.1): what the chosen transport needs, checked at startup. */
function mailConfig(vars: ConfigVars, runtime: RuntimeKind, url: URL | null, instanceName: string): MailConfig {
  const transport = readChoice(vars, 'MAIL_TRANSPORT', MAIL_TRANSPORTS, 'log');
  const fromAddress = readAddress(vars, 'MAIL_FROM');
  const fromName = readName(vars, 'MAIL_FROM_NAME', instanceName);
  const mail: MailConfig = {
    transport,
    from: fromAddress === undefined ? null : { address: fromAddress, name: fromName },
    replyTo: readAddress(vars, 'MAIL_REPLY_TO') ?? null,
    dailyCap: readInt(vars, 'MAIL_DAILY_CAP', 200),
    logBodies: readBool(vars, 'MAIL_LOG_BODIES', false),
    smtp: null,
    resendApiKey: null,
  };
  if (transport === 'log') return mail;

  if (transport === 'cloudflare' && runtime !== 'cloudflare') {
    throw new ConfigError('MAIL_TRANSPORT', 'MAIL_TRANSPORT=cloudflare works only on Cloudflare (use smtp or resend)');
  }
  if (fromAddress === undefined) {
    throw new ConfigError('MAIL_FROM', `MAIL_FROM is required with MAIL_TRANSPORT=${transport}`);
  }
  if (url === null) {
    throw new ConfigError('PUBLIC_URL', `PUBLIC_URL is required with MAIL_TRANSPORT=${transport} (mail contains links)`);
  }
  if (transport === 'resend') {
    const key = readText(vars, 'RESEND_API_KEY');
    if (key === undefined) throw new ConfigError('RESEND_API_KEY', 'RESEND_API_KEY is required with MAIL_TRANSPORT=resend');
    return { ...mail, resendApiKey: key };
  }
  if (transport === 'smtp') {
    const host = readText(vars, 'SMTP_HOST');
    if (host === undefined) throw new ConfigError('SMTP_HOST', 'SMTP_HOST is required with MAIL_TRANSPORT=smtp');
    if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])$/.test(host)) {
      throw new ConfigError('SMTP_HOST', `Invalid value for SMTP_HOST: ${host} (expected a host name or an IP address)`);
    }
    const security = readChoice(vars, 'SMTP_SECURITY', SMTP_SECURITIES, 'tls');
    const port = readInt(vars, 'SMTP_PORT', { tls: 465, starttls: 587, none: 25 }[security], 65535);
    if (port === 25 && runtime === 'cloudflare') {
      // SMTP_SECURITY=none's default port: a local mail catcher under wrangler dev listens on its own.
      const message =
        security === 'none' && readText(vars, 'SMTP_PORT') === undefined
          ? "SMTP_SECURITY=none uses port 25 by default, which is blocked on Cloudflare Workers: set SMTP_PORT to your mail catcher's port"
          : 'SMTP_PORT=25 is blocked on Cloudflare Workers (use 465 or 587)';
      throw new ConfigError('SMTP_PORT', message);
    }
    const user = readText(vars, 'SMTP_USER') ?? null;
    const pass = readSecret(vars, 'SMTP_PASS') ?? null;
    if ((user === null) !== (pass === null)) {
      const missing = user === null ? 'SMTP_USER' : 'SMTP_PASS';
      throw new ConfigError(missing, 'SMTP_USER and SMTP_PASS are set together, or neither');
    }
    if (security === 'none') {
      // No TLS: only to this machine (nothing crosses a network in clear text), and never with credentials.
      if (!isLoopbackHost(host)) {
        throw new ConfigError('SMTP_SECURITY', 'SMTP_SECURITY=none is only for a mail server on this machine (SMTP_HOST localhost, 127.0.0.1 or [::1]); use tls or starttls');
      }
      if (user !== null) throw new ConfigError('SMTP_SECURITY', 'SMTP_SECURITY=none sends no credentials: unset SMTP_USER and SMTP_PASS, or use tls or starttls');
    }
    const ehloName = readText(vars, 'SMTP_EHLO_NAME') ?? ehloNameFor(url.hostname);
    if (!/^(?:[A-Za-z0-9.-]+|\[[0-9A-Za-z:.]+\])$/.test(ehloName)) {
      throw new ConfigError('SMTP_EHLO_NAME', `Invalid value for SMTP_EHLO_NAME: ${ehloName} (expected a host name)`);
    }
    return { ...mail, smtp: { host, port, security, user, pass, ehloName } };
  }
  // cloudflare: the deployer adds the send_email binding EMAIL; the driver reports it when missing.
  return mail;
}

/** The defaults that differ between the runtimes (Appendix B). */
interface RuntimeDefaults {
  importBodyLimit: number;
  importMaxJsonValues: number;
  passwordMinLength: number;
  passwordScryptP: number;
  sessionMaxDays: number;
  maxSpacesPerUser: number;
  spacesCreatedPerDay: number;
  maxMembersPerSpace: number;
  importMaxRowWrites: number;
  importDailyRowWrites: number;
  spaceDailyRowWrites: number;
  spaceMaxBytes: number;
  authCacheSeconds: number;
}

const MIB = 1024 * 1024;

const RUNTIME_DEFAULTS: Record<RuntimeKind, RuntimeDefaults> = {
  // Today's behaviour: no quotas, larger imports, a stronger scrypt (about 70 ms).
  node: {
    importBodyLimit: 50 * MIB,
    importMaxJsonValues: 1_000_000,
    passwordMinLength: 8,
    passwordScryptP: 5,
    sessionMaxDays: 0,
    maxSpacesPerUser: 0,
    spacesCreatedPerDay: 0,
    maxMembersPerSpace: 0,
    importMaxRowWrites: 0,
    importDailyRowWrites: 0,
    spaceDailyRowWrites: 0,
    spaceMaxBytes: 0,
    authCacheSeconds: 0,
  },
  // The Workers Free plan (§11): its daily row quotas, isolate memory and CPU.
  cloudflare: {
    importBodyLimit: 4 * MIB,
    importMaxJsonValues: 300_000,
    passwordMinLength: 12,
    passwordScryptP: 1,
    sessionMaxDays: 90,
    maxSpacesPerUser: 5,
    spacesCreatedPerDay: 10,
    maxMembersPerSpace: 20,
    importMaxRowWrites: 50_000,
    importDailyRowWrites: 60_000,
    spaceDailyRowWrites: 20_000,
    spaceMaxBytes: 200 * MIB,
    authCacheSeconds: 30,
  },
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The configuration of `runtime` from its variables; throws a ConfigError for an invalid one. */
export function parseAppConfig(vars: ConfigVars, runtime: RuntimeKind): AppConfig {
  const defaults = RUNTIME_DEFAULTS[runtime];
  const node = runtime === 'node';
  const warnings: string[] = [];
  /** A count where 0 means no limit. */
  const limit = (name: string, fallback: number) => readInt(vars, name, fallback, Number.MAX_SAFE_INTEGER, 0);

  const url = readPublicUrl(vars, runtime);
  const publicUrl = url?.origin ?? null;
  const instanceName = readName(vars, 'INSTANCE_NAME', APP_NAME);
  const mail = mailConfig(vars, runtime, url, instanceName);
  // Links in the logs are for development on this machine; anything else (a public origin, a proxy without
  // PUBLIC_URL, workers.dev) is warned about. Other transports print no message, links or not.
  const localOnly = runtime === 'node' && url !== null && isLoopbackHost(url.hostname);
  if (mail.logBodies && mail.transport === 'log' && !localOnly) warnings.push(MAIL_LOG_BODIES_WARNING);

  let signupPolicy = readChoice(vars, 'SIGNUP_POLICY', SIGNUP_POLICIES, 'invite_only');
  // Sign-up links need a transport that delivers mail, or MAIL_LOG_BODIES's log (development).
  if (signupPolicy === 'open' && mail.transport === 'log' && !mail.logBodies) {
    warnings.push(SIGNUP_SEED_WARNING);
    signupPolicy = 'invite_only';
  }

  const recoveryToken = readText(vars, 'RECOVERY_TOKEN') ?? null;
  if (recoveryToken !== null && recoveryToken.length < RECOVERY_TOKEN_MIN_LENGTH) {
    const message = `RECOVERY_TOKEN is too short: it needs at least ${RECOVERY_TOKEN_MIN_LENGTH} characters`;
    throw new ConfigError('RECOVERY_TOKEN', message);
  }

  const bodyLimit = readInt(vars, 'BODY_LIMIT', 2 * MIB);
  const importBodyLimit = readInt(vars, 'IMPORT_BODY_LIMIT', defaults.importBodyLimit);
  const importMaxRowWrites = limit('IMPORT_MAX_ROW_WRITES', defaults.importMaxRowWrites);
  const reauthMinutes = readInt(vars, 'REAUTH_MINUTES', 10, 24 * 60);

  const directory: DirectoryConfig = {
    instanceName,
    publicUrl,
    setupToken: readText(vars, 'SETUP_TOKEN') ?? null,
    setupCodeDisabled: false,
    bodyLimit,
    recoveryToken,
    seed: {
      signupPolicy,
      passwordMinLength: readInt(vars, 'PASSWORD_MIN_LENGTH', defaults.passwordMinLength, 64, 8),
    },
    passwordKdf: readChoice(vars, 'PASSWORD_KDF', PASSWORD_KDFS, 'scrypt'),
    passwordScryptP: readInt(vars, 'PASSWORD_SCRYPT_P', defaults.passwordScryptP, 8),
    // Browsers cap cookie Max-Age at 400 days.
    sessionTtlDays: readInt(vars, 'SESSION_TTL_DAYS', 30, 400),
    sessionMaxDays: readInt(vars, 'SESSION_MAX_DAYS', defaults.sessionMaxDays, 36_500, 0),
    reauthMinutes,
    invitationTtlDays: readInt(vars, 'INVITATION_TTL_DAYS', 7, 365),
    spaceDeleteGraceDays: readInt(vars, 'SPACE_DELETE_GRACE_DAYS', 7, 365, 0),
    passkeys: passkeyConfig(vars, url, instanceName),
    mail,
    quotas: {
      maxSpacesPerUser: limit('MAX_SPACES_PER_USER', defaults.maxSpacesPerUser),
      spacesCreatedPerDay: limit('SPACES_CREATED_PER_DAY', defaults.spacesCreatedPerDay),
      maxMembersPerSpace: limit('MAX_MEMBERS_PER_SPACE', defaults.maxMembersPerSpace),
      maxOpenInvitationsPerSpace: limit('MAX_OPEN_INVITATIONS_PER_SPACE', 50),
      invitationsPerDay: limit('INVITATIONS_PER_DAY', 20),
      importMaxBytes: importBodyLimit,
      importMaxRowWrites,
      importDailyRowWrites: limit('IMPORT_DAILY_ROW_WRITES', defaults.importDailyRowWrites),
    },
    warnings,
  };

  const space: SpaceAppConfig = {
    bodyLimit,
    importBodyLimit,
    importMaxJsonValues: readInt(vars, 'IMPORT_MAX_JSON_VALUES', defaults.importMaxJsonValues),
    importMaxRowWrites,
    spaceDailyRowWrites: limit('SPACE_DAILY_ROW_WRITES', defaults.spaceDailyRowWrites),
    spaceMaxBytes: limit('SPACE_MAX_BYTES', defaults.spaceMaxBytes),
    // Node-only and Cloudflare-only variables are not read on the other runtime (Appendix B: n/a).
    snapshotKeep: node ? readInt(vars, 'SNAPSHOT_KEEP', DEFAULT_SNAPSHOT_KEEP, 100_000, 0) : DEFAULT_SNAPSHOT_KEEP,
    authCacheSeconds: node ? 0 : readInt(vars, 'AUTH_CACHE_SECONDS', defaults.authCacheSeconds, 300, 0),
    reauthMinutes,
  };

  return {
    runtime,
    publicUrl,
    logRequests: readBool(vars, 'LOG_REQUESTS', false),
    bodyLimit,
    importBodyLimit,
    directory,
    space,
  };
}
