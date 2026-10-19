// The configuration both runtimes share (core/config.ts): defaults per runtime, the rules for every
// variable, and the derived passkey, mail and seed values. Then the Node configuration built on it
// (config.ts).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, DEFAULT_SNAPSHOT_KEEP, MAIL_LOG_BODIES_WARNING, parseAppConfig, type ConfigVars, type RuntimeKind } from '../src/core/config';
import { loadConfig } from '../src/config';

const MIB = 1024 * 1024;
const parse = (vars: ConfigVars, runtime: RuntimeKind = 'node') => parseAppConfig(vars, runtime);

/** The ConfigError that parsing `vars` throws. */
function failure(vars: ConfigVars, runtime: RuntimeKind = 'node'): ConfigError {
  try {
    parse(vars, runtime);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

const SMTP: ConfigVars = {
  MAIL_TRANSPORT: 'smtp',
  MAIL_FROM: 'Plan@Example.COM',
  PUBLIC_URL: 'https://plan.example.com',
  SMTP_HOST: 'smtp.example.com',
};

describe('parseAppConfig: defaults (Appendix B)', () => {
  it('Node: no quotas, today\'s limits', () => {
    const c = parse({});
    expect(c).toMatchObject({ runtime: 'node', publicUrl: null, logRequests: false, bodyLimit: 2 * MIB, importBodyLimit: 50 * MIB });
    expect(c.directory).toEqual({
      instanceName: 'Lyren Plan',
      publicUrl: null,
      setupToken: null,
      setupCodeDisabled: false,
      bodyLimit: 2 * MIB,
      recoveryToken: null,
      seed: { signupPolicy: 'invite_only', passwordMinLength: 8 },
      passwordKdf: 'scrypt',
      passwordScryptP: 5,
      sessionTtlDays: 30,
      sessionMaxDays: 0,
      reauthMinutes: 10,
      invitationTtlDays: 7,
      spaceDeleteGraceDays: 7,
      passkeys: { enabled: false, rpId: null, origin: null, rpName: 'Lyren Plan', disabledReason: 'PUBLIC_URL is not set' },
      mail: { transport: 'log', from: null, replyTo: null, dailyCap: 200, logBodies: false, smtp: null, resendApiKey: null },
      quotas: {
        maxSpacesPerUser: 0,
        spacesCreatedPerDay: 0,
        maxMembersPerSpace: 0,
        maxOpenInvitationsPerSpace: 50,
        invitationsPerDay: 20,
        importMaxBytes: 50 * MIB,
        importMaxRowWrites: 0,
        importDailyRowWrites: 0,
      },
      warnings: [],
    });
    expect(c.space).toEqual({
      bodyLimit: 2 * MIB,
      importBodyLimit: 50 * MIB,
      importMaxJsonValues: 1_000_000,
      importMaxRowWrites: 0,
      spaceDailyRowWrites: 0,
      spaceMaxBytes: 0,
      snapshotKeep: DEFAULT_SNAPSHOT_KEEP,
      authCacheSeconds: 0,
      reauthMinutes: 10,
    });
    expect(DEFAULT_SNAPSHOT_KEEP).toBe(10);
  });

  it('Cloudflare: the free plan\'s limits', () => {
    const c = parse({}, 'cloudflare');
    expect(c).toMatchObject({ runtime: 'cloudflare', bodyLimit: 2 * MIB, importBodyLimit: 4 * MIB });
    expect(c.directory).toMatchObject({
      seed: { signupPolicy: 'invite_only', passwordMinLength: 12 },
      passwordKdf: 'scrypt',
      passwordScryptP: 1,
      sessionTtlDays: 30,
      sessionMaxDays: 90,
      quotas: {
        maxSpacesPerUser: 5,
        spacesCreatedPerDay: 10,
        maxMembersPerSpace: 20,
        maxOpenInvitationsPerSpace: 50,
        invitationsPerDay: 20,
        importMaxBytes: 4 * MIB,
        importMaxRowWrites: 50_000,
        importDailyRowWrites: 60_000,
      },
    });
    expect(c.space).toEqual({
      bodyLimit: 2 * MIB,
      importBodyLimit: 4 * MIB,
      importMaxJsonValues: 300_000,
      importMaxRowWrites: 50_000,
      spaceDailyRowWrites: 20_000,
      spaceMaxBytes: 209_715_200,
      snapshotKeep: DEFAULT_SNAPSHOT_KEEP,
      authCacheSeconds: 30,
      reauthMinutes: 10,
    });
  });

  it('reads every value it takes over the default', () => {
    const c = parse(
      {
        INSTANCE_NAME: ' Acme Plan ',
        SETUP_TOKEN: ' code ',
        RECOVERY_TOKEN: 'r'.repeat(32),
        SIGNUP_POLICY: 'Closed',
        PASSWORD_MIN_LENGTH: '14',
        PASSWORD_KDF: 'pbkdf2',
        PASSWORD_SCRYPT_P: '2',
        SESSION_TTL_DAYS: '14',
        SESSION_MAX_DAYS: '60',
        REAUTH_MINUTES: '5',
        INVITATION_TTL_DAYS: '3',
        SPACE_DELETE_GRACE_DAYS: '0',
        LOG_REQUESTS: 'yes',
        BODY_LIMIT: '1000',
        IMPORT_BODY_LIMIT: '2000',
        IMPORT_MAX_JSON_VALUES: '3000',
        IMPORT_MAX_ROW_WRITES: '4000',
        IMPORT_DAILY_ROW_WRITES: '5000',
        SPACE_DAILY_ROW_WRITES: '6000',
        SPACE_MAX_BYTES: '7000',
        MAX_SPACES_PER_USER: '1',
        SPACES_CREATED_PER_DAY: '2',
        MAX_MEMBERS_PER_SPACE: '3',
        MAX_OPEN_INVITATIONS_PER_SPACE: '4',
        INVITATIONS_PER_DAY: '5',
        MAIL_DAILY_CAP: '90',
        SNAPSHOT_KEEP: '0',
      },
      'node',
    );
    expect(c).toMatchObject({ logRequests: true, bodyLimit: 1000, importBodyLimit: 2000 });
    expect(c.directory).toMatchObject({
      instanceName: 'Acme Plan',
      setupToken: 'code',
      recoveryToken: 'r'.repeat(32),
      seed: { signupPolicy: 'closed', passwordMinLength: 14 },
      passwordKdf: 'pbkdf2',
      passwordScryptP: 2,
      sessionTtlDays: 14,
      sessionMaxDays: 60,
      reauthMinutes: 5,
      invitationTtlDays: 3,
      spaceDeleteGraceDays: 0,
      passkeys: { rpName: 'Acme Plan' },
      mail: { dailyCap: 90 },
      quotas: {
        maxSpacesPerUser: 1,
        spacesCreatedPerDay: 2,
        maxMembersPerSpace: 3,
        maxOpenInvitationsPerSpace: 4,
        invitationsPerDay: 5,
        importMaxBytes: 2000,
        importMaxRowWrites: 4000,
        importDailyRowWrites: 5000,
      },
    });
    expect(c.space).toEqual({
      bodyLimit: 1000,
      importBodyLimit: 2000,
      importMaxJsonValues: 3000,
      importMaxRowWrites: 4000,
      spaceDailyRowWrites: 6000,
      spaceMaxBytes: 7000,
      snapshotKeep: 0,
      authCacheSeconds: 0,
      reauthMinutes: 5,
    });
  });

  it('reads Node-only variables only on Node and Cloudflare-only ones only on Cloudflare', () => {
    expect(parse({ SNAPSHOT_KEEP: 'x' }, 'cloudflare').space.snapshotKeep).toBe(DEFAULT_SNAPSHOT_KEEP);
    expect(parse({ AUTH_CACHE_SECONDS: 'x' }, 'node').space.authCacheSeconds).toBe(0);
    expect(parse({ AUTH_CACHE_SECONDS: '0' }, 'cloudflare').space.authCacheSeconds).toBe(0);
    expect(failure({ AUTH_CACHE_SECONDS: '301' }, 'cloudflare').variable).toBe('AUTH_CACHE_SECONDS');
  });
});

describe('parseAppConfig: the rules for every variable', () => {
  it('takes an empty value, or one of spaces, for unset', () => {
    const empty: Record<string, string> = {};
    for (const name of [
      'PUBLIC_URL', 'WEBAUTHN_RP_ID', 'INSTANCE_NAME', 'SETUP_TOKEN', 'RECOVERY_TOKEN', 'SIGNUP_POLICY', 'PASSWORD_MIN_LENGTH',
      'PASSWORD_KDF', 'PASSWORD_SCRYPT_P', 'SESSION_TTL_DAYS', 'SESSION_MAX_DAYS', 'MAIL_TRANSPORT', 'MAIL_FROM',
      'MAIL_FROM_NAME', 'MAIL_REPLY_TO', 'MAIL_DAILY_CAP', 'MAIL_LOG_BODIES', 'BODY_LIMIT', 'IMPORT_BODY_LIMIT',
      'MAX_SPACES_PER_USER', 'SPACE_MAX_BYTES', 'AUTH_CACHE_SECONDS', 'LOG_REQUESTS',
    ]) {
      empty[name] = name.length % 2 === 0 ? '' : '  ';
    }
    expect(parse(empty, 'cloudflare')).toEqual(parse({}, 'cloudflare'));
    expect(parse(empty, 'node')).toEqual(parse({}, 'node'));
  });

  it('refuses invalid numbers, naming the variable and the range, as the Node config always did', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['SESSION_TTL_DAYS', '401', /^Invalid value for SESSION_TTL_DAYS: 401 \(expected 1\.\.400\)$/],
      ['BODY_LIMIT', '1.5', /BODY_LIMIT: 1\.5/],
      ['IMPORT_MAX_ROW_WRITES', '-1', /expected 0\.\./],
      ['PASSWORD_MIN_LENGTH', '7', /expected 8\.\.64/],
      ['PASSWORD_MIN_LENGTH', '65', /expected 8\.\.64/],
      ['PASSWORD_SCRYPT_P', '9', /expected 1\.\.8/],
      ['REAUTH_MINUTES', '0', /REAUTH_MINUTES/],
      ['MAIL_DAILY_CAP', 'lots', /MAIL_DAILY_CAP: lots/],
      ['SNAPSHOT_KEEP', '-1', /SNAPSHOT_KEEP/],
    ];
    for (const [name, value, message] of cases) {
      const err = failure({ [name]: value });
      expect(err.variable, name).toBe(name);
      expect(err.message).toMatch(message);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('refuses unknown choices, and takes known ones in any case', () => {
    expect(failure({ SIGNUP_POLICY: 'everyone' }).message).toBe(
      'Invalid value for SIGNUP_POLICY: everyone (expected open, invite_only, closed)',
    );
    expect(failure({ PASSWORD_KDF: 'argon2' }).variable).toBe('PASSWORD_KDF');
    expect(failure({ MAIL_TRANSPORT: 'sendmail' }).variable).toBe('MAIL_TRANSPORT');
    expect(parse({ PASSWORD_KDF: 'PBKDF2' }).directory.passwordKdf).toBe('pbkdf2');
  });

  it('refuses names with line breaks or over 100 characters', () => {
    expect(failure({ INSTANCE_NAME: 'Plan\nBcc: x@example.com' }).variable).toBe('INSTANCE_NAME');
    expect(failure({ MAIL_FROM_NAME: 'x'.repeat(101) }).variable).toBe('MAIL_FROM_NAME');
  });

  it('RECOVERY_TOKEN needs at least 32 characters, and the error does not repeat it', () => {
    const err = failure({ RECOVERY_TOKEN: 'short-secret' });
    expect(err.variable).toBe('RECOVERY_TOKEN');
    expect(err.message).toBe('RECOVERY_TOKEN is too short: it needs at least 32 characters');
    expect(err.message).not.toContain('short-secret');
  });

  it('booleans are true for 1, true, yes and on only', () => {
    for (const v of ['1', 'true', 'YES', 'On']) expect(parse({ LOG_REQUESTS: v }).logRequests, v).toBe(true);
    for (const v of ['0', 'false', 'no', 'off', 'enabled']) expect(parse({ LOG_REQUESTS: v }).logRequests, v).toBe(false);
  });
});

describe('parseAppConfig: PUBLIC_URL and passkeys (§5.6)', () => {
  it('takes an http(s) origin and keeps only the origin', () => {
    expect(parse({ PUBLIC_URL: 'https://Plan.Example.com/' }).publicUrl).toBe('https://plan.example.com');
    expect(parse({ PUBLIC_URL: 'https://plan.example.com:8443' }).directory.publicUrl).toBe('https://plan.example.com:8443');
    expect(parse({ PUBLIC_URL: 'https://bücher.example' }).publicUrl).toBe('https://xn--bcher-kva.example');
    for (const v of ['plan.example.com', 'ftp://plan.example.com', 'https://plan.example.com/app', 'https://plan.example.com/?x=1',
      'https://plan.example.com/#top', 'https://user:pass@plan.example.com', 'https://plan.example.com/?', 'https://']) {
      const err = failure({ PUBLIC_URL: v });
      expect(err.variable, v).toBe('PUBLIC_URL');
      expect(err.message).toBe(`Invalid value for PUBLIC_URL: ${v} (expected an origin such as https://plan.example.com)`);
    }
  });

  it('on Cloudflare only an https origin, or http on this machine (wrangler dev); Node takes either', () => {
    for (const v of ['http://localhost:8787', 'http://127.0.0.1:8790', 'http://[::1]:8787', 'https://plan.example.com']) {
      expect(parse({ PUBLIC_URL: v }, 'cloudflare').publicUrl, v).toBe(new URL(v).origin);
    }
    for (const v of ['http://plan.example.com', 'http://192.168.1.10:8787', 'http://localhost.example.com']) {
      expect(failure({ PUBLIC_URL: v }, 'cloudflare')).toMatchObject({
        variable: 'PUBLIC_URL',
        message: `Invalid value for PUBLIC_URL: ${v} (expected an https origin such as https://plan.example.com; http only for localhost under wrangler dev)`,
      });
      expect(parse({ PUBLIC_URL: v }).publicUrl).toBe(v);
    }
  });

  it('turns passkeys on for an https host name, with its host as the RP ID', () => {
    expect(parse({ PUBLIC_URL: 'https://plan.example.com', INSTANCE_NAME: 'Acme' }).directory.passkeys).toEqual({
      enabled: true,
      rpId: 'plan.example.com',
      origin: 'https://plan.example.com',
      rpName: 'Acme',
      disabledReason: null,
    });
    expect(parse({ PUBLIC_URL: 'http://localhost:5173' }).directory.passkeys).toMatchObject({
      enabled: true,
      rpId: 'localhost',
      origin: 'http://localhost:5173',
    });
  });

  it('keeps passkeys off without a usable PUBLIC_URL, and says why', () => {
    const reason = (url: string | undefined) => parse({ PUBLIC_URL: url }).directory.passkeys;
    expect(reason(undefined)).toMatchObject({ enabled: false, rpId: null, origin: null, disabledReason: 'PUBLIC_URL is not set' });
    expect(reason('http://plan.example.com')).toMatchObject({ enabled: false, disabledReason: 'PUBLIC_URL is not an https origin (or http://localhost)' });
    for (const url of ['https://192.168.1.10', 'https://[::1]:8443', 'http://127.0.0.1:8080']) {
      expect(reason(url), url).toMatchObject({ enabled: false });
    }
    expect(reason('https://192.168.1.10').disabledReason).toBe('PUBLIC_URL is an IP address, not a host name');
  });

  it('WEBAUTHN_RP_ID: the host or a parent domain with at least two labels, not a public suffix', () => {
    const rpId = (value: string, url = 'https://plan.eu.example.com') => parse({ PUBLIC_URL: url, WEBAUTHN_RP_ID: value }).directory.passkeys.rpId;
    expect(rpId('plan.eu.example.com')).toBe('plan.eu.example.com');
    expect(rpId('eu.example.com')).toBe('eu.example.com');
    expect(rpId('Example.COM')).toBe('example.com');
    expect(rpId('bücher.example', 'https://plan.xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    for (const [value, url] of [
      ['com', 'https://plan.eu.example.com'],
      ['other.example.com', 'https://plan.eu.example.com'],
      ['ample.com', 'https://plan.example.com'],
      ['plan.example.com.evil.test', 'https://plan.example.com'],
      ['workers.dev', 'https://lyren-plan.example.workers.dev'],
      ['pages.dev', 'https://lyren-plan.example.pages.dev'],
      ['example.com/x', 'https://plan.example.com'],
      ['ex%61mple.com', 'https://plan.example.com'],
    ] as const) {
      const err = failure({ PUBLIC_URL: url, WEBAUTHN_RP_ID: value });
      expect(err.variable, value).toBe('WEBAUTHN_RP_ID');
      expect(err.message).toMatch(/^Invalid value for WEBAUTHN_RP_ID/);
    }
    expect(rpId('example.workers.dev', 'https://lyren-plan.example.workers.dev')).toBe('example.workers.dev');
  });

  it('WEBAUTHN_RP_ID without a PUBLIC_URL that allows passkeys is a configuration error', () => {
    expect(failure({ WEBAUTHN_RP_ID: 'example.com' }).message).toBe('WEBAUTHN_RP_ID is set, but passkeys are off: PUBLIC_URL is not set');
    expect(failure({ WEBAUTHN_RP_ID: 'example.com', PUBLIC_URL: 'http://plan.example.com' }).variable).toBe('WEBAUTHN_RP_ID');
  });
});

describe('parseAppConfig: mail (§5.10.1)', () => {
  it('log: MAIL_FROM optional, but valid when given', () => {
    expect(parse({ MAIL_FROM: 'plan@example.com', MAIL_FROM_NAME: 'Acme' }).directory.mail.from).toEqual({ address: 'plan@example.com', name: 'Acme' });
    expect(failure({ MAIL_FROM: 'not-an-address' }).message).toBe('Invalid value for MAIL_FROM: not-an-address (expected an email address)');
    expect(failure({ MAIL_REPLY_TO: 'a@localhost' }).variable).toBe('MAIL_REPLY_TO');
  });

  it('smtp: needs MAIL_FROM, PUBLIC_URL and SMTP_HOST; the port follows SMTP_SECURITY', () => {
    expect(parse(SMTP).directory.mail).toEqual({
      transport: 'smtp',
      from: { address: 'Plan@example.com', name: 'Lyren Plan' },
      replyTo: null,
      dailyCap: 200,
      logBodies: false,
      smtp: { host: 'smtp.example.com', port: 465, security: 'tls', user: null, pass: null, ehloName: 'plan.example.com' },
      resendApiKey: null,
    });
    expect(parse({ ...SMTP, SMTP_SECURITY: 'STARTTLS' }).directory.mail.smtp).toMatchObject({ port: 587, security: 'starttls' });
    expect(parse({ ...SMTP, SMTP_PORT: '2525', SMTP_EHLO_NAME: 'mx.example.com' }).directory.mail.smtp).toMatchObject({
      port: 2525,
      ehloName: 'mx.example.com',
    });
    expect(failure({ ...SMTP, MAIL_FROM: undefined }).message).toBe('MAIL_FROM is required with MAIL_TRANSPORT=smtp');
    expect(failure({ ...SMTP, PUBLIC_URL: '' }).message).toBe('PUBLIC_URL is required with MAIL_TRANSPORT=smtp (mail contains links)');
    expect(failure({ ...SMTP, SMTP_HOST: '' }).variable).toBe('SMTP_HOST');
    expect(failure({ ...SMTP, SMTP_HOST: 'smtp.example.com:587' }).variable).toBe('SMTP_HOST');
    expect(failure({ ...SMTP, SMTP_SECURITY: 'none' }).variable).toBe('SMTP_SECURITY');
    expect(failure({ ...SMTP, SMTP_PORT: '0' }).variable).toBe('SMTP_PORT');
  });

  it('smtp: SMTP_USER and SMTP_PASS go together, and the password is kept exactly', () => {
    expect(parse({ ...SMTP, SMTP_USER: 'plan', SMTP_PASS: ' p@ss ' }).directory.mail.smtp).toMatchObject({ user: 'plan', pass: ' p@ss ' });
    const missingPass = failure({ ...SMTP, SMTP_USER: 'plan' });
    expect(missingPass.variable).toBe('SMTP_PASS');
    const missingUser = failure({ ...SMTP, SMTP_PASS: 'secret-value' });
    expect(missingUser.variable).toBe('SMTP_USER');
    expect(missingUser.message).not.toContain('secret-value');
  });

  it('smtp: an EHLO address literal for an IP PUBLIC_URL; port 25 is refused on Cloudflare', () => {
    expect(parse({ ...SMTP, PUBLIC_URL: 'http://192.168.1.10:8080' }).directory.mail.smtp!.ehloName).toBe('[192.168.1.10]');
    expect(parse({ ...SMTP, PUBLIC_URL: 'http://[fd00::1]:8080' }).directory.mail.smtp!.ehloName).toBe('[IPv6:fd00::1]');
    expect(parse({ ...SMTP, SMTP_PORT: '25' }, 'node').directory.mail.smtp!.port).toBe(25);
    expect(failure({ ...SMTP, SMTP_PORT: '25' }, 'cloudflare')).toMatchObject({
      variable: 'SMTP_PORT',
      message: 'SMTP_PORT=25 is blocked on Cloudflare Workers (use 465 or 587)',
    });
  });

  it('smtp: SMTP_SECURITY=none only to a mail server on this machine, without credentials (port 25 by default)', () => {
    const local = { ...SMTP, SMTP_SECURITY: 'none', SMTP_HOST: 'localhost' };
    expect(parse(local).directory.mail.smtp).toMatchObject({ host: 'localhost', port: 25, security: 'none', user: null });
    for (const host of ['127.0.0.1', '127.1.2.3', '[::1]', 'LOCALHOST']) expect(parse({ ...local, SMTP_HOST: host }).directory.mail.smtp!.security).toBe('none');
    expect(parse({ ...local, SMTP_PORT: '1025' }, 'cloudflare').directory.mail.smtp).toMatchObject({ port: 1025, security: 'none' });
    // On Cloudflare the default port is what to change (wrangler dev and a local mail catcher).
    expect(failure(local, 'cloudflare')).toMatchObject({
      variable: 'SMTP_PORT',
      message: "SMTP_SECURITY=none uses port 25 by default, which is blocked on Cloudflare Workers: set SMTP_PORT to your mail catcher's port",
    });
    for (const host of ['smtp.example.com', '192.168.1.10', '[fd00::1]', 'localhost.example.com']) {
      const remote = failure({ ...local, SMTP_HOST: host });
      expect(remote.variable).toBe('SMTP_SECURITY');
      expect(remote.message).toBe(
        'SMTP_SECURITY=none is only for a mail server on this machine (SMTP_HOST localhost, 127.0.0.1 or [::1]); use tls or starttls',
      );
    }
    const withUser = failure({ ...local, SMTP_USER: 'plan', SMTP_PASS: 'secret-value' });
    expect(withUser.variable).toBe('SMTP_SECURITY');
    expect(withUser.message).toBe('SMTP_SECURITY=none sends no credentials: unset SMTP_USER and SMTP_PASS, or use tls or starttls');
    expect(withUser.message).not.toContain('secret-value');
  });

  it('the MAIL_LOG_BODIES warning is exported for the admin overview', () => {
    expect(parse({ MAIL_LOG_BODIES: 'on', PUBLIC_URL: 'https://plan.example.com' }).directory.warnings).toEqual([MAIL_LOG_BODIES_WARNING]);
  });

  it('resend needs RESEND_API_KEY; cloudflare only works on Cloudflare', () => {
    const resend = { MAIL_TRANSPORT: 'resend', MAIL_FROM: 'plan@example.com', PUBLIC_URL: 'https://plan.example.com' };
    expect(parse({ ...resend, RESEND_API_KEY: ' re_123 ' }, 'cloudflare').directory.mail).toMatchObject({ transport: 'resend', resendApiKey: 're_123' });
    expect(failure(resend).message).toBe('RESEND_API_KEY is required with MAIL_TRANSPORT=resend');
    const cf = { ...resend, MAIL_TRANSPORT: 'cloudflare' };
    expect(parse(cf, 'cloudflare').directory.mail).toMatchObject({ transport: 'cloudflare', smtp: null, resendApiKey: null });
    expect(failure(cf, 'node').variable).toBe('MAIL_TRANSPORT');
  });
});

describe('parseAppConfig: seeds and warnings', () => {
  it('SIGNUP_POLICY=open needs a transport that delivers mail: with log it is seeded invite_only', () => {
    const log = parse({ SIGNUP_POLICY: 'open' }).directory;
    expect(log.seed.signupPolicy).toBe('invite_only');
    expect(log.warnings).toEqual(['SIGNUP_POLICY=open needs a mail transport (MAIL_TRANSPORT); using invite_only']);
    const smtp = parse({ ...SMTP, SIGNUP_POLICY: 'open' }).directory;
    expect(smtp.seed.signupPolicy).toBe('open');
    expect(smtp.warnings).toEqual([]);
    // Development: MAIL_LOG_BODIES writes the sign-up links to the log (only its own warning).
    const dev = parse({ SIGNUP_POLICY: 'open', MAIL_LOG_BODIES: '1', PUBLIC_URL: 'http://localhost:8080' }).directory;
    expect(dev.seed.signupPolicy).toBe('open');
    expect(dev.warnings).toEqual([]);
  });

  it('warns about MAIL_LOG_BODIES with the log transport, unless PUBLIC_URL is on this machine (Node)', () => {
    const warned = ['MAIL_LOG_BODIES is on: sign-in links are written to the logs'];
    expect(parse({ MAIL_LOG_BODIES: '1', PUBLIC_URL: 'https://plan.example.com' }).directory.warnings).toEqual(warned);
    expect(parse({ MAIL_LOG_BODIES: '1', PUBLIC_URL: 'http://plan.example.com' }).directory.warnings).toEqual(warned);
    expect(parse({ MAIL_LOG_BODIES: '1', PUBLIC_URL: 'http://192.168.1.20:8080' }).directory.warnings).toEqual(warned);
    // Behind a proxy without PUBLIC_URL, and on Cloudflare (workers.dev without PUBLIC_URL, or any other).
    expect(parse({ MAIL_LOG_BODIES: '1' }).directory).toMatchObject({ warnings: warned, mail: { logBodies: true } });
    expect(parse({ MAIL_LOG_BODIES: '1' }, 'cloudflare').directory.warnings).toEqual(warned);
    expect(parse({ MAIL_LOG_BODIES: '1', PUBLIC_URL: 'http://localhost:8787' }, 'cloudflare').directory.warnings).toEqual(warned);
    for (const origin of ['http://localhost:8787', 'http://127.0.0.1:19800', 'http://[::1]:19800']) {
      expect(parse({ MAIL_LOG_BODIES: '1', PUBLIC_URL: origin }).directory.warnings).toEqual([]);
    }
    // Another transport prints no message at all.
    expect(parse({ ...SMTP, MAIL_LOG_BODIES: '1' }).directory.warnings).toEqual([]);
  });
});

describe('loadConfig (Node)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('adds the Node-only settings to the shared configuration', () => {
    vi.stubEnv('PUBLIC_URL', 'https://plan.example.com');
    vi.stubEnv('SPACES_OPEN_MAX', '8');
    vi.stubEnv('ALLOW_ADMIN_BACKUP_DOWNLOAD', 'false');
    vi.stubEnv('SESSION_TTL_DAYS', '12');
    const c = loadConfig({ dbPath: ':memory:' });
    expect(c).toMatchObject({ runtime: 'node', publicUrl: 'https://plan.example.com', spacesOpenMax: 8, allowAdminBackupDownload: false, sessionTtlDays: 12 });
    expect(c.directory.sessionTtlDays).toBe(12);
    expect(c.directory.passkeys.enabled).toBe(true);
    vi.stubEnv('SPACES_OPEN_MAX', '');
    vi.stubEnv('ALLOW_ADMIN_BACKUP_DOWNLOAD', '');
    expect(loadConfig()).toMatchObject({ spacesOpenMax: 32, allowAdminBackupDownload: true });
  });

  it('keeps overrides of the flat fields and the sub-objects in step', () => {
    const c = loadConfig({ bodyLimit: 4096, importBodyLimit: 16384, sessionTtlDays: 2, snapshotKeep: 3, setupToken: 'abc' });
    expect(c).toMatchObject({ bodyLimit: 4096, importBodyLimit: 16384, sessionTtlDays: 2, snapshotKeep: 3, setupToken: 'abc' });
    expect(c.space).toMatchObject({ bodyLimit: 4096, importBodyLimit: 16384, snapshotKeep: 3 });
    expect(c.directory).toMatchObject({ sessionTtlDays: 2, setupToken: 'abc', bodyLimit: 4096, quotas: { importMaxBytes: 16384 } });
    // A sub-object given whole is kept, unless a flat field is overridden as well.
    const base = loadConfig();
    const d = loadConfig({ directory: { ...base.directory, reauthMinutes: 1 } });
    expect(d.directory.reauthMinutes).toBe(1);
    expect(loadConfig().directory.reauthMinutes).toBe(10);
  });

  it('throws a ConfigError naming the variable (cli.ts exits with code 2)', () => {
    vi.stubEnv('PORT', '70000');
    expect(() => loadConfig()).toThrow(/^Invalid value for PORT: 70000 \(expected 1\.\.65535\)$/);
    vi.stubEnv('PORT', '');
    vi.stubEnv('MAIL_TRANSPORT', 'smtp');
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});
