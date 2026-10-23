// The Worker's bindings and settings (wrangler.jsonc, design §10.8). Settings are Wrangler
// variables (`vars` of the instance configuration, which each deploy sends, and those set in the
// dashboard; `.dev.vars` under npm run dev:cf) or secrets, always strings; an empty value counts
// as unset, and unset ones take the Cloudflare defaults of Appendix B (config.ts reads them).

import type { DirectoryDO } from './directoryDo';
import type { SpaceDO } from './spaceDo';

export interface Env {
  /** Workers Static Assets: the built web client (dist/web). */
  ASSETS: Fetcher;
  /** The directory: a single object named 'directory'. */
  DIRECTORY: DurableObjectNamespace<DirectoryDO>;
  /** One object per space, named by its space id. */
  SPACES: DurableObjectNamespace<SpaceDO>;
  /** Cloudflare Email Service (Workers Paid); MAIL_TRANSPORT=cloudflare in the instance configuration adds it. */
  EMAIL?: SendEmail;

  // Secrets
  SETUP_TOKEN?: string;
  RECOVERY_TOKEN?: string;
  SMTP_PASS?: string;
  RESEND_API_KEY?: string;

  // Variables
  PUBLIC_URL?: string;
  WEBAUTHN_RP_ID?: string;
  INSTANCE_NAME?: string;
  LOG_REQUESTS?: string;
  BODY_LIMIT?: string;
  IMPORT_BODY_LIMIT?: string;
  IMPORT_MAX_JSON_VALUES?: string;
  IMPORT_MAX_ROW_WRITES?: string;
  IMPORT_DAILY_ROW_WRITES?: string;
  SIGNUP_POLICY?: string;
  PASSWORD_MIN_LENGTH?: string;
  PASSWORD_KDF?: string;
  PASSWORD_SCRYPT_P?: string;
  SESSION_TTL_DAYS?: string;
  SESSION_MAX_DAYS?: string;
  REAUTH_MINUTES?: string;
  INVITATION_TTL_DAYS?: string;
  SPACE_DELETE_GRACE_DAYS?: string;
  AUTH_CACHE_SECONDS?: string;
  MAIL_TRANSPORT?: string;
  MAIL_LOG_BODIES?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  MAIL_REPLY_TO?: string;
  MAIL_DAILY_CAP?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURITY?: string;
  SMTP_USER?: string;
  SMTP_EHLO_NAME?: string;
  MAX_SPACES_PER_USER?: string;
  SPACES_CREATED_PER_DAY?: string;
  MAX_MEMBERS_PER_SPACE?: string;
  MAX_OPEN_INVITATIONS_PER_SPACE?: string;
  INVITATIONS_PER_DAY?: string;
  SPACE_DAILY_ROW_WRITES?: string;
  SPACE_MAX_BYTES?: string;
}
