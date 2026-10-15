// One desktop server per database. The running server holds an exclusive local IPC endpoint named
// after the database path: a named pipe on Windows, an abstract Unix socket on Linux (both vanish
// with the process, so a crash never leaves a stale lock), a socket file elsewhere. A second
// start finds the name taken, asks the holder for its address and opens the browser there
// instead of opening the database a second time.
//
// Another local user could take the name first and answer with an address of their own (a fake
// sign-in page). So the answer must prove knowledge of a secret the running server wrote to
// desktop.json in the data folder, which only the owner of that folder can read (the app creates
// it with mode 0700, on Windows with a private ACL, and warns about an existing folder other
// Windows accounts can read; see folder.ts): the client sends a random challenge and accepts the
// address only with a matching HMAC(secret, challenge + url).
//
// A server that fails to start releases the name at once (lock.close() also drops the clients
// waiting for its address, which then retry and take the name), so a start that failed and waits
// for Enter never makes the next start wait or report "already running".
//
// A name that is taken but can't be asked (connecting is refused, as for the pipe of another Windows
// account's copy using the same data folder, or the holder keeps dropping the connection) ends the
// attempt with reason 'unreachable' instead of an error.
//
// `stop` (requestStop) uses the same endpoint the other way round: the running server must not quit
// for anyone who merely connects (another user on the PC, any program). The client asks with
// {challenge, stop: true}; the server answers as above plus a fresh random nonce and keeps the
// connection open; the client checks the server's proof and sends HMAC(secret, "stop\n" + nonce),
// which only someone who can read desktop.json can compute (the "stop\n" prefix keeps it apart from
// the server's own proofs, whose challenge is hex). Then the server answers {stopping: true} and
// quits like on Ctrl+C; the client waits until the name is free (the database closed). A server of a
// version before `stop` answers as to a second start (a valid proof, no nonce): 'old-version'. A
// connection dropped without an answer usually means the server is shutting down already (another
// `stop`, Quit): the client then also waits for the name.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** IPC name for the server of the database at `dbPath` (absolute). */
export function instancePipeName(dbPath: string, platform: NodeJS.Platform = process.platform, tmpdir: string = os.tmpdir()): string {
  // NTFS and APFS compare names case-insensitively: C:\Data and c:\data are one database.
  const key = platform === 'win32' || platform === 'darwin' ? dbPath.toLowerCase() : dbPath;
  const id = createHash('sha256').update(key).digest('hex').slice(0, 32);
  if (platform === 'win32') return `\\\\.\\pipe\\lyren-plan-${id}`;
  if (platform === 'linux') return `\0lyren-plan-${id}`;
  return path.join(tmpdir, `lyren-plan-${id}.sock`);
}

/**
 * The database path with symlinks / junctions, 8.3 short names and (on Windows) the real letter case
 * resolved, for the part of it that exists (on a first start the data folder doesn't yet).
 */
export function canonicalDbPath(dbPath: string): string {
  const abs = path.resolve(dbPath);
  const missing: string[] = [path.basename(abs)];
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), ...missing);
    } catch {
      if (path.dirname(dir) === dir) return abs;
      missing.unshift(path.basename(dir));
    }
  }
}

export function instanceProof(secret: string, challenge: string, url: string): string {
  return createHmac('sha256', secret).update(`${challenge}\n${url}`).digest('hex');
}

/** What a `stop` client proves: knowledge of the secret, for this connection's nonce. */
export function stopProof(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(`stop\n${nonce}`).digest('hex');
}

function proofMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

/**
 * How the running server shows itself, for a second start's message (serve.ts openRunning). Absent:
 * in its own console window (and from versions before the notification-area icon).
 */
export type InstanceMode = 'tray' | 'terminal';

export interface ReadyOptions {
  mode?: InstanceMode | undefined;
  /** A verified `stop` request (requestStop): quit as on Ctrl+C. */
  onStop?: () => void;
}

export interface HeldInstanceLock {
  /** Start answering other starts (now and later) with the server's address. */
  ready(url: string, options?: ReadyOptions): void;
  close(): void;
}

/**
 * Why another instance could not be used: it did not answer in time, its answer could not be
 * verified, or it could not be asked at all ('denied': connecting was refused, e.g. another Windows
 * account's pipe; 'unreachable': it kept dropping the connection).
 */
export type OtherInstance =
  | { url: string; mode?: InstanceMode }
  | { url: null; reason: 'timeout' | 'unverified' | 'denied' | 'unreachable' };

export type InstanceLockResult = { held: true; lock: HeldInstanceLock } | { held: false; other: OtherInstance };

export interface InstanceLockOptions {
  name: string;
  /** This server's secret (already written where readSecret finds it before ready()). */
  secret: string;
  /** Reads the running server's secret (from desktop.json), or null. */
  readSecret: () => string | null;
  /**
   * How long to wait for a server that is still starting up to answer (default 15 s; starting up
   * takes well under a second, longer only while a large database is migrated).
   */
  waitMs?: number;
  /** Called once when the answer takes longer than `noticeMs` (default 2 s), e.g. to say so. */
  onWaiting?: () => void;
  noticeMs?: number;
  /** How often to try to take or ask the name before giving up as 'unreachable' (default 20). */
  maxAttempts?: number;
}

const MAX_LINE = 1024;

/** Connecting was refused for lack of permission (another account's pipe on Windows). */
const isDenied = (err: NodeJS.ErrnoException) => err.code === 'EACCES' || err.code === 'EPERM';

function listen(name: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once('error', reject);
    server.listen(name, () => {
      server.off('error', reject);
      server.on('error', () => undefined);
      resolve(server);
    });
  });
}

type LineResult = { line: string } | { closed: true } | { timeout: true };

/** Reads lines (at most MAX_LINE characters each) from a socket, one request at a time. */
class SocketLines {
  private buf = '';
  private ended = false;
  private wake: (() => void) | null = null;

  constructor(socket: net.Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      this.wake?.();
    });
    const end = () => {
      this.ended = true;
      this.wake?.();
    };
    socket.once('end', end);
    socket.once('close', end);
    socket.once('error', end);
  }

  next(timeoutMs: number): Promise<LineResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
      const finish = (value: LineResult) => {
        clearTimeout(timer);
        this.wake = null;
        resolve(value);
      };
      const check = () => {
        const nl = this.buf.indexOf('\n');
        if (nl >= 0 && nl <= MAX_LINE) {
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          return finish({ line });
        }
        if (this.buf.length > MAX_LINE || this.ended) return finish({ closed: true });
      };
      this.wake = check;
      check();
    });
  }
}

/** Read one line from `socket` (at most MAX_LINE characters). */
function readLine(socket: net.Socket, timeoutMs: number): Promise<LineResult> {
  return new SocketLines(socket).next(timeoutMs);
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Ask = { kind: 'answer'; other: OtherInstance } | { kind: 'gone' } | { kind: 'stale' } | { kind: 'denied' };

function ask(name: string, readSecret: () => string | null, waitMs: number, notice: { ms: number; fn: () => void }): Promise<Ask> {
  return new Promise((resolve) => {
    const challenge = randomBytes(16).toString('hex');
    const socket = net.connect(name);
    socket.on('error', (err: NodeJS.ErrnoException) => {
      // A socket file left behind by a crashed server (only where names are files).
      resolve(err.code === 'ECONNREFUSED' ? { kind: 'stale' } : isDenied(err) ? { kind: 'denied' } : { kind: 'gone' });
    });
    socket.once('connect', () => {
      socket.write(JSON.stringify({ challenge }) + '\n');
      const slow = setTimeout(notice.fn, notice.ms);
      void readLine(socket, waitMs).then((result) => {
        clearTimeout(slow);
        socket.destroy();
        if ('closed' in result) return resolve({ kind: 'gone' });
        if ('timeout' in result) return resolve({ kind: 'answer', other: { url: null, reason: 'timeout' } });
        let msg: { url?: unknown; proof?: unknown; mode?: unknown };
        try {
          msg = JSON.parse(result.line) as typeof msg;
        } catch {
          resolve({ kind: 'answer', other: { url: null, reason: 'unverified' } });
          return;
        }
        const secret = readSecret();
        const url = typeof msg.url === 'string' ? msg.url : null;
        const verified = secret !== null && url !== null && /^https?:\/\//.test(url) && proofMatches(instanceProof(secret, challenge, url), msg.proof);
        const mode: { mode?: InstanceMode } = msg.mode === 'tray' || msg.mode === 'terminal' ? { mode: msg.mode } : {};
        resolve({ kind: 'answer', other: verified ? { url: url!, ...mode } : { url: null, reason: 'unverified' } });
      });
    });
  });
}

/**
 * Become the server for this database, or learn the address of the one that already is. Retries
 * when the holder disappears meanwhile (it was shutting down).
 */
export async function acquireInstanceLock(options: InstanceLockOptions): Promise<InstanceLockResult> {
  const { name, secret, readSecret, waitMs = 15_000, onWaiting, noticeMs = 2000, maxAttempts = 20 } = options;
  let url: string | null = null;
  let readyOptions: ReadyOptions = {};
  const waiting: Array<{ socket: net.Socket; lines: SocketLines; challenge: string; stop: boolean }> = [];
  const connections = new Set<net.Socket>();
  const answerLine = (challenge: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      app: 'lyren-plan',
      url,
      proof: instanceProof(secret, challenge, url!),
      ...(readyOptions.mode ? { mode: readyOptions.mode } : {}),
      ...extra,
    }) + '\n';
  const answer = (socket: net.Socket, lines: SocketLines, challenge: string, stop: boolean) => {
    if (!stop) {
      socket.end(answerLine(challenge));
      return;
    }
    // A stop request: the client proves the secret for this nonce before anything happens.
    const nonce = randomBytes(16).toString('hex');
    socket.write(answerLine(challenge, { nonce }));
    void lines.next(waitMs).then((result) => {
      const proof = 'line' in result ? parseJson(result.line)?.stop : undefined;
      if (!proofMatches(stopProof(secret, nonce), proof) || !readyOptions.onStop) {
        socket.end(JSON.stringify({ stopping: false }) + '\n');
        return;
      }
      socket.end(JSON.stringify({ stopping: true }) + '\n');
      readyOptions.onStop();
    });
  };
  const onConnection = (socket: net.Socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(waitMs, () => socket.destroy());
    const lines = new SocketLines(socket);
    void lines.next(waitMs).then((result) => {
      const request = 'line' in result ? parseJson(result.line) : null;
      const challenge = request?.challenge;
      if (typeof challenge !== 'string' || !/^[0-9a-f]{16,128}$/.test(challenge)) {
        socket.destroy();
        return;
      }
      const stop = request?.stop === true;
      if (url) answer(socket, lines, challenge, stop);
      else waiting.push({ socket, lines, challenge, stop });
    });
  };

  let noticed = false;
  const notice = {
    ms: noticeMs,
    fn: () => {
      if (noticed) return;
      noticed = true;
      onWaiting?.();
    },
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const server = await listen(name, onConnection);
      return {
        held: true,
        lock: {
          ready(address, options = {}) {
            url = address;
            readyOptions = options;
            for (const w of waiting.splice(0)) answer(w.socket, w.lines, w.challenge, w.stop);
          },
          close() {
            server.close();
            // Clients still waiting for an address see the connection close and try again.
            waiting.length = 0;
            for (const socket of connections) socket.destroy();
          },
        },
      };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Windows reports a pipe name another account holds as EADDRINUSE or EACCES.
      if (isDenied(e)) return { held: false, other: { url: null, reason: 'denied' } };
      if (e.code !== 'EADDRINUSE') throw err;
      if (attempt + 1 >= maxAttempts) return { held: false, other: { url: null, reason: 'unreachable' } };
    }
    const result = await ask(name, readSecret, waitMs, notice);
    if (result.kind === 'answer') return { held: false, other: result.other };
    if (result.kind === 'denied') return { held: false, other: { url: null, reason: 'denied' } };
    if (result.kind === 'stale' && !name.startsWith('\0') && !name.startsWith('\\\\')) {
      try {
        fs.unlinkSync(name);
      } catch {
        /* someone else removed it */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---- stop --------------------------------------------------------------------------------------

export type StopResult =
  /**
   * Asked, verified, and the server has released the database; or it dropped the connection while it
   * was shutting down anyway (another `stop`, Quit) and released it then (url null when it had not
   * answered yet).
   */
  | { result: 'stopped'; url: string | null }
  /** Nothing holds the name. */
  | { result: 'not-running' }
  /** Connecting was refused for lack of permission (another Windows account's copy). */
  | { result: 'denied' }
  /** desktop.json has no secret this user can read: the request can't be made. */
  | { result: 'no-secret' }
  /** Something holds the name but could not prove to be this database's server. */
  | { result: 'unverified' }
  /** A verified server of a version without `stop` (its answer has no nonce). */
  | { result: 'old-version'; url: string }
  /** No answer in time (a server still starting up, or hanging). */
  | { result: 'no-answer' }
  /** The server did not accept the request. */
  | { result: 'refused'; url: string }
  /** The server agreed, but still holds the name after stopWaitMs. */
  | { result: 'still-running'; url: string };

export interface StopOptions {
  name: string;
  /** The running server's secret (desktop.json), or null. */
  readSecret: () => string | null;
  /** How long to wait for each answer (default 15 s). */
  waitMs?: number;
  /** How long to wait for the server to finish after it agreed (default 15 s). */
  stopWaitMs?: number;
}

/** Connects to `name`; null when nothing listens there, 'denied' when connecting is not permitted. */
function connectTo(name: string): Promise<net.Socket | 'denied' | null> {
  return new Promise((resolve) => {
    const socket = net.connect(name);
    socket.once('connect', () => resolve(socket));
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(isDenied(err) ? 'denied' : null));
  });
}

async function nameInUse(name: string): Promise<boolean> {
  const socket = await connectTo(name);
  if (socket instanceof net.Socket) socket.destroy();
  return socket !== null;
}

/** Whether `name` is free within `ms` (the server closes the database, then the name, then exits). */
async function nameReleased(name: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!(await nameInUse(name))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Ask the server holding `name` to quit (the `stop` command), proving knowledge of its secret. */
export async function requestStop({ name, readSecret, waitMs = 15_000, stopWaitMs = 15_000 }: StopOptions): Promise<StopResult> {
  const socket = await connectTo(name);
  if (socket === null) return { result: 'not-running' };
  if (socket === 'denied') return { result: 'denied' };
  socket.on('error', () => undefined);
  const secret = readSecret();
  if (secret === null) {
    socket.destroy();
    return { result: 'no-secret' };
  }
  const lines = new SocketLines(socket);
  const challenge = randomBytes(16).toString('hex');
  socket.write(JSON.stringify({ challenge, stop: true }) + '\n');
  const first = await lines.next(waitMs);
  if (!('line' in first)) {
    socket.destroy();
    // Dropped without an answer: a server that is shutting down (another `stop`, Quit) closes every
    // connection; it is stopped once the name is free.
    if ('closed' in first && (await nameReleased(name, stopWaitMs))) return { result: 'stopped', url: null };
    return { result: 'no-answer' };
  }
  const msg = parseJson(first.line);
  const url = typeof msg?.url === 'string' && /^https?:\/\//.test(msg.url) ? msg.url : null;
  if (url === null || !proofMatches(instanceProof(secret, challenge, url), msg?.proof)) {
    socket.destroy();
    return { result: 'unverified' };
  }
  // A genuine server that ignored `stop: true`: a version before the stop command.
  const nonce = typeof msg?.nonce === 'string' && /^[0-9a-f]{32}$/.test(msg.nonce) ? msg.nonce : null;
  if (nonce === null) {
    socket.destroy();
    return { result: 'old-version', url };
  }
  socket.write(JSON.stringify({ stop: stopProof(secret, nonce) }) + '\n');
  const second = await lines.next(waitMs);
  socket.destroy();
  if ('line' in second && parseJson(second.line)?.stopping !== true) return { result: 'refused', url };
  // No answer: the connection was closed (or timed out) after the proof was sent. That happens
  // when the server is already shutting down (another `stop`, Quit) and releases the name: wait
  // for that as for a "yes", and count it as refused only if the server keeps running.
  const answered = 'line' in second;
  if (await nameReleased(name, stopWaitMs)) return { result: 'stopped', url };
  return answered ? { result: 'still-running', url } : { result: 'refused', url };
}
