// Type settings for the Cloudflare runtime (tsconfig.worker.json loads @cloudflare/workers-types and
// @types/node together; skipLibCheck hides their clashes inside the packages).
//
// The clashes that reach our code:
// - workers-types declares a global `Buffer: any`, so the type checker no longer sees @types/node's
//   Buffer methods on Buffers that node:crypto and friends return (`randomBytes(8).toString('hex')`
//   fails with "Expected 0 arguments"). Code that compiles for the Worker therefore encodes bytes with
//   core/crypto.ts (toHex, toBase64, toBase64Url, fromBase64Url).
// - The global TextDecoder takes { fatal, ignoreBOM } with both set, and node:stream's web streams
//   (Readable.toWeb) are not the global ReadableStream type (Node-only code casts through unknown).

/** `env` from 'cloudflare:workers' (and the default Env of DurableObject) is the Worker's Env. */
declare namespace Cloudflare {
  type WorkerEnv = import('./env').Env;
  interface Env extends WorkerEnv {}
}
