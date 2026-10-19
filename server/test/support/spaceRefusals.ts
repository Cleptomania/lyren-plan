// What a space request gets when its session may not open the space, on both runtimes (design §13.2,
// Appendix D 28 and 39): the same answers whether the space exists or not, so that none reveals it. The
// Node stack test (server/test/runtime/stack.test.ts) and the Cloudflare one (server/test-workers/do.test.ts)
// compare their answers with these.

/** No session, or one the directory does not know. */
export const UNKNOWN_SESSION = { status: 401, body: { error: { code: 'unauthorized', message: 'Not signed in' } } };

/** A session whose account may not open the space (not a member, or no such space). */
export const NOT_A_MEMBER = { status: 404, body: { error: { code: 'not_found', message: 'Space not found' } } };
