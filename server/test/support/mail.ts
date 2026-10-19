// A mail transport for tests: it records every message instead of sending it, and counts as one that
// delivers mail (so the rules that need a verified address apply, as with a real transport). A test can
// make it fail (`failWith`) or wait (`hold`) to see how the mailer and the flows handle that.

import type { MailMessage, MailTransport, SendOptions } from '../../src/mail/transport';

export interface RecordingTransport extends MailTransport {
  readonly outbox: MailMessage[];
  /** The options of each send, in order (the invitation's timeout). */
  readonly options: SendOptions[];
  /** While set, every send fails with it and records nothing. */
  failWith: Error | null;
  /** While set, every send waits for it before it records (or fails). */
  hold: Promise<void> | null;
}

export function createRecordingTransport(): RecordingTransport {
  const outbox: MailMessage[] = [];
  const options: SendOptions[] = [];
  const transport: RecordingTransport = {
    kind: 'smtp',
    deliversMail: true,
    outbox,
    options,
    failWith: null,
    hold: null,
    async send(message, o = {}) {
      options.push(o);
      if (transport.hold) await transport.hold;
      if (transport.failWith) throw transport.failWith;
      outbox.push(message);
      return { messageId: `<test-${outbox.length}@example.com>` };
    },
  };
  return transport;
}

/** The link token of a message (`#t=<token>` in its text part); throws when it has none. */
export function linkToken(message: MailMessage | undefined): string {
  const found = message?.text.match(/#t=([A-Za-z0-9_-]{43})/);
  if (!found) throw new Error(`no link token in ${message ? message.template : 'a missing message'}`);
  return found[1]!;
}

/** The token of a link the API answered with (`…/invite#t=<token>`). */
export function tokenOfLink(link: string): string {
  const found = link.match(/#t=([A-Za-z0-9_-]{43})$/);
  if (!found) throw new Error(`no token in ${link}`);
  return found[1]!;
}
