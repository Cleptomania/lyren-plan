// What a runtime tells the runtime-neutral apps about itself (design §2.3).

export interface RuntimeInfo {
  kind: 'node' | 'cloudflare';
  capabilities: {
    /** GET /api/admin/backup (Node, unless ALLOW_ADMIN_BACKUP_DOWNLOAD=false). */
    backupDownload: boolean;
    /** VACUUM INTO snapshots (Node). */
    fileSnapshots: boolean;
  };
}

/** ms epoch. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Work that may finish after the response: CF ctx.waitUntil; Node catches and logs. */
export type Defer = (task: Promise<unknown>) => void;
