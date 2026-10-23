#!/usr/bin/env bash
# Writes the app's secrets to a private file for `npm run deploy:cf -- --secrets-file=<file>`
# (scripts/cf/wrangler.mjs, which hands it to `wrangler deploy`): the step before the deploy in
# .github/workflows/deploy-cloudflare.yml (design §10.10, Appendix D 70), and by hand.
#
#   scripts/ci/write-secrets-file.sh <file>
#
# Reads SETUP_TOKEN, SMTP_USER, SMTP_PASS, MAIL_REPLY_TO and RESEND_API_KEY (scripts/lib/instance.mjs,
# SECRET_NAMES) from the environment and writes those that are set to <file> as one JSON object, mode 0600.
# SMTP_USER and MAIL_REPLY_TO are settings an instance configuration may keep as secrets instead
# ("secrets.required"), so a first deploy can bring every secret it requires. An empty value, or one of white
# space only, counts as unset, as the Worker reads its settings; <file> must not exist yet. The output names
# the secrets, never a value, and the values never pass through shell code: node -e reads them from its
# environment (no npm, no dependency).
#
# RECOVERY_TOKEN is deliberately not one of them: it is set by hand, only while it is needed, and deleted
# again (docs/cloudflare.md, "Locked out"; §5.8.19). A deploy never removes a secret (--secrets-file only adds
# and replaces), so a secret that is left out here keeps the value the Worker has.

set -euo pipefail
umask 077

if [[ $# -ne 1 || -z $1 ]]; then
  echo "Usage: $0 <file>" >&2
  exit 2
fi

node -e '
const fs = require("node:fs");
const [file, ...names] = process.argv.slice(1);
const secrets = {};
for (const name of names) {
  const value = process.env[name];
  if (value !== undefined && value.trim() !== "") secrets[name] = value;
}
try {
  fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
} catch (err) {
  const why = err.code === "EEXIST" ? "it exists already (remove it, or choose another file)" : err.message;
  console.error(`::error::Could not write ${file}: ${why}`);
  process.exit(1);
}
const set = Object.keys(secrets);
console.log(
  set.length === 0
    ? `No secret is set: ${file} lists none, and the deploy uploads none (the Worker keeps the secrets it has).`
    : `Wrote ${set.join(", ")} to ${file}.`,
);
' "$1" SETUP_TOKEN SMTP_USER SMTP_PASS MAIL_REPLY_TO RESEND_API_KEY
