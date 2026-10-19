// Links an inviter or an administrator passes on to someone else (design §5.8.8 step 7, §5.8.11): an
// invitation's or a reset link, handed out when the instance sends no mail. The server builds them from
// PUBLIC_URL or the desktop app's LAN addresses (InstanceInfoDTO.shareOrigins); without any it answers the
// path alone (`/invite#t=…`), which gets this page's origin. Several origins (a desktop app on several
// networks) give a choice; a loopback origin works only on this computer, which the page says. Pure, so it
// is unit-tested (shareLinks.test.ts).

/** The link made absolute: as the server built it, else at this page's origin. */
export function absoluteLink(link: string, pageOrigin: string): string {
  return link.startsWith('/') ? `${pageOrigin}${link}` : link;
}

/** The origins a copied link can point at: the instance's share origins, else this page's own. */
export function linkOrigins(shareOrigins: readonly string[], pageOrigin: string): string[] {
  return shareOrigins.length > 0 ? [...shareOrigins] : [pageOrigin];
}

/** The same link at another origin (its path, query and fragment kept). */
export function linkAt(link: string, origin: string): string {
  const url = new URL(link);
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** The warning for a link that only works on this computer (a loopback host), else null. */
export function loopbackWarning(link: string): string | null {
  let host: string;
  try {
    host = new URL(link).hostname;
  } catch {
    return null;
  }
  return LOOPBACK.test(host) ? 'This link works only on this computer. Set PUBLIC_URL, or start the app with --lan.' : null;
}
