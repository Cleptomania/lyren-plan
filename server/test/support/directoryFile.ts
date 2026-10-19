// A directory database on disk for the maintenance commands' tests (design §14.3): migrate(DIRECTORY)
// and one account from before the upgrade, signed in by the username `owner` (no email, no space), so
// the reset-password tests keep their command lines.

import { DatabaseSync } from 'node:sqlite';
import { randomToken } from '../../src/core/crypto';
import { migrate } from '../../src/core/migrate';
import { systemClock } from '../../src/core/runtime';
import { APP_VERSION } from '../../src/core/version';
import { PasswordHasher } from '../../src/directory/passwords';
import { DIRECTORY_MIGRATIONS } from '../../src/directory/schema';
import { NodeDb, sqlitePath } from '../../src/runtime/node/nodeDb';

const hasher = new PasswordHasher({ target: { kdf: 'scrypt', scryptP: 1 }, clock: systemClock });

export const hashPassword = (password: string): Promise<string> => hasher.hash(password);

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return (await hasher.verify(password, hash)).ok;
}

/** Create the directory database `file` holding the account `owner` with `password`; returns the hash. */
export async function directoryWithOwner(file: string, password = 'original-password'): Promise<string> {
  const hash = await hashPassword(password);
  const db = new NodeDb(file);
  try {
    migrate(db, DIRECTORY_MIGRATIONS, { appVersion: APP_VERSION });
    const t = new Date().toISOString();
    db.run(
      `INSERT INTO users (username, display_name, password_hash, password_changed_at, webauthn_user_id, is_instance_admin,
         created_at, updated_at)
       VALUES ('owner', 'Owner', :hash, :t, :handle, 1, :t, :t)`,
      { hash, t, handle: randomToken(32) },
    );
  } finally {
    db.close();
  }
  return hash;
}

/** The stored password hash of `owner`, read without opening the file for writing. */
export function ownerPasswordHash(file: string): string {
  const db = new DatabaseSync(sqlitePath(file), { readOnly: true });
  try {
    return (db.prepare("SELECT password_hash FROM users WHERE username = 'owner'").get() as { password_hash: string }).password_hash;
  } finally {
    db.close();
  }
}
