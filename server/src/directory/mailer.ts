// The directory's mailer (design §5.10.5): one function per message, and the sending policy. The
// messages themselves are mail/templates.ts.
//
// - Invitations are sent at once, and the caller learns the outcome (§5.8.8: the inviter gets a 503 and
//   the invitation is removed again when it was not sent). So is the admin's test message (§7.2).
//   Everything else is deferred (DirectoryDeps.defer: ctx.waitUntil in DirectoryDO, a logged promise on
//   Node), so how long a request takes never depends on whether an account exists, and a failure never
//   reaches the request's answer: it is logged and recorded as a mail_failed security event.
// - Budgets, checked and counted before a message is handed to a transport that delivers mail (§5.9;
//   exact throttle rows): mail:<UTC day> for every message (MAIL_DAILY_CAP); ma:<UTC day>, 40% of the cap,
//   for messages caused by anonymous requests (signup_verify, signup_existing, password_reset from the
//   forgot form, login_attempts after failed sign-ins), so anonymous traffic cannot use up what
//   invitations, verifications and the other notices need; mr:<email_key>, 5 a day, for every message but
//   the security notices, so no address can be flooded. A message over a budget is dropped with a log line
//   and a mail_failed event (reason 'cap'). The log transport sends nothing, so it counts nothing. A forgot
//   request for an address without an active account counts what its password_reset would have (§13.6:
//   the budgets must not tell whether the address has an account).
// - mail_failed is the recipient's account's event: none for an invitation, a sign-up or an email change
//   (the new address is not the requester's yet, and the template would tell the requester whether
//   another account has it, §13.6).
// - The security notices go to an account's verified address only.
// - Messages are written when the function is called (the request's own data), and sent later.

import type { InvitableRole } from '@shared/roles';
import type { DirectoryConfig, MailConfig } from '../core/config';
import type { Db } from '../core/db';
import { normalizeEmail } from '../core/email';
import type { TrustedMeta } from '../core/ports';
import type { Defer } from '../core/runtime';
import { redact } from '../mail/errors';
import {
  renderMail,
  SECURITY_NOTICES,
  type AccountLabel,
  type Grant,
  type MailTemplate,
  type TemplateParams,
} from '../mail/templates';
import type { MailTransport } from '../mail/transport';
import { recordEvent } from './security';
import type { Throttle, ThrottlePolicy } from './throttle';
import type { UserRow } from './users';

/**
 * The account a message goes to: its address is the recipient, and an account without one gets nothing.
 * The security notices go only to a verified address (it might belong to someone else otherwise).
 */
export type MailUser = Pick<UserRow, 'id' | 'email' | 'email_verified_at' | 'display_name' | 'username'>;

/** How a message sent at once went. `message` is safe to show an instance admin (no secrets). */
export type SendResult =
  | { sent: true; messageId: string | null }
  | { sent: false; reason: 'cap' | 'failed'; message: string };

export interface InvitationMail {
  /** The invited address (normalized). */
  to: string;
  token: string;
  /** The inviter, named by their verified address (§5.8.8 step 2). */
  inviter: { displayName: string; email: string };
  /** The space's name; null for an instance invitation. */
  spaceName: string | null;
  role: InvitableRole | null;
  expiresAt: string;
  meta: TrustedMeta | null;
}

/** Mailer.sendsTokens: the transport delivers mail, or MAIL_LOG_BODIES prints the messages (§5.10.2). */
export const sendsTokens = (transport: Pick<MailTransport, 'deliversMail'>, mail: Pick<MailConfig, 'logBodies'>): boolean =>
  transport.deliversMail || mail.logBodies;

export interface Mailer {
  /** The transport delivers mail (false with MAIL_TRANSPORT=log). */
  readonly deliversMail: boolean;
  /**
   * Whether the flows that only work by mail (forgot password, signup, verification, email change)
   * mint tokens: the transport delivers mail, or MAIL_LOG_BODIES prints the messages (§5.10.2).
   */
  readonly sendsTokens: boolean;
  /** The absolute address of an app page: PUBLIC_URL, else the first share origin, else the path alone. */
  link(path: string): string;

  // Deferred (§5.10.5). Each returns at once; a failure is logged and recorded, never thrown.
  signupVerify(o: { to: string; token: string; meta: TrustedMeta | null }): void;
  signupExisting(o: { user: MailUser; meta: TrustedMeta | null }): void;
  verifyEmail(o: { user: MailUser; token: string; meta: TrustedMeta | null }): void;
  /** `anonymous`: from the forgot form (counts on ma:<day>); `byAdmin`: an admin's mailed reset (§5.8.11). */
  passwordReset(o: { user: MailUser; token: string; anonymous: boolean; byAdmin?: boolean; meta: TrustedMeta | null }): void;
  /** The forgot form for an address without an active account: counts on the budgets a password_reset would, sends nothing. */
  passwordResetToNobody(o: { to: string }): void;
  passwordResetByAdmin(o: { user: MailUser; adminName: string; meta: TrustedMeta | null }): void;
  /** Lists the memberships, roles and invitations the account granted in the last 7 days. */
  passwordChanged(o: { user: MailUser; via: 'change' | 'reset'; meta: TrustedMeta | null }): void;
  /** To the new address; names the account that asked (`user`, with its current address). */
  emailChangeConfirm(o: { user: MailUser; to: string; token: string; meta: TrustedMeta | null }): void;
  emailChangeTaken(o: { user: MailUser; to: string; meta: TrustedMeta | null }): void;
  /** To the old address: `user` as it was before the change (its address, when verified). */
  emailChangedNotice(o: { user: MailUser; meta: TrustedMeta | null }): void;
  /** P6 sends it (§5.8.13, §5.8.9 step 4). */
  passkeyAdded(o: { user: MailUser; passkeyName: string; via: 'settings' | 'reset'; meta: TrustedMeta | null }): void;
  loginAttempts(o: { user: MailUser; meta: TrustedMeta | null }): void;
  recoveryUsed(o: { user: MailUser; madeAdmin: boolean; meta: TrustedMeta | null }): void;

  // At once.
  /** §5.8.8: within 10 s; on `sent: false` the caller removes the invitation and answers 503. */
  invitation(o: InvitationMail): Promise<SendResult>;
  /** POST /api/admin/mail/test: a test message to the admin's own address. */
  test(o: { user: MailUser; meta: TrustedMeta | null }): Promise<SendResult>;
}

export interface MailerDeps {
  db: Db;
  config: Pick<DirectoryConfig, 'instanceName' | 'publicUrl' | 'mail'>;
  throttle: Throttle;
  transport: MailTransport;
  defer: Defer;
  now(): number;
  shareOrigins(): string[];
}

const DAY_MS = 86_400_000;
/** §5.8.8: an invitation's mail is given 10 s. */
export const INVITATION_SEND_TIMEOUT_MS = 10_000;
/** mr:<email_key>: messages to one address a day (§5.9). */
export const RECIPIENT_DAILY_LIMIT = 5;
/** ma:<day>: the share of MAIL_DAILY_CAP for messages caused by anonymous requests. */
const ANONYMOUS_SHARE = 0.4;
/** password_changed lists at most this many grants. */
const GRANTS_LISTED = 20;

const exact = (name: string, limit: number): ThrottlePolicy => ({ name, limit, windowMs: DAY_MS, mode: 'block', storage: 'exact' });

/** The budgets (§5.9): mail:<day>, ma:<day> (0 when 40% of the cap rounds down to nothing) and mr:<email_key>. */
export function mailBudgets(dailyCap: number) {
  return {
    day: exact('mail', dailyCap),
    anonymous: exact('ma', Math.floor(dailyCap * ANONYMOUS_SHARE)),
    recipient: exact('mr', RECIPIENT_DAILY_LIMIT),
  };
}

/** A message ready to be handed to the transport. */
interface Prepared {
  template: MailTemplate;
  to: string;
  /** The account it is for, when known (the mail_failed event's user). */
  userId: number | null;
  /** Caused by an anonymous request: counts on ma:<day>. */
  anonymous: boolean;
  /** Not a template of §5.10.5 (the admin's test): mail:<day> only. */
  dayOnly?: boolean;
  subject: string;
  text: string;
  html: string;
  meta: TrustedMeta | null;
}

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);
const iso = (ms: number) => new Date(ms).toISOString();

const label = (user: MailUser): AccountLabel => ({ displayName: user.display_name, email: user.email, username: user.username });

export function createMailer(deps: MailerDeps): Mailer {
  const { db, config, throttle, transport } = deps;
  const budgets = mailBudgets(config.mail.dailyCap);
  const secrets = [config.mail.smtp?.pass, config.mail.resendApiKey];

  function link(path: string): string {
    return `${config.publicUrl ?? deps.shareOrigins()[0] ?? ''}${path}`;
  }

  function prepare<T extends MailTemplate>(
    template: T,
    params: TemplateParams[T],
    o: { to: string; userId: number | null; anonymous?: boolean; meta: TrustedMeta | null },
  ): Prepared {
    const rendered = renderMail(template, params, { instanceName: config.instanceName, link, now: deps.now() });
    return { template, to: o.to, userId: o.userId, anonymous: o.anonymous ?? false, meta: o.meta, ...rendered };
  }

  function failed(p: Prepared, reason: 'cap' | 'transport', detail: string, data: Record<string, unknown>): void {
    console.error(`[lyren] Mail not sent: ${p.template} to an address at ${domainOf(p.to)}: ${detail}`);
    try {
      recordEvent(db, { type: 'mail_failed', userId: p.userId, meta: p.meta, data: { template: p.template, reason, ...data }, nowMs: deps.now() });
    } catch (err) {
      console.error('[lyren] Could not record a mail_failed event:', err);
    }
  }

  /** The budgets of `p` (§5.9): the first one used up, or null after counting the message on all of them. */
  function spend(p: Pick<Prepared, 'template' | 'to' | 'anonymous' | 'dayOnly'>): { key: string; text: string } | null {
    const day = iso(deps.now()).slice(0, 10);
    const keys: Array<[string, ThrottlePolicy, string]> = [[`mail:${day}`, budgets.day, `the daily limit of ${config.mail.dailyCap} messages (MAIL_DAILY_CAP)`]];
    if (!p.dayOnly && p.anonymous) {
      keys.push([`ma:${day}`, budgets.anonymous, `the daily limit of ${budgets.anonymous.limit} messages caused by anonymous requests (40% of MAIL_DAILY_CAP)`]);
    }
    if (!p.dayOnly && !SECURITY_NOTICES.has(p.template)) {
      const email = normalizeEmail(p.to);
      keys.push([`mr:${email.ok ? email.key : p.to}`, budgets.recipient, `the daily limit of ${RECIPIENT_DAILY_LIMIT} messages to one address`]);
    }
    for (const [key, policy, text] of keys) {
      if (policy.limit === 0 || throttle.check(key, policy).blocked) return { key: key.slice(0, key.indexOf(':')), text };
    }
    for (const [key, policy] of keys) throttle.hit(key, policy);
    return null;
  }

  /** Hands `p` to the transport (after the budgets); never throws. */
  async function deliver(p: Prepared, timeoutMs?: number): Promise<SendResult> {
    if (transport.deliversMail) {
      const over = spend(p);
      if (over) {
        failed(p, 'cap', `${over.text} is used up`, { budget: over.key });
        return { sent: false, reason: 'cap', message: `Mail was not sent: ${over.text} is used up for today (UTC).` };
      }
    }
    try {
      const message = { to: p.to, subject: p.subject, text: p.text, html: p.html, template: p.template };
      const sending = transport.send(message, timeoutMs === undefined ? {} : { timeoutMs });
      const { messageId } = timeoutMs === undefined ? await sending : await withTimeout(sending, timeoutMs);
      return { sent: true, messageId: messageId ?? null };
    } catch (err) {
      const text = redact(String((err as Error)?.message ?? err), secrets);
      const status = (err as { status?: unknown })?.status;
      failed(p, 'transport', text, typeof status === 'number' ? { status } : {});
      return { sent: false, reason: 'failed', message: text };
    }
  }

  /** After a timer: the budgets' rows and the transport's work come after the request, not during it. */
  function afterTimer(work: () => unknown): void {
    deps.defer(new Promise((resolve) => setTimeout(resolve, 0)).then(work));
  }

  function later(p: Prepared | null): void {
    if (p) afterTimer(() => deliver(p));
  }

  /** A message to an account's own address; null for an account without one (or, for a notice, without a verified one). */
  function toUser<T extends MailTemplate>(template: T, params: TemplateParams[T], user: MailUser, meta: TrustedMeta | null, anonymous = false): Prepared | null {
    if (user.email === null || (SECURITY_NOTICES.has(template) && user.email_verified_at === null)) return null;
    return prepare(template, params, { to: user.email, userId: user.id, anonymous, meta });
  }

  /** password_changed's list: grants (member_added, member_role_changed) and open invitations of the last 7 days. */
  function recentGrants(userId: number): { grants: Grant[]; more: boolean } {
    const since = iso(deps.now() - 7 * DAY_MS);
    const members = db.all<{ created_at: string; space_name: string | null; person: string | null; role: string | null }>(
      `SELECT e.created_at, s.name AS space_name, u.display_name AS person, json_extract(e.data, '$.role') AS role
       FROM security_events e
       LEFT JOIN spaces s ON s.public_id = json_extract(e.data, '$.space')
       LEFT JOIN users u ON u.id = json_extract(e.data, '$.userId')
       WHERE e.user_id = :userId AND e.type IN ('member_added', 'member_role_changed') AND e.created_at >= :since
       ORDER BY e.id DESC LIMIT ${GRANTS_LISTED + 1}`,
      { userId, since },
    );
    const invitations = db.all<{ created_at: string; space_name: string | null; space_id: number | null; role: string | null }>(
      `SELECT i.created_at, s.name AS space_name, i.space_id, i.role
       FROM invitations i LEFT JOIN spaces s ON s.id = i.space_id
       WHERE i.invited_by = :userId AND i.created_at >= :since AND i.accepted_at IS NULL AND i.revoked_at IS NULL
       ORDER BY i.id DESC LIMIT ${GRANTS_LISTED + 1}`,
      { userId, since },
    );
    const all = [
      ...members.map((m) => ({ at: m.created_at, grant: { kind: 'member' as const, spaceName: m.space_name ?? '', personName: m.person, role: m.role } })),
      ...invitations.map((i) => ({
        at: i.created_at,
        grant: { kind: 'invitation' as const, spaceName: i.space_id === null ? null : (i.space_name ?? ''), personName: null, role: i.role },
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return { grants: all.slice(0, GRANTS_LISTED).map((g) => g.grant), more: all.length > GRANTS_LISTED };
  }

  return {
    deliversMail: transport.deliversMail,
    sendsTokens: sendsTokens(transport, config.mail),
    link,

    signupVerify: ({ to, token, meta }) => later(prepare('signup_verify', { token }, { to, userId: null, anonymous: true, meta })),
    signupExisting: ({ user, meta }) => later(toUser('signup_existing', {}, user, meta, true)),
    verifyEmail: ({ user, token, meta }) => later(user.email === null ? null : toUser('verify_email', { address: user.email, token }, user, meta)),
    passwordReset: ({ user, token, anonymous, byAdmin, meta }) => later(toUser('password_reset', { token, byAdmin: byAdmin ?? false }, user, meta, anonymous)),
    passwordResetToNobody: ({ to }) => {
      // The same rows as a password_reset that is sent (or dropped over a budget) would write.
      if (transport.deliversMail) afterTimer(() => spend({ template: 'password_reset', to, anonymous: true }));
    },
    passwordResetByAdmin: ({ user, adminName, meta }) => later(toUser('password_reset_by_admin', { adminName }, user, meta)),
    passwordChanged: ({ user, via, meta }) => {
      if (user.email === null || user.email_verified_at === null) return;
      const { grants, more } = recentGrants(user.id);
      later(toUser('password_changed', { via, grants, moreGrants: more }, user, meta));
    },
    // userId null: a mail_failed in the requester's log would name the template, so tell the requester whether
    // another account has the address (§13.6).
    emailChangeConfirm: ({ user, to, token, meta }) => later(prepare('email_change_confirm', { token, account: label(user) }, { to, userId: null, meta })),
    emailChangeTaken: ({ user, to, meta }) => later(prepare('email_change_taken', { account: label(user) }, { to, userId: null, meta })),
    emailChangedNotice: ({ user, meta }) => later(toUser('email_changed_notice', {}, user, meta)),
    passkeyAdded: ({ user, passkeyName, via, meta }) => later(toUser('passkey_added', { passkeyName, via }, user, meta)),
    // Caused by anonymous requests (anyone's failed sign-ins), so it counts on ma:<day> too.
    loginAttempts: ({ user, meta }) => later(toUser('login_attempts', {}, user, meta, true)),
    recoveryUsed: ({ user, madeAdmin, meta }) => later(toUser('recovery_used', { madeAdmin }, user, meta)),

    invitation: (o) =>
      deliver(
        prepare(
          'invitation',
          { token: o.token, inviter: o.inviter, spaceName: o.spaceName, role: o.role, expiresAt: o.expiresAt },
          { to: o.to, userId: null, meta: o.meta },
        ),
        INVITATION_SEND_TIMEOUT_MS,
      ),
    test: async ({ user, meta }) => {
      if (user.email === null) return { sent: false, reason: 'failed', message: 'This account has no email address to send the test message to.' };
      return deliver({ ...prepare('mail_test', { transport: transport.kind }, { to: user.email, userId: user.id, meta }), dayOnly: true });
    },
  };
}

/** `work`, or a rejection once `ms` have passed (a transport that ignores SendOptions.timeoutMs). */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The mail transport did not finish within ${Math.round(ms / 1000)} s`)), ms);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
