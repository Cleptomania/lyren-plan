// The owner check (design §9.2). A maintenance command that root runs by mistake on another user's data
// would create or replace files (a restore, the temporaries of a backup, the files of an upgrade) owned by
// root with mode 0600, and the service would then fail with "unable to open database file". So the
// server, the desktop app and every CLI command stop before they touch any file when they run as root
// and the data folder (the folder of DB_PATH) belongs to another user. Windows has no uids: no check.

import fs from 'node:fs';

export interface OwnerCheckOptions {
  /** The process's uid (tests); default process.getuid(), undefined on Windows. */
  uid?: number;
  /** Where user names are looked up (tests); default /etc/passwd. */
  passwdFile?: string;
}

/** The name of `uid` in the passwd file, else `#<uid>` (which sudo -u also takes). */
function userName(uid: number, passwdFile: string): string {
  try {
    for (const line of fs.readFileSync(passwdFile, 'utf8').split('\n')) {
      const [name, , id] = line.split(':');
      if (name && id !== undefined && /^\d+$/.test(id) && Number(id) === uid) return name;
    }
  } catch {
    // Not readable: the number then.
  }
  return `#${uid}`;
}

/**
 * Why this process must not touch the data folder `folder` (§9.2), or null. A folder that does not
 * exist yet is created by whoever runs first, as before.
 */
export function ownerRefusal(folder: string, o: OwnerCheckOptions = {}): string | null {
  const uid = 'uid' in o ? o.uid : process.getuid?.();
  if (uid !== 0) return null;
  let owner: number;
  try {
    owner = fs.statSync(folder).uid;
  } catch {
    return null;
  }
  if (owner === 0) return null;
  return `Run this as the owner of ${folder}, for example: sudo -u ${userName(owner, o.passwdFile ?? '/etc/passwd')} …`;
}
