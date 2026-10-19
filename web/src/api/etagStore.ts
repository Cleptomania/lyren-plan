// The conditional-read memory of the API client (design §6.4.2, §12.3): for each space read (a GET, or
// POST /tasks/query) the last answer's ETag and body, in memory only. The client sends the ETag as
// If-None-Match, and a 304 resolves with the stored body, so an unchanged board, dashboard or bootstrap
// costs the server one row at most and the network no body. Bounded by entries and by the size of the
// stored JSON text, least recently used first out. Cleared with the rest of the user's data
// (forgetUserData) and per space when a space is left or lost (forgetSpace, retainSpaces). A read
// still in flight at that moment must not put its answer back: the client takes a mark() before
// sending, and set() with that mark stores nothing once the space (or everything) was forgotten since.

/** At most this many answers… */
export const ETAG_MAX_ENTRIES = 200;
/** …and this much JSON text in all (characters; a single larger answer is not kept). */
export const ETAG_MAX_CHARS = 20 * 1024 * 1024;

export interface EtagEntry {
  etag: string;
  /** The answer's JSON text, parsed anew for every 304 (callers may change what they get). */
  text: string;
}

/** The key of a space read: method, URL (with the space id and the query) and, for a POST, the body. */
export function etagKey(method: string, url: string, body?: string): string {
  return body === undefined ? `${method} ${url}` : `${method} ${url}\n${body}`;
}

/**
 * Whether two entity tags name the same answer, as the server compares If-None-Match (weakly, RFC 9110
 * §13.1.2, Appendix D 23): a W/ prefix is ignored, since Node's compression turns the gate's strong tag
 * into a weak one.
 */
export function sameEtag(a: string, b: string): boolean {
  const strip = (tag: string) => (tag.startsWith('W/') ? tag.slice(2) : tag);
  return strip(a.trim()) === strip(b.trim());
}

/** The space of a key ('GET /api/s/<id>/bootstrap' → id), null for any other URL. */
function spaceOfEtagKey(key: string): string | null {
  return /^\S+ \/api\/s\/([^/?\s]+)\//.exec(key)?.[1] ?? null;
}

/** Taken before a request (EtagStore.mark): what set() compares to store the answer, or not. */
export type EtagMark = number;

export interface EtagStore {
  get(key: string): EtagEntry | undefined;
  /** Before the request of `key` leaves: its answer may be stored with set(key, entry, mark). */
  mark(key: string): EtagMark;
  /** Keep `entry`; with a `mark`, only when nothing of the key's space was forgotten since it was taken. */
  set(key: string, entry: EtagEntry, mark?: EtagMark): void;
  delete(key: string): void;
  /** Drop every entry of one space (its URLs start with /api/s/<spaceId>/). */
  forgetSpace(spaceId: string): void;
  /** Drop every entry of the spaces not listed (the account's spaces now), cached or in flight. */
  retainSpaces(spaceIds: readonly string[]): void;
  clear(): void;
  readonly size: number;
  /** Characters of JSON text held. */
  readonly chars: number;
}

export function createEtagStore(limits: { maxEntries: number; maxChars: number } = { maxEntries: ETAG_MAX_ENTRIES, maxChars: ETAG_MAX_CHARS }): EtagStore {
  // A Map keeps insertion order: re-inserting on use makes the first key the least recently used.
  const entries = new Map<string, EtagEntry>();
  let chars = 0;
  const cost = (key: string, entry: EtagEntry) => key.length + entry.etag.length + entry.text.length;
  // The current mark of each space requested ('' for keys of no space). Forgetting a space deletes its
  // mark, and marks are never issued twice, so a mark taken before no longer matches.
  const marks = new Map<string, EtagMark>();
  let issued = 0;
  const markOf = (key: string) => spaceOfEtagKey(key) ?? '';

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    chars -= cost(key, entry);
  };
  const forget = (spaceId: string) => {
    for (const key of [...entries.keys()]) if (spaceOfEtagKey(key) === spaceId) remove(key);
    marks.delete(spaceId);
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry;
    },
    mark(key) {
      const id = markOf(key);
      let mark = marks.get(id);
      if (mark === undefined) {
        mark = ++issued;
        marks.set(id, mark);
      }
      return mark;
    },
    set(key, entry, mark) {
      if (mark !== undefined && marks.get(markOf(key)) !== mark) return;
      remove(key);
      const size = cost(key, entry);
      if (size > limits.maxChars) return;
      entries.set(key, entry);
      chars += size;
      for (const oldest of entries.keys()) {
        if (entries.size <= limits.maxEntries && chars <= limits.maxChars) break;
        remove(oldest);
      }
    },
    delete: remove,
    forgetSpace: forget,
    retainSpaces(spaceIds) {
      const keep = new Set(spaceIds);
      const lost = new Set([...marks.keys(), ...[...entries.keys()].map(markOf)]);
      for (const id of lost) if (id !== '' && !keep.has(id)) forget(id);
    },
    clear() {
      entries.clear();
      chars = 0;
      marks.clear();
    },
    get size() {
      return entries.size;
    },
    get chars() {
      return chars;
    },
  };
}
