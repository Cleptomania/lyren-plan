// Fetch Metadata for the downloads (design §13.4): the instance backup and a space's export are GETs, which the
// CSRF header does not cover (a browser download cannot send it), and each is expensive to build. Without a
// further check a browser would build one for every `![](/api/…)` in a task's Markdown that a signed-in owner or
// admin looks at, or for a link on another site. Browsers set Sec-Fetch-Site and Sec-Fetch-Dest themselves (no
// page can), so a download is answered only for a same-origin (or typed, `none`) navigation or fetch. A request
// without them (an older browser, a script with its own cookie) goes on as before: the trick needs a browser.

import { forbidden } from './errors';

/** What a download link, a typed address and the client's fetch send as Sec-Fetch-Dest. */
const DOWNLOAD_DESTS: ReadonlySet<string> = new Set(['document', 'empty']);
const DOWNLOAD_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

/** 403 when the browser says this request is an image, a frame or the like, or came from another site. */
export function assertDownloadRequest(headers: { header(name: string): string | undefined }): void {
  const site = headers.header('Sec-Fetch-Site');
  const dest = headers.header('Sec-Fetch-Dest');
  if ((site !== undefined && !DOWNLOAD_SITES.has(site)) || (dest !== undefined && !DOWNLOAD_DESTS.has(dest))) {
    throw forbidden('Start this download from Lyren Plan.');
  }
}
