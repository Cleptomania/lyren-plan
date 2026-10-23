// Mail transports (design §2.3, §5.10). MAIL_TRANSPORT picks one: log (the default: nothing is sent,
// only a line is logged), smtp (our own client, mail/smtp/client.ts), resend (its HTTP API) or cloudflare
// (a send_email binding, Workers Paid). Only log does not deliver mail, and every rule that needs a
// verified address applies only when the transport delivers mail (MailTransport.deliversMail).
//
// The runtime supplies what only it has (MailRuntime): the SMTP connector (node:net and node:tls on Node,
// cloudflare:sockets on Cloudflare), so neither bundle reaches the other's modules, and on Cloudflare the
// EMAIL binding.

import { ConfigError, type MailConfig, type MailTransportKind } from '../core/config';
import { createCloudflareTransport, type EmailBinding } from './cloudflare';
import { createLogTransport } from './log';
import { createResendTransport } from './resend';
import { createSmtpTransport, type SmtpConnector } from './smtp/client';

export { MailError } from './errors';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The mailer's template name (§5.10.5), for log lines; never sent. */
  template?: string;
}

export interface SendOptions {
  /**
   * The longest the send may take (the synchronous invitation's 10 s, §5.8.8): the SMTP and Resend
   * drivers stop by then; the caller stops waiting for the others.
   */
  timeoutMs?: number;
}

export interface MailTransport {
  readonly kind: MailTransportKind;
  /** false only for 'log'. */
  readonly deliversMail: boolean;
  /** Sends one message; throws a MailError (or an InvalidMessageError) when it was not sent. */
  send(message: MailMessage, options?: SendOptions): Promise<{ messageId?: string }>;
}

/** What a runtime hands to createMailTransport. */
export interface MailRuntime {
  /** The SMTP connector (runtime/node/smtpConnector.ts, runtime/cloudflare/smtpConnector.ts). */
  smtp?: SmtpConnector;
  /** Cloudflare: the send_email binding EMAIL, when the deploy added one (§10.6). */
  email?: EmailBinding;
  /** Default: the global fetch (Resend). */
  fetch?: typeof fetch;
}

/** The transport MAIL_TRANSPORT names. Throws a ConfigError for one this runtime cannot send with. */
export function createMailTransport(config: MailConfig, runtime: MailRuntime = {}): MailTransport {
  if (config.transport === 'log') return createLogTransport(config);
  // parseAppConfig requires MAIL_FROM for every other transport.
  if (config.from === null) throw new ConfigError('MAIL_FROM', `MAIL_FROM is required with MAIL_TRANSPORT=${config.transport}`);
  const options = { replyTo: config.replyTo };
  switch (config.transport) {
    case 'smtp':
      if (!config.smtp || !runtime.smtp) throw new ConfigError('MAIL_TRANSPORT', 'MAIL_TRANSPORT=smtp is not available in this runtime');
      return createSmtpTransport(config.smtp, runtime.smtp, config.from, options);
    case 'resend':
      if (config.resendApiKey === null) throw new ConfigError('RESEND_API_KEY', 'RESEND_API_KEY is required with MAIL_TRANSPORT=resend');
      return createResendTransport(config.resendApiKey, config.from, { ...options, fetch: runtime.fetch });
    case 'cloudflare':
      return createCloudflareTransport(runtime.email, config.from, options);
  }
}
