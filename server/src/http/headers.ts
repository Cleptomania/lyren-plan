// The security headers of every response (design §13.12): the Node gateway sets them on everything it
// answers, the static site included, and the space app on its own responses. HSTS is left to the
// TLS-terminating reverse proxy on Node (the Cloudflare Worker adds it, design §10.7).

import { secureHeaders } from 'hono/secure-headers';

export function securityHeaders() {
  return secureHeaders({
    strictTransportSecurity: false,
    xFrameOptions: 'DENY',
    referrerPolicy: 'same-origin',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      // No remote images: the app never makes third-party requests (Markdown renders them as links).
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  });
}
