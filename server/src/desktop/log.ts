// The Windows app's log file, logs\lyren-plan.log next to the database (files.ts), written while the
// notification-area icon is in use (tray and terminal mode, mode.ts): without a console window it is
// the only place for the banner, warnings, errors and (LOG_REQUESTS) the request log. Each line gets
// a local time stamp. At MAX_LOG_BYTES the file becomes lyren-plan.1.log (replacing the previous one)
// and a new one starts, so the two never take more than twice that. Writing never throws: a log that
// can't be written is just not written.
//
// The log is plain text for Notepad and for bug reports: colour escapes (Hono's request logger) are
// removed, and secrets registered with redact() (the setup code) are replaced by REDACTED.
//
// captureOutput() sends everything the app prints (console.*, Hono's request logger) to the log, in
// terminal mode also to the console as before, and keeps what went to stderr for message boxes.
// Until the data folder exists (logs/ is created in it) lines wait in memory.

import fs from 'node:fs';
import path from 'node:path';

export const LOG_FILE_NAME = 'lyren-plan.log';
export const OLD_LOG_FILE_NAME = 'lyren-plan.1.log';
/** What a redacted secret reads as in the log. */
export const REDACTED = '[not in the log]';
/** ANSI escape sequences (SGR colours and other CSI sequences). */
const ANSI_ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The rotated file's name: lyren-plan.log -> lyren-plan.1.log, work.db.log -> work.db.1.log. */
export function oldLogName(name: string): string {
  return name.endsWith('.log') ? `${name.slice(0, -4)}.1.log` : `${name}.1`;
}
export const MAX_LOG_BYTES = 1024 * 1024;
/** Lines kept in memory before the log file is open. */
const MAX_PENDING = 256 * 1024;

/** "2026-10-15 14:03:12 " in local time. */
export function timestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} `;
}

export interface LogFileOptions {
  maxBytes?: number;
  now?: () => Date;
}

export class LogFile {
  /** The log file's path once open, else null. */
  file: string | null = null;
  private fd: number | null = null;
  private size = 0;
  private pending = '';
  private atLineStart = true;
  private secrets: string[] = [];
  private failed = false;
  private readonly maxBytes: number;
  private readonly now: () => Date;

  constructor(options: LogFileOptions = {}) {
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  /** Start writing to <dir>/<name> (creating dir), with what was written before. Returns whether it is open. */
  open(dir: string, name: string = LOG_FILE_NAME): boolean {
    if (this.fd !== null) return true;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.file = path.join(dir, name);
      this.fd = fs.openSync(this.file, 'a', 0o600);
      this.size = fs.fstatSync(this.fd).size;
    } catch {
      this.file = null;
      this.fd = null;
      this.failed = true;
      this.pending = '';
      return false;
    }
    const pending = this.pending;
    this.pending = '';
    if (pending) this.append(pending);
    return true;
  }

  /** Never write `secret` (e.g. the setup code); it reads as REDACTED from now on. */
  redact(secret: string): void {
    if (secret.length >= 4 && !this.secrets.includes(secret)) this.secrets.push(secret);
  }

  /** Write text as printed (lines get a time stamp when they start). */
  write(printed: string): void {
    if (this.failed || printed === '') return;
    let text = printed.replace(ANSI_ESCAPES, '');
    for (const secret of this.secrets) text = text.replaceAll(secret, REDACTED);
    if (text === '') return;
    let stamped = '';
    for (const part of text.split(/(?<=\n)/)) {
      if (this.atLineStart) stamped += timestamp(this.now());
      stamped += part;
      this.atLineStart = part.endsWith('\n');
    }
    if (this.fd === null) {
      this.pending = (this.pending + stamped).slice(-MAX_PENDING);
      return;
    }
    this.append(stamped);
  }

  /** One line of its own (e.g. from the tray), not printed anywhere else. */
  note(line: string): void {
    this.write(`${this.atLineStart ? '' : '\n'}${line}\n`);
  }

  close(): void {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
    this.fd = null;
  }

  private append(text: string): void {
    const bytes = Buffer.from(text, 'utf8');
    if (this.size > 0 && this.size + bytes.length > this.maxBytes) this.rotate();
    if (this.fd === null) return;
    try {
      fs.writeSync(this.fd, bytes);
      this.size += bytes.length;
    } catch {
      /* disk full, or removed drive: keep running */
    }
  }

  /** lyren-plan.log -> lyren-plan.1.log, then a new lyren-plan.log; when that fails, start the file over. */
  private rotate(): void {
    const file = this.file!;
    this.close();
    try {
      fs.renameSync(file, path.join(path.dirname(file), oldLogName(path.basename(file))));
      this.fd = fs.openSync(file, 'a', 0o600);
    } catch {
      try {
        this.fd = fs.openSync(file, 'w', 0o600);
      } catch {
        this.fd = null;
        this.failed = true;
        return;
      }
    }
    this.size = 0;
  }
}

export interface OutputCapture {
  /** What was written to stderr since the capture started (for message boxes). */
  stderrText(): string;
  /** Everything written to stdout and stderr since the capture started, in order (a command's output). */
  allText(): string;
  restore(): void;
}

type Write = typeof process.stdout.write;

/**
 * Send process.stdout and process.stderr to `log`; with `echo` also to where they went before (a
 * console). Keeps the last `keep` characters of stderr, and of both together.
 */
export function captureOutput(log: LogFile, { echo, keep = 8000 }: { echo: boolean; keep?: number }): OutputCapture {
  let errText = '';
  let allText = '';
  const wrap = (stream: NodeJS.WriteStream, isErr: boolean) => {
    const original = stream.write;
    const write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      log.write(text);
      if (isErr) errText = (errText + text).slice(-keep);
      allText = (allText + text).slice(-keep);
      if (echo) return (original as (...a: unknown[]) => boolean).call(stream, chunk, encoding, callback);
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') process.nextTick(done as () => void);
      return true;
    }) as Write;
    stream.write = write;
    return () => {
      stream.write = original;
    };
  };
  const restoreOut = wrap(process.stdout, false);
  const restoreErr = wrap(process.stderr, true);
  return {
    stderrText: () => errText,
    allText: () => allText,
    restore: () => {
      restoreOut();
      restoreErr();
    },
  };
}
