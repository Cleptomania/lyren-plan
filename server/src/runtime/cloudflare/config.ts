// The Worker's configuration (design §10.8, Appendix B): its variables and secrets, which Cloudflare
// hands over as string properties of `env` next to the bindings (objects), parsed by the same
// core/config.ts as on Node with the Cloudflare defaults. An empty value counts as unset (the
// dashboard and the Deploy button make empty values easy to create).
//
// The Worker and both Durable Objects parse it themselves, once per isolate: an invalid value makes the
// Worker and the directory answer 503 with the reason (§10.3), never a half-configured instance.

import { parseAppConfig, type AppConfig, type ConfigVars } from '../../core/config';
import type { RuntimeInfo } from '../../core/runtime';
import type { Env } from './env';

export const CF_RUNTIME: RuntimeInfo = {
  kind: 'cloudflare',
  capabilities: { backupDownload: false, fileSnapshots: false },
};

/** The string properties of `env` (variables and secrets) that are not empty; bindings are left out. */
export function stringVars(env: Env): ConfigVars {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') vars[name] = value;
  }
  return vars;
}

/** The configuration of a Worker or Durable Object; throws a ConfigError for an invalid value. */
export function cfConfig(env: Env): AppConfig {
  return parseAppConfig(stringVars(env), 'cloudflare');
}

/** Origins that work from other devices, for copied links (§5.8.8): PUBLIC_URL, when set. */
export function publicOrigins(config: AppConfig): string[] {
  return config.publicUrl ? [config.publicUrl] : [];
}
