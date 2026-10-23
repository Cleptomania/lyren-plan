// The cloudflare transport (design §5.10.2, §10.6): Cloudflare Email Service through a send_email binding
// named EMAIL, env.EMAIL.send({ from, to, subject, text, html, replyTo }). Workers Paid only, with the
// sender's domain on Cloudflare. MAIL_TRANSPORT=cloudflare in the instance configuration adds the binding
// to each deploy (docs/cloudflare.md, "Your instance configuration"; it is not in the committed
// wrangler.jsonc). Without the binding the transport is a configuration error, so the directory answers
// 503 with the reason instead of failing at the first message.

import { ConfigError, type MailFrom } from '../core/config';
import { MailError, redact } from './errors';
import { checkMessage, type Envelope } from './message';
import type { MailMessage, MailTransport } from './transport';

/** The part of the Workers SendEmail binding the transport uses (the types package is not in the Node build). */
export interface EmailBinding {
  send(message: {
    from: { name: string; email: string };
    to: string;
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
  }): Promise<{ messageId?: string }>;
}

export const EMAIL_BINDING_MISSING =
  'MAIL_TRANSPORT=cloudflare needs a send_email binding named EMAIL in the Worker\'s configuration ("send_email": [{ "name": "EMAIL" }], Workers Paid)';

export function createCloudflareTransport(binding: EmailBinding | undefined, from: MailFrom, options: { replyTo?: string | null } = {}): MailTransport {
  if (!binding || typeof binding.send !== 'function') throw new ConfigError('MAIL_TRANSPORT', EMAIL_BINDING_MISSING);
  const envelope: Envelope = { from, replyTo: options.replyTo ?? null };
  return {
    kind: 'cloudflare',
    deliversMail: true,
    async send(message: MailMessage) {
      checkMessage(message, envelope);
      let result: { messageId?: string };
      try {
        result = await binding.send({
          from: { name: from.name, email: from.address },
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(envelope.replyTo !== null ? { replyTo: envelope.replyTo } : {}),
        });
      } catch (err) {
        // The binding throws an Error with a `code` property (E_SENDER_NOT_VERIFIED, E_RECIPIENT_SUPPRESSED,
        // E_DAILY_LIMIT_EXCEEDED, …), the most useful part for an admin: it goes in front of the message.
        const text = String((err as Error)?.message ?? err);
        const code = (err as { code?: unknown } | null)?.code;
        const detail = typeof code === 'string' && code.trim() !== '' && !text.includes(code) ? `${code}: ${text}` : text;
        throw new MailError(`Cloudflare Email Service refused the message: ${redact(detail, [])}`);
      }
      return typeof result?.messageId === 'string' ? { messageId: result.messageId } : {};
    },
  };
}
