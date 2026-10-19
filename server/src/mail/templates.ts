// The messages the directory sends (design §5.10.5), as text and HTML. directory/mailer.ts decides when
// and whether one is sent; this module only writes them, from plain parameters.
//
// - Subjects are fixed text (and INSTANCE_NAME, the operator's): never a name or anything else a user
//   chose.
// - Tokens appear only in the links (PUBLIC_URL + path + #t=<token>), never in a subject or other text.
// - Names people chose reach a message only through mailSafeName (message.ts): cut, escaped, and the
//   neutral fallback when they look like a link or an address. Every other value is HTML-escaped too.
// - HTML is simple: inline styles only, no images, no remote resources, no tracking.

import type { InvitableRole } from '@shared/roles';
import { escapeHtml, mailSafeName, type SafeName } from './message';

export type MailTemplate =
  | 'signup_verify'
  | 'signup_existing'
  | 'verify_email'
  | 'invitation'
  | 'password_reset'
  | 'password_reset_by_admin'
  | 'password_changed'
  | 'email_change_confirm'
  | 'email_change_taken'
  | 'email_changed_notice'
  | 'passkey_added'
  | 'login_attempts'
  | 'recovery_used'
  /** POST /api/admin/mail/test (not one of §5.10.5's templates). */
  | 'mail_test';

/** The security notices (§5.10.5): exempt from the per-recipient budget mr:<email_key>. */
export const SECURITY_NOTICES: ReadonlySet<MailTemplate> = new Set([
  'password_reset_by_admin',
  'password_changed',
  'email_changed_notice',
  'passkey_added',
  'login_attempts',
  'recovery_used',
]);

/** The account a message is about, as the email-change messages name it (§5.8.10). */
export interface AccountLabel {
  displayName: string;
  /** The account's current email address, or null (an account from before email addresses). */
  email: string | null;
  username: string | null;
}

/** A grant listed by password_changed: a membership or role given, or an invitation sent (§5.10.5). */
export interface Grant {
  kind: 'member' | 'invitation';
  /** null: an instance invitation (an account, no space). */
  spaceName: string | null;
  /** The person given access; null for an invitation (its address is not shown). */
  personName: string | null;
  role: string | null;
}

export interface TemplateParams {
  signup_verify: { token: string };
  signup_existing: Record<string, never>;
  verify_email: { address: string; token: string };
  invitation: {
    token: string;
    inviter: { displayName: string; email: string };
    /** null: an instance invitation. */
    spaceName: string | null;
    role: InvitableRole | null;
    expiresAt: string;
  };
  password_reset: { token: string; byAdmin: boolean };
  password_reset_by_admin: { adminName: string };
  password_changed: { via: 'change' | 'reset'; grants: Grant[]; moreGrants: boolean };
  email_change_confirm: { token: string; account: AccountLabel };
  email_change_taken: { account: AccountLabel };
  email_changed_notice: Record<string, never>;
  passkey_added: { passkeyName: string; via: 'settings' | 'reset' };
  login_attempts: Record<string, never>;
  recovery_used: { madeAdmin: boolean };
  mail_test: { transport: string };
}

export interface TemplateContext {
  instanceName: string;
  /** The absolute address of an app page ('/reset#t=…'), from PUBLIC_URL. */
  link(path: string): string;
  /** ms epoch: the dates messages mention. */
  now: number;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

// ---------------------------------------------------------------------------
// Building a body
// ---------------------------------------------------------------------------

/** Text (escaped in the HTML part), a SafeName, or a link. */
type Piece = string | SafeName | { href: string; label: string };

const COLOR = { text: '#1f2328', muted: '#59636e', border: '#d8dee4', accent: '#1f6feb', page: '#f4f5f7' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const isLink = (p: Piece): p is { href: string; label: string } => typeof p === 'object' && 'href' in p;

function pieceText(p: Piece): string {
  if (typeof p === 'string') return p;
  return isLink(p) ? `${p.label} (${p.href})` : p.text;
}

function pieceHtml(p: Piece): string {
  if (typeof p === 'string') return escapeHtml(p);
  if (isLink(p)) return `<a href="${escapeHtml(p.href)}" style="color:${COLOR.accent};">${escapeHtml(p.label)}</a>`;
  return p.html;
}

class Body {
  private readonly texts: string[] = [];
  private readonly htmls: string[] = [];

  p(...pieces: Piece[]): this {
    this.texts.push(pieces.map(pieceText).join(''));
    this.htmls.push(`<p style="margin:0 0 16px 0;">${pieces.map(pieceHtml).join('')}</p>`);
    return this;
  }

  note(...pieces: Piece[]): this {
    this.texts.push(pieces.map(pieceText).join(''));
    this.htmls.push(`<p style="margin:0 0 16px 0;font-size:13px;color:${COLOR.muted};">${pieces.map(pieceHtml).join('')}</p>`);
    return this;
  }

  /** The main link: a button, and the address for copying (the text part shows it on a line of its own). */
  button(label: string, href: string): this {
    this.texts.push(`${label}:\n${href}`);
    this.htmls.push(
      `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;` +
        `background-color:${COLOR.accent};color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">` +
        `${escapeHtml(label)}</a></p>` +
        `<p style="margin:0 0 16px 0;font-size:13px;color:${COLOR.muted};word-break:break-all;">` +
        `If the button does not work, copy this address into your browser:<br>${escapeHtml(href)}</p>`,
    );
    return this;
  }

  /** A quoted block (the invitation's names and the line that says who chose them). */
  quote(lines: Piece[][]): this {
    this.texts.push(lines.map((l) => `> ${l.map(pieceText).join('')}`).join('\n'));
    this.htmls.push(
      `<div style="margin:0 0 16px 0;padding:8px 16px;border-left:4px solid ${COLOR.border};color:${COLOR.text};">` +
        lines.map((l) => `<p style="margin:8px 0;">${l.map(pieceHtml).join('')}</p>`).join('') +
        '</div>',
    );
    return this;
  }

  list(items: Piece[][]): this {
    this.texts.push(items.map((i) => `- ${i.map(pieceText).join('')}`).join('\n'));
    this.htmls.push(`<ul style="margin:0 0 16px 0;padding-left:24px;">${items.map((i) => `<li>${i.map(pieceHtml).join('')}</li>`).join('')}</ul>`);
    return this;
  }

  render(ctx: TemplateContext, subject: string): RenderedMail {
    const origin = hostOf(ctx.link('/'));
    const footer = `Sent automatically by ${ctx.instanceName}${origin ? ` (${origin})` : ''}.`;
    const text = [ctx.instanceName, '', this.texts.join('\n\n'), '', '-- ', footer, ''].join('\n');
    const html =
      `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
      `<title>${escapeHtml(subject)}</title></head>` +
      `<body style="margin:0;padding:0;background-color:${COLOR.page};">` +
      `<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${COLOR.text};">` +
      `<div style="background-color:#ffffff;border:1px solid ${COLOR.border};border-radius:8px;padding:24px;">` +
      `<p style="margin:0 0 16px 0;font-size:13px;font-weight:600;color:${COLOR.muted};">${escapeHtml(ctx.instanceName)}</p>` +
      this.htmls.join('') +
      `</div><p style="margin:16px 0 0 0;font-size:12px;color:${COLOR.muted};">${escapeHtml(footer)}</p>` +
      '</div></body></html>';
    return { subject, text, html };
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "18 October 2026, 12:00 UTC". */
export function formatMailDate(ms: number): string {
  const d = new Date(ms);
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${time} UTC`;
}

const ROLE_TEXT: Record<string, string> = {
  owner: 'an owner',
  admin: 'an admin',
  member: 'a member',
  viewer: 'a viewer (read-only)',
};
const roleText = (role: string | null) => (role === null ? 'a member' : (ROLE_TEXT[role] ?? role));

/** "the account <name> (<email>)" with the names made safe. */
function accountPieces(account: AccountLabel, ctx: TemplateContext): Piece[] {
  const name = mailSafeName(account.displayName, `a member of ${ctx.instanceName}`);
  if (account.email !== null) return ['the account ', name, ` (${account.email})`];
  const username = mailSafeName(account.username, '');
  return username.text ? ['the account ', name, ' (username ', username, ')'] : ['the account ', name];
}

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

type Renderer<T extends MailTemplate> = (p: TemplateParams[T], ctx: TemplateContext) => RenderedMail;

const TEMPLATES: { [T in MailTemplate]: Renderer<T> } = {
  signup_verify: (p, ctx) =>
    new Body()
      .p(`Someone, probably you, asked to create an account on ${ctx.instanceName} with this email address.`)
      .button('Confirm and create your account', ctx.link(`/signup/complete#t=${p.token}`))
      .note('The link works for 24 hours. If you did not ask for an account, ignore this email: nothing is created without the link.')
      .render(ctx, `Confirm your email for ${ctx.instanceName}`),

  signup_existing: (_p, ctx) =>
    new Body()
      .p(`Someone, probably you, asked to create an account on ${ctx.instanceName} with this email address, but there already is an account with it.`)
      .button('Sign in', ctx.link('/login'))
      .p('Forgot your password? ', { label: 'Choose a new one', href: ctx.link('/forgot') }, '.')
      .note('If this was not you, ignore this email. Nothing has changed.')
      .render(ctx, `You already have an account on ${ctx.instanceName}`),

  verify_email: (p, ctx) =>
    new Body()
      .p(`Please confirm that ${p.address} is the email address of your account on ${ctx.instanceName}.`)
      .button('Confirm your email address', ctx.link(`/email/confirm#t=${p.token}`))
      .note('The link works for 24 hours, signed in to that account. If you did not ask for this, or have no account there, ignore this email.')
      .render(ctx, 'Confirm your email address'),

  invitation: (p, ctx) => {
    const inviter = mailSafeName(p.inviter.displayName, `a member of ${ctx.instanceName}`);
    const body = new Body();
    const lines: Piece[][] = [['Invited by: ', inviter, ` (${p.inviter.email})`]];
    if (p.spaceName !== null) {
      body.p(`You are invited to join a space on ${ctx.instanceName} as ${roleText(p.role)}.`);
      lines.push(['Space: ', mailSafeName(p.spaceName, 'a space')]);
    } else {
      body.p(`You are invited to create an account on ${ctx.instanceName}.`);
    }
    lines.push(['Names are chosen by the person who sent this invitation.']);
    return body
      .quote(lines)
      .button('Accept the invitation', ctx.link(`/invite#t=${p.token}`))
      .note(`The invitation expires on ${formatMailDate(Date.parse(p.expiresAt))}. If you do not know the sender, ignore this email.`)
      .render(ctx, p.spaceName !== null ? `You're invited to a space on ${ctx.instanceName}` : `You're invited to ${ctx.instanceName}`);
  },

  password_reset: (p, ctx) =>
    new Body()
      .p(p.byAdmin
        ? `An administrator of ${ctx.instanceName} sent you a link to choose a new password for your account.`
        : `Someone asked to reset the password of your account on ${ctx.instanceName}.`)
      .button('Choose a new password', ctx.link(`/reset#t=${p.token}`))
      .note('The link works for 30 minutes, once. If you did not ask for this, ignore this email: your password stays as it is.')
      .render(ctx, `Reset your password for ${ctx.instanceName}`),

  password_reset_by_admin: (p, ctx) =>
    new Body()
      .p(
        `An administrator of ${ctx.instanceName}, `,
        mailSafeName(p.adminName, 'an administrator'),
        `, created a password reset link for your account on ${formatMailDate(ctx.now)}.`,
      )
      .p('If you asked for it, there is nothing else to do. If you did not, sign in, change your password and tell the other administrators of this instance.')
      .render(ctx, 'An administrator created a password reset link for you'),

  password_changed: (p, ctx) => {
    const body = new Body()
      .p(`The password of your account on ${ctx.instanceName} was ${p.via === 'reset' ? 'reset' : 'changed'} on ${formatMailDate(ctx.now)}.`)
      .p('If this was you, there is nothing else to do.')
      .p('If it was not you, someone else may be using your account: ', { label: 'choose a new password', href: ctx.link('/forgot') }, ' at once, and tell an administrator of this instance.');
    if (p.grants.length > 0) {
      const items: Piece[][] = p.grants.map((g) => {
        const where: Piece[] = g.spaceName === null ? ['The instance'] : ['Space ', mailSafeName(g.spaceName, 'a space')];
        if (g.kind === 'invitation') return [...where, g.spaceName === null ? ': an invitation to create an account' : `: an invitation as ${roleText(g.role)}`];
        return [...where, ': ', mailSafeName(g.personName, `a member of ${ctx.instanceName}`), ` as ${roleText(g.role)}`];
      });
      if (p.moreGrants) items.push(['…and more']);
      body
        .p('In the last 7 days, your account gave these people access, or invited them. Check that you meant to:')
        .list(items)
        .p({ label: "Review your account's security events", href: ctx.link('/settings/security') }, '.');
    }
    return body.render(ctx, 'Your password was changed');
  },

  email_change_confirm: (p, ctx) =>
    new Body()
      .p('Someone asked to use this email address for ', ...accountPieces(p.account, ctx), ` on ${ctx.instanceName}.`)
      .button('Confirm your new email address', ctx.link(`/email/confirm#t=${p.token}`))
      .note('Confirm it while signed in to that account; the link works for 1 hour. If you did not ask for this, ignore this email: the address is not used without your confirmation.')
      .render(ctx, 'Confirm your new email address'),

  email_change_taken: (p, ctx) =>
    new Body()
      .p('Someone asked to use this email address for ', ...accountPieces(p.account, ctx), ` on ${ctx.instanceName}, but another account already has it. Nothing has changed.`)
      .p('If this was you, ', { label: 'sign in with this address', href: ctx.link('/login') }, ' instead.')
      .note('If it was not you, ignore this email.')
      .render(ctx, `Someone tried to use this address on ${ctx.instanceName}`),

  email_changed_notice: (_p, ctx) =>
    new Body()
      .p(`The email address of your account on ${ctx.instanceName} was changed on ${formatMailDate(ctx.now)}. This address is no longer used for it.`)
      .p('If you did not do this, tell an administrator of this instance at once.')
      .render(ctx, `Your email address on ${ctx.instanceName} was changed`),

  passkey_added: (p, ctx) =>
    new Body()
      .p(
        'A passkey, ',
        mailSafeName(p.passkeyName, 'without a name'),
        `, was added to your account on ${ctx.instanceName}${p.via === 'reset' ? ' with a password reset link' : ''} on ${formatMailDate(ctx.now)}.`,
      )
      .p('If you did not add it, sign in, remove it under Account settings, Security, and tell an administrator of this instance.')
      .render(ctx, 'A passkey was added to your account'),

  login_attempts: (_p, ctx) =>
    new Body()
      .p(
        `There were many failed attempts to sign in to your account on ${ctx.instanceName}. To protect it, signing in with your ` +
          'password is paused for a day in browsers that have not signed in to your account before.',
      )
      .p('Browsers you signed in with before, and passkeys, still work. If the attempts were not yours, check your account.')
      .button('Review your account security', ctx.link('/settings/security'))
      .render(ctx, 'Repeated failed sign-ins to your account'),

  recovery_used: (p, ctx) =>
    new Body()
      .p(
        `Your account on ${ctx.instanceName} was recovered with the recovery token on ${formatMailDate(ctx.now)}: a password ` +
          `reset link was created for it${p.madeAdmin ? ', and it became an administrator of the instance' : ''}.`,
      )
      .p('The recovery token is set by the operator of this instance. If you did not expect this, tell the operator.')
      .render(ctx, 'Your account was recovered with the recovery token'),

  mail_test: (p, ctx) =>
    new Body()
      .p(`This is a test message from ${ctx.instanceName}, sent on ${formatMailDate(ctx.now)} at the request of an administrator.`)
      .p(`It was sent with MAIL_TRANSPORT=${p.transport}. If you can read it, mail works.`)
      .render(ctx, `Test message from ${ctx.instanceName}`),
};

export function renderMail<T extends MailTemplate>(template: T, params: TemplateParams[T], ctx: TemplateContext): RenderedMail {
  return (TEMPLATES[template] as Renderer<T>)(params, ctx);
}
