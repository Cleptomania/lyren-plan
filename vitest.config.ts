import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import type {} from './server/test/support/smtpFixture';

// Two projects (design §14.4): 'node' is the existing suite (NodeDb's portability checks are on,
// since vitest sets VITEST); 'workers' runs server/test-workers inside workerd through the Cloudflare
// plugin, configured by server/test-workers/wrangler.test.jsonc. Both run offline.
//
// A passing 'workers' run prints five lines of workerd's own, which tests expect (design Appendix D 48, 52);
// any other "uncaught exception" is a real one:
//   - three times "Can't read from request stream after response has been sent": an object refused a
//     request without reading the body the Worker forwarded (a viewer's write in e2e.test.ts, a demoted
//     member's in do.test.ts), as it should; the platform discards the body;
//   - once "Uncaught (in promise); stack = Error: destroy failed (test hook)": do.test.ts's alarm test makes
//     one purge fail over RPC, which workerd prints on the space's side while the directory goes on;
//   - once "Socket proxy disconnected abruptly; … TLS peer's certificate is not trusted; reason = Hostname
//     mismatch" (with a stack): smtp.test.ts connects to a fake SMTP server whose certificate names another
//     host, which workerd refuses, as it should, and logs.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared/src', import.meta.url)),
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          pool: 'forks',
          include: ['shared/**/*.test.ts', 'server/test/**/*.test.ts', 'web/src/**/*.test.ts', 'scripts/test/**/*.test.mjs'],
        },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest(({ inject }) => {
            const smtp = inject('smtp');
            return {
              wrangler: { configPath: './server/test-workers/wrangler.test.jsonc' },
              remoteBindings: false,
              // SMTP_TLS: a network service whose connect() trusts the throwaway authority of the fake SMTP
              // servers the global setup started (the TLS cases of smtp.test.ts); there is none without openssl.
              miniflare:
                smtp.ca === null
                  ? {}
                  : { serviceBindings: { SMTP_TLS: { network: { allow: ['local'], deny: [], tlsOptions: { trustBrowserCas: false, trustedCertificates: [smtp.ca] } } } } },
            };
          }),
        ],
        test: {
          name: 'workers',
          include: ['server/test-workers/**/*.test.ts'],
          // Fake SMTP servers in Node on 127.0.0.1 for smtp.test.ts, and their certificates (support/smtpFixture.ts).
          globalSetup: ['./server/test/support/smtpGlobalSetup.ts'],
        },
      },
    ],
  },
});
