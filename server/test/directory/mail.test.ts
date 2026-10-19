// The log transport and transport selection (mail/log.ts, mail/transport.ts; design §5.10.2): the log
// transport never prints a recipient's address, a subject or a body unless MAIL_LOG_BODIES is set, and
// createMailTransport builds what MAIL_TRANSPORT names with the runtime's pieces (the SMTP connector, the
// EMAIL binding). The drivers themselves: server/test/mail/.

import { describe, expect, it } from 'vitest';
import { ConfigError, parseAppConfig } from '../../src/core/config';
import { createLogTransport } from '../../src/mail/log';
import type { SmtpConnector } from '../../src/mail/smtp/client';
import { createMailTransport } from '../../src/mail/transport';

const message = {
  to: 'Alice.Example@mail.example.com',
  subject: 'Reset your Lyren Plan password',
  text: 'Open https://plan.example.com/reset#t=SECRETTOKEN to choose a new password.',
  html: '<p><a href="https://plan.example.com/reset#t=SECRETTOKEN">Reset</a></p>',
  template: 'password_reset',
};

describe('log transport', () => {
  it('does not deliver mail, and logs only the template and the recipient domain', async () => {
    const lines: string[] = [];
    const transport = createLogTransport({ logBodies: false }, (line) => lines.push(line));
    expect(transport).toMatchObject({ kind: 'log', deliversMail: false });
    expect(await transport.send(message)).toEqual({});
    expect(lines).toEqual(['[lyren] Mail not sent (MAIL_TRANSPORT=log): password_reset to an address at mail.example.com (suppressed)']);
    const all = lines.join('\n');
    expect(all).not.toContain('Alice');
    expect(all).not.toContain('SECRETTOKEN');
    expect(all).not.toContain('Reset your');
  });

  it('with MAIL_LOG_BODIES prints the whole text part (development), never the HTML', async () => {
    const lines: string[] = [];
    const transport = createLogTransport({ logBodies: true }, (line) => lines.push(line));
    await transport.send(message);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('To: Alice.Example@mail.example.com');
    expect(lines[0]).toContain('Subject: Reset your Lyren Plan password');
    expect(lines[0]).toContain('reset#t=SECRETTOKEN');
    expect(lines[0]).not.toContain('<a href');
  });

  it('names a message without a template neutrally', async () => {
    const lines: string[] = [];
    await createLogTransport({ logBodies: false }, (line) => lines.push(line)).send({ ...message, template: undefined });
    expect(lines[0]).toBe('[lyren] Mail not sent (MAIL_TRANSPORT=log): message to an address at mail.example.com (suppressed)');
  });
});

describe('createMailTransport', () => {
  it('builds the log transport from the configuration', () => {
    const transport = createMailTransport(parseAppConfig({}, 'node').directory.mail);
    expect(transport).toMatchObject({ kind: 'log', deliversMail: false });
  });

  it('builds the smtp, resend and cloudflare transports from the configuration and the runtime', () => {
    const base = { MAIL_FROM: 'plan@example.com', PUBLIC_URL: 'https://plan.example.com' };
    const connector: SmtpConnector = { connect: async () => Promise.reject(new Error('not used')) };
    const smtp = parseAppConfig({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com' }, 'node').directory.mail;
    expect(createMailTransport(smtp, { smtp: connector })).toMatchObject({ kind: 'smtp', deliversMail: true });
    const resend = parseAppConfig({ ...base, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test' }, 'node').directory.mail;
    expect(createMailTransport(resend)).toMatchObject({ kind: 'resend', deliversMail: true });
    const cloudflare = parseAppConfig({ ...base, MAIL_TRANSPORT: 'cloudflare' }, 'cloudflare').directory.mail;
    const email = { send: async () => ({ messageId: 'cf-1' }) };
    expect(createMailTransport(cloudflare, { email })).toMatchObject({ kind: 'cloudflare', deliversMail: true });
  });

  it('a transport the runtime cannot build is a configuration error that names the variable', () => {
    const base = { MAIL_FROM: 'plan@example.com', PUBLIC_URL: 'https://plan.example.com' };
    const errorOf = (fn: () => unknown): ConfigError => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return err as ConfigError;
      }
      throw new Error('expected a ConfigError');
    };
    const cloudflare = parseAppConfig({ ...base, MAIL_TRANSPORT: 'cloudflare' }, 'cloudflare').directory.mail;
    const missing = errorOf(() => createMailTransport(cloudflare));
    expect(missing.variable).toBe('MAIL_TRANSPORT');
    expect(missing.message).toBe(
      'MAIL_TRANSPORT=cloudflare needs a send_email binding named EMAIL in the Worker\'s configuration ("send_email": [{ "name": "EMAIL" }], Workers Paid)',
    );
    const smtp = parseAppConfig({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'secret-value' }, 'node').directory.mail;
    const noConnector = errorOf(() => createMailTransport(smtp));
    expect(noConnector.message).toBe('MAIL_TRANSPORT=smtp is not available in this runtime');
    expect(noConnector.message).not.toContain('secret-value');
  });
});
