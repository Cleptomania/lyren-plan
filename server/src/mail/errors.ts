// The error every mail driver throws for a message it did not send (design §5.10). Its message is safe to
// log and to show an instance admin (POST /api/admin/mail/test): drivers never put a password, an API
// key or an AUTH line into it.

export class MailError extends Error {
  constructor(
    message: string,
    /** The SMTP reply code or the HTTP status that refused the message, when there was one. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'MailError';
  }
}

/** `text` with every secret replaced by "[redacted]", control characters dropped and cut to `max` characters. */
export function redact(text: string, secrets: ReadonlyArray<string | null | undefined>, max = 300): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
