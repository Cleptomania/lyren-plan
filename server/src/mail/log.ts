// The log mail transport (design §5.10.2): sends nothing (deliversMail false) and logs one line per
// message, on stdout on Node (the desktop app's log file too) and with console.log on Cloudflare
// (Workers Logs). The line names the template and the recipient's domain only, never the address, the
// subject or the body, so no live link ever reaches a log; with the log transport the mail-only token
// flows (forgot password, signup, verification, email change) do not even mint a token.
//
// MAIL_LOG_BODIES=1 (development only, warned about on public origins) prints the whole text part,
// links included, so those flows can be tried locally.

import type { MailConfig } from '../core/config';
import type { MailMessage, MailTransport } from './transport';

/** The part of an address after its last @ (what a log line may show). */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : 'an unknown domain';
}

export function createLogTransport(
  config: Pick<MailConfig, 'logBodies'>,
  log: (line: string) => void = (line) => console.log(line),
): MailTransport {
  return {
    kind: 'log',
    deliversMail: false,
    async send(message: MailMessage) {
      const template = message.template ?? 'message';
      if (!config.logBodies) {
        log(`[lyren] Mail not sent (MAIL_TRANSPORT=log): ${template} to an address at ${domainOf(message.to)} (suppressed)`);
        return {};
      }
      log(
        [
          `[lyren] Mail not sent (MAIL_TRANSPORT=log, MAIL_LOG_BODIES=1): ${template}`,
          `To: ${message.to}`,
          `Subject: ${message.subject}`,
          '',
          message.text,
        ].join('\n'),
      );
      return {};
    },
  };
}
