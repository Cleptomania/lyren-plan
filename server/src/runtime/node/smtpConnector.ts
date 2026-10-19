// The SMTP connector on Node (design §5.10.2, §5.10.4): node:net for a plain connection (upgraded with
// STARTTLS, or SMTP_SECURITY=none to a mail server on this machine), node:tls for implicit TLS. TLS
// always verifies the server's certificate against SMTP_HOST (rejectUnauthorized, Node's hostname check;
// TLS 1.2 or newer). The only option adds certificate authorities to trust (tests); none turns
// verification off.

import net from 'node:net';
import tls from 'node:tls';
import type { SmtpConnector, SmtpSocket } from '../../mail/smtp/client';

export interface NodeSmtpConnectorOptions {
  /** Certificate authorities trusted besides Node's own (PEM). Tests pass the CA of their throwaway certificates. */
  ca?: string | readonly string[];
}

/** TLS options for `host`: SNI only for a name (never for an IP address), the identity checked against `host`. */
function tlsOptions(host: string, o: NodeSmtpConnectorOptions): tls.ConnectionOptions {
  const ca = o.ca === undefined ? undefined : [...tls.rootCertificates, ...(typeof o.ca === 'string' ? [o.ca] : o.ca)];
  return { host, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ca };
}

/** Resolves once `socket` emits `ready` (connect, secureConnect); rejects on an error, a close or the timeout. */
function opened(socket: net.Socket, ready: 'connect' | 'secureConnect', timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('no answer in time')), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      socket.off(ready, onReady);
      socket.off('error', fail);
      socket.off('close', onClose);
    };
    const onReady = () => {
      done();
      resolve();
    };
    const onClose = () => fail(new Error('the connection was closed'));
    function fail(err: Error) {
      done();
      socket.destroy();
      reject(err);
    }
    socket.once(ready, onReady);
    socket.once('error', fail);
    socket.once('close', onClose);
  });
}

class NodeSmtpSocket implements SmtpSocket {
  private readonly chunks: Uint8Array[] = [];
  private waiting: { resolve(chunk: Uint8Array | null): void; reject(err: Error): void } | null = null;
  private ended = false;
  private failure: Error | null = null;

  constructor(
    private readonly socket: net.Socket,
    private readonly options: NodeSmtpConnectorOptions,
    private readonly timeoutMs: number,
  ) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('close', this.onEnd);
    socket.on('error', this.onError);
  }

  private readonly onData = (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk);
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(bytes);
    } else {
      this.chunks.push(bytes);
    }
  };

  private readonly onEnd = () => {
    this.ended = true;
    const w = this.waiting;
    this.waiting = null;
    w?.resolve(null);
  };

  private readonly onError = (err: Error) => {
    this.failure = err;
    const w = this.waiting;
    this.waiting = null;
    w?.reject(err);
  };

  read(): Promise<Uint8Array | null> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  async startTls(servername: string): Promise<SmtpSocket> {
    // Bytes that arrived before the handshake belong to nobody (the client refuses them as well).
    if (this.chunks.length > 0) throw new Error('data arrived before the TLS handshake');
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('close', this.onEnd);
    this.socket.off('error', this.onError);
    // The TLS socket reports the errors of the one it wraps; this keeps them from being unhandled.
    this.socket.on('error', () => {});
    const secure = tls.connect({ ...tlsOptions(servername, this.options), socket: this.socket });
    await opened(secure, 'secureConnect', this.timeoutMs);
    return new NodeSmtpSocket(secure, this.options, this.timeoutMs);
  }

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

export function createNodeSmtpConnector(options: NodeSmtpConnectorOptions = {}): SmtpConnector {
  return {
    async connect({ host, port, implicitTls, timeoutMs }) {
      const socket = implicitTls ? tls.connect({ ...tlsOptions(host, options), port }) : net.connect({ host, port });
      await opened(socket, implicitTls ? 'secureConnect' : 'connect', timeoutMs);
      return new NodeSmtpSocket(socket, options, timeoutMs);
    },
  };
}
