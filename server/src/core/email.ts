// Email addresses for server code (design §5.2): the same normalization the web client uses,
// defined once in shared/src/emailAddress.ts and re-exported with emailSchema by shared/src/email.ts.

export { emailSchema, normalizeEmail, type NormalizedEmail } from '@shared/email';
