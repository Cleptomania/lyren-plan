// The import gate (design §8.4): one import (an analyze or a commit) at a time, a second one refused with 503
// while the first runs. Node keeps one gate for the whole process, because a parse can need hundreds of MB;
// Cloudflare one per space object, because a commit reads the space and awaits the directory before it writes,
// and two commits into one space would both find it as it was (the idempotent retry's check, the rows they
// delete), write twice and reserve too little (Appendix D 62).

import type { Deps } from '../env';
import { unavailable } from '../http/errors';

export type ImportGate = Deps['space']['importGate'];

/** A gate that runs one import at a time and refuses another meanwhile with `busyMessage` (503 unavailable). */
export function createImportGate(busyMessage: string): ImportGate {
  let busy = false;
  return {
    async run(fn) {
      if (busy) throw unavailable(busyMessage);
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    },
  };
}
