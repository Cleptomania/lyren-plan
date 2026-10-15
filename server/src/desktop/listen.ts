// Listening with a fallback port. The browser origin includes the port, so a different port means
// different browser storage (theme, list settings), a separate installed app and broken bookmarks.
// Hence: an explicit PORT is used as given or not at all; otherwise the port remembered from the
// last start comes first, then the default and the next few after it, and whichever works is
// remembered (desktop.json) so the address stays the same from then on.
//
// Windows lets a program listen on 127.0.0.1:P while another one listens on 0.0.0.0:P (and the
// other way round) unless that one asked for exclusive use, and loopback connections then reach
// the newer listener. So there a port is first probed with a connection to the browser's address:
// if something answers, the port counts as in use (EADDRINUSE), like a failed listen elsewhere.

import net, { type Server } from 'node:net';

export function candidatePorts(options: { port: number; explicit: boolean; remembered?: number | undefined; span: number }): number[] {
  const { port, explicit, remembered, span } = options;
  if (explicit) return [port];
  const list = remembered !== undefined ? [remembered] : [];
  for (let p = port; p < port + span && p <= 65535; p++) list.push(p);
  return [...new Set(list)];
}

/**
 * After listening on port `used`: the port to remember in desktop.json, and the remembered port
 * when it was taken this time (`usual`, else null). A remembered port stays remembered, so the
 * address (bookmarks, an installed app, the browser's storage) returns to it once it is free; only
 * a start without one (the first) remembers where it fell back to. An explicit port changes nothing.
 */
export function portToRemember(options: { explicit: boolean; remembered: number | undefined; used: number }): {
  remember: number | undefined;
  usual: number | null;
} {
  const { explicit, remembered, used } = options;
  if (explicit) return { remember: remembered, usual: null };
  if (remembered !== undefined && remembered !== used) return { remember: remembered, usual: remembered };
  return { remember: used, usual: null };
}

/**
 * Errors that mean "this port is not available, try another": in use, or (Windows) inside a range
 * reserved by Hyper-V / WSL / Docker, which fails with EACCES.
 */
export function isPortUnavailable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

export interface ListenResult {
  port: number;
  /** Ports tried before `port`, with the error code each one failed with. */
  skipped: Array<{ port: number; code: string }>;
}

function listenOnce(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Resolves true when something accepts connections on host:port (another program uses the port). */
export type PortProbe = (port: number) => Promise<boolean>;

/**
 * A probe that connects to `host` (the browser's address, e.g. 127.0.0.1). A refused connection
 * fails within milliseconds; no answer within `timeoutMs` counts as free.
 */
export function connectProbe(host: string, timeoutMs = 300): PortProbe {
  return (port) =>
    new Promise((resolve) => {
      const socket = net.connect({ port, host });
      const done = (inUse: boolean) => {
        socket.destroy();
        resolve(inUse);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
}

function inUseError(host: string, port: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use ${host}:${port}`), { code: 'EADDRINUSE', port });
}

/**
 * Listen on the first available port of `ports`; rethrows the last error when none is. With a
 * `probe`, a port it finds in use is treated like EADDRINUSE without trying to listen on it.
 */
export async function listenOnFirstAvailable(server: Server, host: string, ports: readonly number[], probe?: PortProbe): Promise<ListenResult> {
  const skipped: ListenResult['skipped'] = [];
  for (const [i, port] of ports.entries()) {
    try {
      if (probe && (await probe(port))) throw inUseError(host, port);
      await listenOnce(server, port, host);
      return { port, skipped };
    } catch (err) {
      if (!isPortUnavailable(err) || i === ports.length - 1) throw err;
      skipped.push({ port, code: String((err as NodeJS.ErrnoException).code) });
    }
  }
  throw new Error('No port to listen on');
}
