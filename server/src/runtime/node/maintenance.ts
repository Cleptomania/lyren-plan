// The hourly upkeep on Node (design §9.8): the directory's maintenance (expired sessions, tokens and
// throttle rows, old security events and invitations, the purge of deleted spaces, …) and then closing
// the space databases nobody used for 10 minutes. The timer is unref'd, so it never keeps the process
// alive, and a failed run is logged and tried again an hour later.

const HOUR_MS = 60 * 60 * 1000;

/** Run `maintenance` every hour until the returned function is called. */
export function startMaintenance(maintenance: () => Promise<void>, intervalMs = HOUR_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    // An hour is plenty, but a run never overlaps the previous one.
    if (running) return;
    running = true;
    maintenance()
      .catch((err: unknown) => console.error('[lyren] Maintenance failed:', err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
