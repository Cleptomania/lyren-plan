// Downloads that need the re-auth window (design §5.4.4): a space's export, the instance backup. They
// are plain GET links the browser follows with the session cookie, so a refusal cannot be answered
// with the password and sent again: the window is checked (and the password asked for) first.

import { ensureReauth } from '../account/ReauthDialog';

/** Start the browser's download of `url` (a plain GET; the browser sends the session cookie). */
export function startDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

/** Ask for the password when the window is closed, then download; nothing when it was cancelled. */
export async function downloadWithReauth(url: string): Promise<void> {
  if (await ensureReauth()) startDownload(url);
}
