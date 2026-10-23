// Email addresses in API inputs (design §5.2): emailSchema, the zod form of normalizeEmail for the server's
// routes and the web client's forms. normalizeEmail itself is in emailAddress.ts, which imports no package, so
// that server/src/core/config.ts bundles without zod for a deploy (scripts/lib/app-config.mjs); it is
// re-exported here, and importers of '@shared/email' are unchanged.

import { z } from 'zod';
import { LIMITS } from './constants';
import { normalizeEmail } from './emailAddress';

export { normalizeEmail, type NormalizedEmail } from './emailAddress';

const INVALID_EMAIL = 'Enter a valid email address';

/** An email address in an API input: normalized to `{ address, key }`, or the issue "Enter a valid email address". */
export const emailSchema = z
  .string()
  .max(LIMITS.identifierMax, INVALID_EMAIL)
  .transform((value, ctx) => {
    const email = normalizeEmail(value);
    if (!email.ok) {
      ctx.issues.push({ code: 'custom', message: INVALID_EMAIL, input: value });
      return z.NEVER;
    }
    return { address: email.address, key: email.key };
  });
