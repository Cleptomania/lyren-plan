// What the workers project's global setup (smtpGlobalSetup.ts) hands to vitest.config.ts and to the tests
// in workerd (provide/inject): the ports of the fake SMTP servers it started in Node on 127.0.0.1, the port
// of a small HTTP server that reports what each of them received, and the certificate authority of the
// throwaway certificates (null when openssl is missing, and `skipTls` says why).

export const SMTP_SCENARIOS = ['plain', 'split', 'slow', 'rcpt550', 'starttls', 'implicit', 'auth535', 'inject', 'otherHost'] as const;
export type SmtpScenario = (typeof SMTP_SCENARIOS)[number];

/** The credentials the TLS scenarios accept (starttls, implicit; auth535 refuses them). */
export const FIXTURE_USER = 'mailer@example.com';
export const FIXTURE_PASS = 'fixture-Secret-pass';

/** What one connection to a fake server (fakeSmtp.ts) said. */
export interface FakeSmtpSession {
  /** Every line the client sent (message data excluded), with whether it came over TLS. */
  commands: Array<{ line: string; secure: boolean }>;
  /** Credentials received, decoded. */
  auth: Array<{ mechanism: string; user: string; pass: string }>;
  /** Each message's data as received after DATA, unstuffed, CRLF line endings, without the final dot line. */
  messages: string[];
}

export interface SmtpFixture {
  /** Every scenario but the TLS ones has a port; those are missing without openssl. */
  ports: Partial<Record<SmtpScenario, number>>;
  /** GET http://127.0.0.1:<control>/<scenario> answers that server's FakeSmtpSession[] as JSON. */
  control: number;
  /** The authority's certificate (PEM), or null. */
  ca: string | null;
  /** Why the TLS scenarios are missing, or null. */
  skipTls: string | null;
}

declare module 'vitest' {
  export interface ProvidedContext {
    smtp: SmtpFixture;
  }
}
