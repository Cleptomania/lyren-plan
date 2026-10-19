// A transport-level check of how the Worker refuses an oversize body (design Appendix D 45), for a running
// `npm run dev:cf` (or any local origin): `node scripts/cf/oversize-check.mjs [origin]`, by default
// http://127.0.0.1:8787. The tests reach the Worker without a socket (SELF.fetch), so they cannot see what
// this sees: each refusal must answer 413, and the next request on the same connection must still work.
// It sends POST /api/auth/login with bodies past AUTH_BODY_LIMIT and BODY_LIMIT, on fresh connections and on
// one kept-alive connection, each followed by GET /api/health. Exit status 1 when any answer is wrong.

import http from 'node:http';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:8787');
const SIZES = [64 * 1024 + 1, 2 * 1024 * 1024 + 1, 8 * 1024 * 1024];

/** One request; resolves with its status (or the socket error), never rejects. */
function send(method, path, body, agent) {
  return new Promise((resolve) => {
    const headers = { Host: origin.host, 'X-Lyren-Request': '1' };
    if (body) Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    let answered = false;
    const req = http.request({ host: origin.hostname, port: origin.port || 80, method, path, headers, agent }, (res) => {
      answered = true;
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    // The server may answer and close before the whole body is written: only a missing answer is a failure.
    req.on('error', (err) => {
      if (!answered) resolve(`error ${err.code ?? err.message}`);
    });
    req.end(body);
  });
}

let failures = 0;
for (const [label, agent] of [
  ['fresh connections', new http.Agent({ keepAlive: false })],
  ['one kept-alive connection', new http.Agent({ keepAlive: true, maxSockets: 1 })],
]) {
  for (const size of SIZES) {
    const refused = await send('POST', '/api/auth/login', Buffer.alloc(size, 0x20), agent);
    const next = await send('GET', '/api/health', null, agent);
    const ok = refused === 413 && next === 200;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}, ${size} bytes: ${refused} (413 expected), then GET /api/health: ${next} (200 expected)`);
  }
  agent.destroy();
}
console.log(failures === 0 ? 'Every oversize body was refused cleanly.' : `${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
