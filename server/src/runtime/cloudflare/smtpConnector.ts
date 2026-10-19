// The SMTP connector on Cloudflare (design §5.10.2, §10.6): cloudflare:sockets connect() with
// secureTransport 'on' for implicit TLS, and 'starttls' otherwise, so that startTls() can upgrade the
// connection after the server's 220. The platform verifies the server's certificate against the host
// connected to, SMTP_HOST, after STARTTLS too. Port 25 is blocked on Workers (core/config.ts refuses
// it), and whether outbound TCP works on the Free plan is checked by the runbook (§10.12).
//
// `connect` may be another socket factory with the same signature: tests pass the connect() of a network
// service binding that trusts their throwaway certificate authority (a Fetcher's connect, which verifies
// certificates just the same). There is no option to turn verification off.

import { connect as socketConnect } from 'cloudflare:sockets';
import type { SmtpConnector, SmtpSocket } from '../../mail/smtp/client';

export type SocketFactory = (address: SocketAddress, options: SocketOptions) => Socket;

function wrap(socket: Socket, canUpgrade: boolean, timeoutMs: number): SmtpSocket {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  return {
    async read() {
      const { value, done } = await reader.read();
      return done ? null : (value as Uint8Array);
    },
    async write(data) {
      await writer.write(data);
    },
    async startTls() {
      if (!canUpgrade) throw new Error('The connection is already TLS');
      reader.releaseLock();
      writer.releaseLock();
      // Verified against the host given to connect(), SMTP_HOST (workerd takes no other name here).
      const secure = socket.startTls();
      await opened(secure, timeoutMs);
      return wrap(secure, false, timeoutMs);
    },
    async close() {
      await socket.close();
    },
  };
}

/** Resolves once the socket is open; rejects on its failure or after `timeoutMs`. */
async function opened(socket: Socket, timeoutMs: number): Promise<void> {
  // A failure reaches `opened`, the reads and the writes; `closed` rejecting as well is not unhandled.
  socket.closed.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no answer in time')), timeoutMs);
  });
  try {
    await Promise.race([socket.opened, timeout]);
  } catch (err) {
    socket.close().catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createCloudflareSmtpConnector(options: { connect?: SocketFactory } = {}): SmtpConnector {
  const connect = options.connect ?? socketConnect;
  return {
    async connect({ host, port, implicitTls, timeoutMs }) {
      const socket = connect({ hostname: host, port }, { secureTransport: implicitTls ? 'on' : 'starttls', allowHalfOpen: false });
      await opened(socket, timeoutMs);
      return wrap(socket, !implicitTls, timeoutMs);
    },
  };
}
