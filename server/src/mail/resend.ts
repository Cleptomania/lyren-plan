// The resend transport (design §5.10.2): POST https://api.resend.com/emails with the API key as a
// bearer token and JSON { from, to: [to], subject, text, html } (and reply_to when MAIL_REPLY_TO is set);
// Resend builds the MIME message. It works wherever fetch does (Node and Workers). 10 s timeout; an
// answer other than 2xx is a MailError with its status and body, the key never part of it.

import type { MailFrom } from '../core/config';
import { MailError, redact } from './errors';
import { checkMessage, quotedMailbox, type Envelope } from './message';
import type { MailMessage, MailTransport, SendOptions } from './transport';

export const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export function createResendTransport(
  apiKey: string,
  from: MailFrom,
  options: { replyTo?: string | null; fetch?: typeof fetch; timeoutMs?: number } = {},
): MailTransport {
  const envelope: Envelope = { from, replyTo: options.replyTo ?? null };
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  return {
    kind: 'resend',
    deliversMail: true,
    async send(message: MailMessage, o: SendOptions = {}) {
      checkMessage(message, envelope);
      const body: Record<string, unknown> = {
        from: quotedMailbox(from.name, from.address),
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      };
      if (envelope.replyTo !== null) body.reply_to = envelope.replyTo;
      const fetcher = options.fetch ?? fetch;
      let res: Response;
      try {
        res = await fetcher(RESEND_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(timeoutMs, o.timeoutMs ?? timeoutMs)),
        });
      } catch (err) {
        const name = (err as Error)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') throw new MailError('Resend did not answer in time');
        throw new MailError(`Could not reach Resend: ${redact(String((err as Error)?.message ?? err), [apiKey])}`);
      }
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new MailError(`Resend refused the message (${res.status}): ${redact(text, [apiKey])}`, res.status);
      let id: unknown;
      try {
        id = (JSON.parse(text) as { id?: unknown }).id;
      } catch {
        // a 2xx without the usual body: sent, without an id
      }
      return typeof id === 'string' ? { messageId: id } : {};
    },
  };
}
