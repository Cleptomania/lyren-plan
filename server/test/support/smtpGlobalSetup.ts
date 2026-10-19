// The workers project's global setup (vitest.config.ts): fake SMTP servers in Node on 127.0.0.1 for the
// SMTP client's tests in workerd (server/test-workers/smtp.test.ts), which reach them through
// cloudflare:sockets, plus an HTTP server that reports what each received. Certificates are made at
// test time in a temporary folder (support/testCerts.ts) and removed at teardown; without openssl the TLS
// scenarios are left out. Their authority reaches workerd as a network service binding's trusted
// certificate (vitest.config.ts), since the platform's own outbound connections trust only the public
// authorities.

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestProject } from 'vitest/node';
import { startFakeSmtp, type FakeSmtpServer } from './fakeSmtp';
import { FIXTURE_PASS, FIXTURE_USER, type SmtpFixture, type SmtpScenario } from './smtpFixture';
import { makeTestCerts, missingOpenssl, type TestCerts } from './testCerts';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const skipTls = missingOpenssl();
  const certs: TestCerts | null = skipTls === null ? makeTestCerts() : null;
  const servers = new Map<SmtpScenario, FakeSmtpServer>();
  const start = async (name: SmtpScenario, o: Parameters<typeof startFakeSmtp>[0]) => servers.set(name, await startFakeSmtp(o));

  await start('plain', {});
  await start('split', { chunkBytes: 3, capabilities: Array.from({ length: 60 }, (_, i) => `X-CAPABILITY-${i} with parameters`) });
  await start('slow', { delays: { GREETING: 3_000 } });
  await start('rcpt550', { replies: { RCPT: '550 5.1.1 <alice@example.com>: Recipient address rejected' } });
  if (certs) {
    const tls = { key: certs.key, cert: certs.cert };
    const credentials = { user: FIXTURE_USER, pass: FIXTURE_PASS };
    await start('starttls', { tls, credentials });
    await start('implicit', { mode: 'implicit', tls, auth: ['LOGIN'], credentials });
    await start('auth535', { tls, credentials: { user: FIXTURE_USER, pass: 'another' }, replies: { AUTH: `535 5.7.8 Bad credentials ${FIXTURE_PASS}` } });
    await start('inject', { tls, afterStartTls: '250-fake.example\r\n250 AUTH PLAIN\r\n' });
    await start('otherHost', { mode: 'implicit', tls: { key: certs.otherKey, cert: certs.otherCert } });
  }

  const control = http.createServer((req, res) => {
    const server = servers.get((req.url ?? '/').slice(1) as SmtpScenario);
    res.writeHead(server ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(server?.sessions ?? null));
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));

  const fixture: SmtpFixture = {
    ports: Object.fromEntries([...servers].map(([name, s]) => [name, s.port])),
    control: (control.address() as AddressInfo).port,
    ca: certs?.ca ?? null,
    skipTls,
  };
  project.provide('smtp', fixture);

  return async () => {
    await new Promise<void>((resolve) => control.close(() => resolve()));
    for (const s of servers.values()) await s.close();
    if (certs) fs.rmSync(certs.dir, { recursive: true, force: true });
  };
}
