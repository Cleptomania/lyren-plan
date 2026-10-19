// The messages (mail/templates.ts, design §5.10.5): every template renders a text and an HTML part;
// subjects hold no user text; tokens appear only in links (#t=), and links come from PUBLIC_URL; names
// people chose pass through mailSafeName; the HTML loads nothing and carries no script.

import { describe, expect, it } from 'vitest';
import { formatMailDate, renderMail, SECURITY_NOTICES, type MailTemplate, type TemplateParams } from '../../src/mail/templates';

const TOKEN = 'TOKENabcdefghijklmnopqrstuvwxyz0123456789-_';
const ORIGIN = 'https://plan.example.com';
const ctx = { instanceName: 'Acme Plan', link: (p: string) => `${ORIGIN}${p}`, now: Date.parse('2026-10-18T09:05:00Z') };

/** Markers in every value a user chose; none may reach a subject. */
const NAME = 'Zed<b>Marker</b>';
const SPACE = 'Spacemarker & "Co"';
const account = { displayName: NAME, email: 'requester@example.com', username: null };

const PARAMS: { [T in MailTemplate]: TemplateParams[T] } = {
  signup_verify: { token: TOKEN },
  signup_existing: {},
  verify_email: { address: 'alice@example.com', token: TOKEN },
  invitation: { token: TOKEN, inviter: { displayName: NAME, email: 'inviter@example.com' }, spaceName: SPACE, role: 'viewer', expiresAt: '2026-10-25T09:05:00.000Z' },
  password_reset: { token: TOKEN, byAdmin: false },
  password_reset_by_admin: { adminName: NAME },
  password_changed: {
    via: 'change',
    grants: [
      { kind: 'member', spaceName: SPACE, personName: NAME, role: 'admin' },
      { kind: 'invitation', spaceName: SPACE, personName: null, role: 'viewer' },
      { kind: 'invitation', spaceName: null, personName: null, role: null },
    ],
    moreGrants: true,
  },
  email_change_confirm: { token: TOKEN, account },
  email_change_taken: { account },
  email_changed_notice: {},
  passkey_added: { passkeyName: NAME, via: 'settings' },
  login_attempts: {},
  recovery_used: { madeAdmin: true },
  mail_test: { transport: 'smtp' },
};

const TEMPLATES = Object.keys(PARAMS) as MailTemplate[];
const LINKS: Partial<Record<MailTemplate, string>> = {
  signup_verify: `/signup/complete#t=${TOKEN}`,
  verify_email: `/email/confirm#t=${TOKEN}`,
  invitation: `/invite#t=${TOKEN}`,
  password_reset: `/reset#t=${TOKEN}`,
  email_change_confirm: `/email/confirm#t=${TOKEN}`,
};

describe('renderMail', () => {
  it.each(TEMPLATES)('%s renders a subject, a text part and an HTML part', (template) => {
    const mail = renderMail(template, PARAMS[template] as never, ctx);
    expect(mail.subject.length).toBeGreaterThan(5);
    expect(mail.text).toContain('Acme Plan');
    expect(mail.text).toMatch(/Sent automatically by Acme Plan \(plan\.example\.com\)\.\n$/);
    expect(mail.html).toMatch(/^<!DOCTYPE html><html>.*<\/html>$/s);
    // Inline styles only: no style sheet, no script, nothing loaded.
    expect(mail.html).not.toMatch(/<script|<style|<link|<img|src=|url\(|@import|<iframe|<form/i);
    // Every link points into the app.
    for (const [, href] of mail.html.matchAll(/href="([^"]*)"/g)) expect(href).toMatch(/^https:\/\/plan\.example\.com\//);
  });

  it.each(TEMPLATES)('%s: the subject holds no user text and no token', (template) => {
    const { subject } = renderMail(template, PARAMS[template] as never, ctx);
    for (const marker of ['Marker', 'Zed', 'Spacemarker', 'requester', 'inviter', 'alice', TOKEN.slice(0, 10)]) expect(subject).not.toContain(marker);
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it.each(TEMPLATES)('%s: a token appears only in the link, built from PUBLIC_URL', (template) => {
    const { subject, text, html } = renderMail(template, PARAMS[template] as never, ctx);
    const link = LINKS[template];
    for (const part of [text, html]) {
      const uses = part.split(TOKEN).length - 1;
      if (!link) {
        expect(uses).toBe(0);
        continue;
      }
      // Each use follows "#t=" in the address PUBLIC_URL + path.
      expect(uses).toBeGreaterThan(0);
      expect(part.split(`${ORIGIN}${link}`).length - 1).toBe(uses);
    }
    expect(subject).not.toContain(TOKEN);
    if (link) expect(text).toContain(`\n${ORIGIN}${link}\n`);
  });

  it('names pass through mailSafeName: escaped in the HTML part, and the fallback when they look like links', () => {
    const invitation = renderMail('invitation', PARAMS.invitation, ctx);
    expect(invitation.text).toContain(`> Invited by: ${NAME} (inviter@example.com)`);
    expect(invitation.text).toContain(`> Space: ${SPACE}`);
    expect(invitation.text).toContain('> Names are chosen by the person who sent this invitation.');
    expect(invitation.html).toContain('Zed&#60;b&#62;Marker&#60;/b&#62;');
    expect(invitation.html).toContain('Spacemarker &#38; &#34;Co&#34;');
    expect(invitation.html).not.toContain('<b>Marker');
    const phishing = renderMail('invitation', { ...PARAMS.invitation, inviter: { displayName: 'Support: verify at paypal.example', email: 'inviter@example.com' }, spaceName: 'www.evil.example' }, ctx);
    expect(phishing.text).toContain('> Invited by: a member of Acme Plan (inviter@example.com)');
    expect(phishing.text).toContain('> Space: a space');
    expect(phishing.text + phishing.html).not.toMatch(/paypal|evil/);
  });

  it('an instance invitation names no space and says what it is', () => {
    const mail = renderMail('invitation', { ...PARAMS.invitation, spaceName: null, role: null }, ctx);
    expect(mail.subject).toBe("You're invited to Acme Plan");
    expect(mail.text).toContain('You are invited to create an account on Acme Plan.');
    expect(mail.text).not.toContain('Space:');
  });

  it('password_changed lists the grants, names made safe, and links to the security events', () => {
    const { text } = renderMail('password_changed', PARAMS.password_changed, ctx);
    expect(text).toContain(`- Space ${SPACE}: ${NAME} as an admin\n`);
    expect(text).toContain(`- Space ${SPACE}: an invitation as a viewer (read-only)\n`);
    expect(text).toContain('- The instance: an invitation to create an account\n');
    expect(text).toContain('- …and more');
    expect(text).toContain(`${ORIGIN}/settings/security`);
    expect(text).toContain('was changed on 18 October 2026, 09:05 UTC.');
    const none = renderMail('password_changed', { via: 'reset', grants: [], moreGrants: false }, ctx);
    expect(none.text).toContain('was reset on');
    expect(none.text).not.toContain('In the last 7 days');
  });

  it('the email-change messages name the requesting account', () => {
    expect(renderMail('email_change_confirm', PARAMS.email_change_confirm, ctx).text).toContain(
      `Someone asked to use this email address for the account ${NAME} (requester@example.com) on Acme Plan.`,
    );
    const legacy = renderMail('email_change_taken', { account: { displayName: 'Old Timer', email: null, username: 'oldtimer' } }, ctx);
    expect(legacy.text).toContain('for the account Old Timer (username oldtimer) on Acme Plan');
  });

  it('the security notices are the six of §5.10.5', () => {
    expect([...SECURITY_NOTICES].sort()).toEqual(
      ['email_changed_notice', 'login_attempts', 'passkey_added', 'password_changed', 'password_reset_by_admin', 'recovery_used'].sort(),
    );
  });

  it('formats dates for people, in UTC', () => {
    expect(formatMailDate(Date.parse('2026-01-02T03:04:05Z'))).toBe('2 January 2026, 03:04 UTC');
  });
});
