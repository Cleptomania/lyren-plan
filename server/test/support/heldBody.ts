// A request body that arrives only when the test releases it, as from a client that sends its headers
// at once and its body later: the server waits in its body read meanwhile, and other requests run
// (design §5: a handler must read the state it acts on after such an await).

export interface HeldBody {
  stream: ReadableStream<Uint8Array>;
  /** Headers that say what arrives: JSON (or the type given), and its Content-Length unless `chunked`. */
  headers: Record<string, string>;
  release(): void;
}

export function heldBody(json: unknown, o: { chunked?: boolean } = {}): HeldBody {
  return heldBytes(new TextEncoder().encode(JSON.stringify(json)), 'application/json', o);
}

/** The same for any bytes (an import's multipart form) of `contentType`. */
export function heldBytes(bytes: Uint8Array, contentType: string, o: { chunked?: boolean } = {}): HeldBody {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await released;
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (!o.chunked) headers['Content-Length'] = String(bytes.byteLength);
  return { stream, headers, release };
}

/** Let requests that were started run up to their next real wait. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
