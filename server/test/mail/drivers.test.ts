// The HTTP and binding drivers (mail/resend.ts, mail/cloudflare.ts; design §5.10.2): Resend with a fetch
// stub (the request, the 10 s timeout, a refusal as MailError(status, body) without the key), Cloudflare
// Email Service with a binding stub (and none: a configuration error). Both check the message as the SMTP
// driver does (§5.10.3) and send nothing they refuse.

import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/config';
import { createCloudflareTransport, type EmailBinding } from '../../src/mail/cloudflare';
import { MailError } from '../../src/mail/errors';
import { InvalidMessageError } from '../../src/mail/message';
import { createResendTransport, RESEND_URL } from '../../src/mail/resend';

const KEY = 're_SECRETKEY123';
const from = { address: 'no-reply@plan.example.com', name: 'Plan für Ärzte' };
const message = { to: 'alice@example.com', subject: 'Hello', text: 'Hello Alice', html: '<p>Hello Alice</p>', template: 'mail_test' };

interface Call {
  url: string;
  init: RequestInit;
}

function fetchStub(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const stub = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return { stub, calls };
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('resend', () => {
  it('POSTs { from, to: [to], subject, text, html } with the key as a bearer token, and returns the id', async () => {
    const { stub, calls } = fetchStub(() => Response.json({ id: 'msg_123' }));
    const transport = createResendTransport(KEY, from, { replyTo: 'help@example.com', fetch: stub });
    expect(transport).toMatchObject({ kind: 'resend', deliversMail: true });
    expect(await transport.send(message)).toEqual({ messageId: 'msg_123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: '"Plan für Ärzte" <no-reply@plan.example.com>',
      to: ['alice@example.com'],
      subject: 'Hello',
      text: 'Hello Alice',
      html: '<p>Hello Alice</p>',
      reply_to: 'help@example.com',
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a non-2xx answer is MailError(status, body), with the key redacted from the body', async () => {
    const { stub } = fetchStub(() => new Response(`{"name":"validation_error","message":"API key ${KEY} is invalid"}`, { status: 403 }));
    const err = await rejection(createResendTransport(KEY, from, { fetch: stub }).send(message));
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).status).toBe(403);
    expect(err.message).toBe('Resend refused the message (403): {"name":"validation_error","message":"API key [redacted] is invalid"}');
  });

  it('gives up after its timeout (10 s by default; the caller can ask for less)', async () => {
    const hang = fetchStub(
      (call) =>
        new Promise<Response>((_, reject) => {
          call.init.signal!.addEventListener('abort', () => reject(call.init.signal!.reason));
        }),
    );
    const err = await rejection(createResendTransport(KEY, from, { fetch: hang.stub, timeoutMs: 50 }).send(message));
    expect(err).toBeInstanceOf(MailError);
    expect(err.message).toBe('Resend did not answer in time');
    const short = await rejection(createResendTransport(KEY, from, { fetch: hang.stub }).send(message, { timeoutMs: 30 }));
    expect(short.message).toBe('Resend did not answer in time');
  });

  it('a network failure is a MailError without the key', async () => {
    const { stub } = fetchStub(() => {
      throw new TypeError(`fetch failed for ${KEY}`);
    });
    const err = await rejection(createResendTransport(KEY, from, { fetch: stub }).send(message));
    expect(err.message).toBe('Could not reach Resend: fetch failed for [redacted]');
  });

  it('refuses an invalid message before any request', async () => {
    const { stub, calls } = fetchStub(() => Response.json({ id: 'x' }));
    const transport = createResendTransport(KEY, from, { fetch: stub });
    await expect(transport.send({ ...message, subject: 'Hi\r\nBcc: evil@example.com' })).rejects.toThrow(InvalidMessageError);
    await expect(transport.send({ ...message, to: 'alice@example.com, evil@example.com' })).rejects.toThrow(InvalidMessageError);
    expect(calls).toEqual([]);
  });
});

describe('cloudflare', () => {
  it('sends through env.EMAIL.send({ from, to, subject, text, html, replyTo }) and returns its messageId', async () => {
    const sent: unknown[] = [];
    const binding: EmailBinding = {
      async send(m) {
        sent.push(m);
        return { messageId: 'cf-msg-1' };
      },
    };
    const transport = createCloudflareTransport(binding, from, { replyTo: 'help@example.com' });
    expect(transport).toMatchObject({ kind: 'cloudflare', deliversMail: true });
    expect(await transport.send(message)).toEqual({ messageId: 'cf-msg-1' });
    expect(sent).toEqual([
      {
        from: { name: 'Plan für Ärzte', email: 'no-reply@plan.example.com' },
        to: 'alice@example.com',
        subject: 'Hello',
        text: 'Hello Alice',
        html: '<p>Hello Alice</p>',
        replyTo: 'help@example.com',
      },
    ]);
  });

  it("the binding's refusal is a MailError with its text", async () => {
    const binding: EmailBinding = {
      send: async () => {
        throw new Error('E_SENDER_NOT_VERIFIED: sender domain is not verified');
      },
    };
    const err = await rejection(createCloudflareTransport(binding, from).send(message));
    expect(err).toBeInstanceOf(MailError);
    expect(err.message).toBe('Cloudflare Email Service refused the message: E_SENDER_NOT_VERIFIED: sender domain is not verified');
  });

  it("puts the error's code property in front of its text, as the binding reports it, and only once", async () => {
    const refusing = (error: unknown): EmailBinding => ({
      send: async () => {
        throw error;
      },
    });
    const coded = Object.assign(new Error('Recipient is on the suppression list'), { code: 'E_RECIPIENT_SUPPRESSED' });
    expect((await rejection(createCloudflareTransport(refusing(coded), from).send(message))).message).toBe(
      'Cloudflare Email Service refused the message: E_RECIPIENT_SUPPRESSED: Recipient is on the suppression list',
    );
    const both = Object.assign(new Error('E_DAILY_LIMIT_EXCEEDED: daily limit reached'), { code: 'E_DAILY_LIMIT_EXCEEDED' });
    expect((await rejection(createCloudflareTransport(refusing(both), from).send(message))).message).toBe(
      'Cloudflare Email Service refused the message: E_DAILY_LIMIT_EXCEEDED: daily limit reached',
    );
    for (const code of [undefined, '', '  ', 42]) {
      const plain = Object.assign(new Error('Something failed'), { code });
      expect((await rejection(createCloudflareTransport(refusing(plain), from).send(message))).message).toBe(
        'Cloudflare Email Service refused the message: Something failed',
      );
    }
  });

  it('without the binding it is a configuration error (MAIL_TRANSPORT)', () => {
    for (const binding of [undefined, {} as EmailBinding]) {
      let error: unknown;
      try {
        createCloudflareTransport(binding, from);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).variable).toBe('MAIL_TRANSPORT');
      expect((error as Error).message).toMatch(/needs a send_email binding named EMAIL/);
    }
  });

  it('refuses an invalid message before calling the binding', async () => {
    let calls = 0;
    const transport = createCloudflareTransport({ send: async () => (calls++, { messageId: 'x' }) }, from);
    await expect(transport.send({ ...message, subject: 'a\nb' })).rejects.toThrow(InvalidMessageError);
    expect(calls).toBe(0);
  });
});
