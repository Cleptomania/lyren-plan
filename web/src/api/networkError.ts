// What to say when the server can't be reached. For a Lyren Plan on this computer (the desktop
// app, opened from a bookmark or as an installed app) the usual reason is that it isn't running
// (it was quit, or its window was closed), not the network: so on a loopback address the advice is
// to start it. Elsewhere it is the connection.

/** Whether `hostname` (location.hostname) is this computer: localhost, 127.x.x.x or [::1]. */
export function isLoopbackHost(hostname: string): boolean {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i.test(hostname);
}

export interface UnreachableText {
  /** Heading of an error placeholder. */
  title: string;
  /** Its explanation. */
  body: string;
  /** Both as one sentence, e.g. for a form error or a toast. */
  message: string;
}

const LOCAL: UnreachableText = {
  title: 'Can’t reach Lyren Plan',
  body: 'If Lyren Plan runs on this computer, start it again (it must keep running while you use it), then try again.',
  message: 'Can’t reach Lyren Plan. If it runs on this computer, start it again (it must keep running while you use it), then try again.',
};

const REMOTE: UnreachableText = {
  title: 'Can’t reach the server',
  body: 'Check your connection and try again.',
  message: 'Can’t reach the server. Check your connection and try again.',
};

function currentHostname(): string {
  return typeof location === 'undefined' ? '' : location.hostname;
}

/** Whether this page was loaded from this computer (see isLoopbackHost). */
export function servedFromThisComputer(): boolean {
  return isLoopbackHost(currentHostname());
}

/** The "can't reach the server" text for the page's own address (or `hostname`). */
export function unreachableText(hostname: string = currentHostname()): UnreachableText {
  return isLoopbackHost(hostname) ? LOCAL : REMOTE;
}
