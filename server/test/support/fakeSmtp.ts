// A fake SMTP server for the client's tests (design §14.2, §14.4): node:net (and node:tls) on 127.0.0.1,
// port 0, speaking just enough submission SMTP to receive one message per connection. Each option makes
// it misbehave in one way the client must handle: no STARTTLS, no AUTH, refused credentials, a 5xx on
// RCPT, slow replies, replies split across many writes, bytes injected after STARTTLS's 220. It records
// what each connection said (secure or not), the credentials it was given and the messages (unstuffed).
// The Node tests start it themselves; the workers tests reach the ones server/test-workers/smtpSetup.ts
// starts.

import net from 'node:net';
import tls from 'node:tls';
import type { FakeSmtpSession } from './smtpFixture';

export type { FakeSmtpSession };

type Step = 'GREETING' | 'EHLO' | 'STARTTLS' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'MESSAGE' | 'QUIT';

export interface FakeSmtpOptions {
  /** Default 0 (any free port). */
  port?: number;
  /** 'implicit': TLS from the first byte (port 465 style); default 'plain' (STARTTLS when offered). */
  mode?: 'plain' | 'implicit';
  /** The server's key and certificate; required for 'implicit' and for STARTTLS. */
  tls?: { key: string; cert: string };
  /** Advertise STARTTLS (default: when `tls` is given and mode is 'plain'). */
  offerStartTls?: boolean;
  /** AUTH mechanisms advertised (default PLAIN and LOGIN; [] advertises no AUTH). */
  auth?: ReadonlyArray<'PLAIN' | 'LOGIN'>;
  /** Only these credentials are accepted (535 otherwise); default: any. */
  credentials?: { user: string; pass: string };
  /** More EHLO lines, for long multi-line replies. */
  capabilities?: readonly string[];
  /** A reply of the server's choosing instead of the usual one (one or more lines, without CRLF). */
  replies?: Partial<Record<Step, string | readonly string[]>>;
  /** Wait this long before replying (ms). */
  delays?: Partial<Record<Step, number>>;
  /** Write every reply in pieces of this many bytes, a few milliseconds apart. */
  chunkBytes?: number;
  /** Sent right after STARTTLS's 220 in the same write (a man in the middle's injected reply). */
  afterStartTls?: string;
}

export interface FakeSmtpServer {
  port: number;
  readonly sessions: FakeSmtpSession[];
  close(): Promise<void>;
}

const DEFAULT_REPLIES: Record<Step, string | readonly string[]> = {
  GREETING: '220 fake.example ESMTP ready',
  EHLO: [],
  STARTTLS: '220 2.0.0 Ready to start TLS',
  AUTH: '235 2.7.0 Authentication successful',
  MAIL: '250 2.1.0 Sender OK',
  RCPT: '250 2.1.5 Recipient OK',
  DATA: '354 End data with <CR><LF>.<CR><LF>',
  MESSAGE: '250 2.0.0 Ok: queued as FAKE1',
  QUIT: '221 2.0.0 Bye',
};

const lines = (v: string | readonly string[]) => (typeof v === 'string' ? [v] : [...v]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decode64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtpServer> {
  const mode = options.mode ?? 'plain';
  if ((mode === 'implicit' || options.offerStartTls) && !options.tls) throw new Error('fake SMTP: TLS needs a key and a certificate');
  const offerStartTls = options.offerStartTls ?? (mode === 'plain' && options.tls !== undefined);
  const mechanisms = options.auth ?? ['PLAIN', 'LOGIN'];
  const sessions: FakeSmtpSession[] = [];
  const sockets = new Set<net.Socket>();

  function handle(raw: net.Socket, startsSecure: boolean) {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => {});
    const session: FakeSmtpSession = { commands: [], auth: [], messages: [] };
    sessions.push(session);
    let socket: net.Socket = raw;
    let secure = startsSecure;
    let buffer = '';
    let inData = false;
    let data = '';
    let login: null | 'user' | 'pass' = null;
    let loginUser = '';
    let plainPending = false;
    let queue = Promise.resolve();

    const write = async (text: string) => {
      if (!options.chunkBytes) {
        socket.write(text);
        return;
      }
      for (let i = 0; i < text.length; i += options.chunkBytes) {
        socket.write(text.slice(i, i + options.chunkBytes));
        await sleep(2);
      }
    };
    const reply = async (step: Step, fallback?: string | readonly string[]) => {
      const delay = options.delays?.[step];
      if (delay) await sleep(delay);
      const out = lines(options.replies?.[step] ?? fallback ?? DEFAULT_REPLIES[step]);
      await write(out.map((l) => `${l}\r\n`).join(''));
    };
    const checkAuth = (mechanism: string, user: string, pass: string) => {
      session.auth.push({ mechanism, user, pass });
      const ok = !options.credentials || (options.credentials.user === user && options.credentials.pass === pass);
      return reply('AUTH', ok ? undefined : '535 5.7.8 Authentication credentials invalid');
    };

    async function onLine(line: string) {
      session.commands.push({ line, secure });
      if (login === 'user') {
        loginUser = decode64(line);
        login = 'pass';
        return write('334 UGFzc3dvcmQ6\r\n');
      }
      if (login === 'pass') {
        login = null;
        return checkAuth('LOGIN', loginUser, decode64(line));
      }
      if (plainPending) {
        plainPending = false;
        const [, user = '', pass = ''] = decode64(line).split('\0');
        return checkAuth('PLAIN', user, pass);
      }
      const [verb = '', ...rest] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': {
          const caps = [...(options.capabilities ?? []), 'PIPELINING', '8BITMIME'];
          if (offerStartTls && !secure) caps.push('STARTTLS');
          if (mechanisms.length > 0) caps.push(`AUTH ${mechanisms.join(' ')}`);
          caps.push('SIZE 10240000');
          const out = ['fake.example Hello', ...caps];
          return reply('EHLO', out.map((l, i) => `250${i === out.length - 1 ? ' ' : '-'}${l}`));
        }
        case 'STARTTLS': {
          if (!offerStartTls || secure || !options.tls) return write('502 5.5.1 Not here\r\n');
          const delay = options.delays?.STARTTLS;
          if (delay) await sleep(delay);
          const first = lines(options.replies?.STARTTLS ?? DEFAULT_REPLIES.STARTTLS).map((l) => `${l}\r\n`).join('');
          raw.removeListener('data', onData);
          socket.write(first + (options.afterStartTls ?? ''));
          const upgraded = new tls.TLSSocket(raw, { isServer: true, key: options.tls.key, cert: options.tls.cert });
          upgraded.on('error', () => {});
          upgraded.on('data', onData);
          socket = upgraded;
          secure = true;
          buffer = '';
          return;
        }
        case 'AUTH': {
          const mechanism = (rest[0] ?? '').toUpperCase();
          if (mechanism === 'PLAIN' && rest[1]) {
            const [, user = '', pass = ''] = decode64(rest[1]).split('\0');
            return checkAuth('PLAIN', user, pass);
          }
          if (mechanism === 'PLAIN') {
            plainPending = true;
            return write('334 \r\n');
          }
          if (mechanism === 'LOGIN') {
            login = 'user';
            return write('334 VXNlcm5hbWU6\r\n');
          }
          return write('504 5.5.4 Unrecognized authentication type\r\n');
        }
        case 'MAIL':
          return reply('MAIL');
        case 'RCPT':
          return reply('RCPT');
        case 'DATA':
          inData = true;
          data = '';
          return reply('DATA');
        case 'QUIT':
          await reply('QUIT');
          socket.end();
          return;
        case 'RSET':
        case 'NOOP':
          return write('250 2.0.0 OK\r\n');
        default:
          return write('500 5.5.2 Unknown command\r\n');
      }
    }

    function onData(chunk: Buffer) {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          // The end is a line holding a single dot; with a CRLF put in front, a message that is only
          // that line is found as well. `end` counts that CRLF.
          const end = `\r\n${buffer}`.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data = end >= 2 ? `${buffer.slice(0, end - 2)}\r\n` : '';
          buffer = buffer.slice(end + 3);
          inData = false;
          session.messages.push(Buffer.from(data, 'latin1').toString('utf8').replace(/^\.\./gm, '.'));
          queue = queue.then(() => reply('MESSAGE'));
          continue;
        }
        const i = buffer.indexOf('\r\n');
        if (i < 0) return;
        const line = Buffer.from(buffer.slice(0, i), 'latin1').toString('utf8');
        buffer = buffer.slice(i + 2);
        queue = queue.then(() => onLine(line)).catch(() => {});
        // STARTTLS swaps the socket: what follows its line arrives on the TLS socket.
        if (/^STARTTLS$/i.test(line) && offerStartTls && !secure) return;
      }
    }

    socket.on('data', onData);
    queue = queue.then(() => reply('GREETING'));
  }

  const server =
    mode === 'implicit'
      ? tls.createServer({ key: options.tls!.key, cert: options.tls!.cert }, (s) => handle(s, true))
      : net.createServer((s) => handle(s, false));
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
