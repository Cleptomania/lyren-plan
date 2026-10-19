#!/usr/bin/env bash
# Deploys Lyren Plan to Cloudflare with Wrangler, or checks that it would deploy: the deploy step of
# .github/workflows/deploy-cloudflare.yml (design §10.10), and by hand in a checkout with node_modules.
#
#   scripts/ci/deploy-cloudflare.sh
#
# Everything comes from the environment. An empty value, or one of white space only, counts as unset, as the
# Worker reads its settings.
#   DRY_RUN          true: `wrangler deploy --dry-run --outdir dist/worker`, which bundles the Worker and checks
#                    the configuration offline and uploads nothing (no token needed); false or unset: deploy
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
#                    read by Wrangler itself (by hand, `npx wrangler login` instead)
#   WORKER_NAME      the Worker's name (--name); unset: wrangler.jsonc's, lyren-plan
#   WORKERS_DEV      false: deploy with the workers.dev address turned off (once a custom domain works, §10.11),
#                    through wrangler.deploy.jsonc, which scripts/ci/wrangler-config.mjs writes next to
#                    wrangler.jsonc and this script removes again; true or unset: wrangler.jsonc as it is (on)
#   EMAIL_BINDING    true: deploy with the send_email binding EMAIL that MAIL_TRANSPORT=cloudflare needs
#                    (Cloudflare Email Service, Workers Paid; Appendix D 68), through wrangler.deploy.jsonc as
#                    for WORKERS_DEV. Unset: true when MAIL_TRANSPORT=cloudflare is passed, false otherwise.
#                    A deploy keeps variables but not bindings, so set it to true when MAIL_TRANSPORT=cloudflare
#                    is set on the Worker some other way (the dashboard); false with MAIL_TRANSPORT=cloudflare
#                    stops the script
#   SECRETS_FILE     the JSON file of scripts/ci/write-secrets-file.sh, uploaded with the new version when it
#                    lists a secret (--secrets-file: it adds and replaces, never removes); not read for a dry
#                    run. Only SETUP_TOKEN, SMTP_PASS and RESEND_API_KEY: RECOVERY_TOKEN is set by hand, only
#                    while it is needed (§5.8.19)
#   LYREN_PREBUILT   1: the web client in dist/web is used as it is, and must be there, so that wrangler.jsonc's
#                    build command runs no Vite (the workflow builds the client in a job without the token)
#   VARIABLES below  each one that is set is passed as --var NAME:value. One that is not set is not passed, so
#                    the Worker keeps the value it has (keep_vars: from the dashboard or an earlier deploy) or
#                    gets its default (Appendix B); removing a variable takes the dashboard.
#
# The output names variables and secrets, never their values. Values reach Wrangler through argv and the
# secrets file only, never through shell code. Wrangler is the project's own (npx --no: never a download).

set -euo pipefail

# Every variable the app reads on Cloudflare (server/src/core/config.ts, design Appendix B) except the secrets
# and MAIL_LOG_BODIES, which is for development only (it writes sign-in links to the logs) and stays a
# dashboard setting. The workflow passes each from the repository variable of the same name;
# scripts/test/deploy-cloudflare.test.mjs checks this list against config.ts and the workflow.
VARIABLES=(
  PUBLIC_URL WEBAUTHN_RP_ID INSTANCE_NAME SIGNUP_POLICY
  PASSWORD_MIN_LENGTH PASSWORD_KDF PASSWORD_SCRYPT_P
  SESSION_TTL_DAYS SESSION_MAX_DAYS REAUTH_MINUTES INVITATION_TTL_DAYS SPACE_DELETE_GRACE_DAYS AUTH_CACHE_SECONDS
  MAIL_TRANSPORT MAIL_FROM MAIL_FROM_NAME MAIL_REPLY_TO MAIL_DAILY_CAP
  SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_EHLO_NAME
  MAX_SPACES_PER_USER SPACES_CREATED_PER_DAY MAX_MEMBERS_PER_SPACE MAX_OPEN_INVITATIONS_PER_SPACE INVITATIONS_PER_DAY
  BODY_LIMIT IMPORT_BODY_LIMIT IMPORT_MAX_JSON_VALUES IMPORT_MAX_ROW_WRITES IMPORT_DAILY_ROW_WRITES
  SPACE_DAILY_ROW_WRITES SPACE_MAX_BYTES LOG_REQUESTS
)
# What a secrets file may list (scripts/ci/write-secrets-file.sh writes these).
SECRETS=(SETUP_TOKEN SMTP_PASS RESEND_API_KEY)

fail() {
  echo "::error::$*" >&2
  exit 1
}
# Set: anything but white space.
is_set() {
  [[ $1 == *[![:space:]]* ]]
}
# true or false from a yes/no variable ($1), $2 when unset; anything else stops the script.
yes_no() {
  local value=${!1:-}
  value=${value//[[:space:]]/}
  case ${value,,} in
    '') echo "$2" ;;
    true | 1 | yes | on) echo true ;;
    false | 0 | no | off) echo false ;;
    *) fail "$1 must be true or false" ;;
  esac
}

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

dry_run=$(yes_no DRY_RUN false)
workers_dev=$(yes_no WORKERS_DEV true)
# MAIL_TRANSPORT as the app reads it (trimmed, any case): cloudflare sends through the EMAIL binding.
transport=${MAIL_TRANSPORT:-}
transport=${transport//[[:space:]]/}
if [[ ${transport,,} == cloudflare ]]; then cloudflare_mail=true; else cloudflare_mail=false; fi
email_binding=$(yes_no EMAIL_BINDING "$cloudflare_mail")
if $cloudflare_mail && ! $email_binding; then
  fail "MAIL_TRANSPORT=cloudflare sends through the send_email binding EMAIL: unset EMAIL_BINDING, or set it to true"
fi
if [[ ${LYREN_PREBUILT:-} == 1 && ! -f dist/web/index.html ]]; then
  fail "LYREN_PREBUILT=1, but there is no dist/web/index.html: build the web client first (npm run build:web)"
fi

args=(deploy)
if $dry_run; then
  args+=(--dry-run --outdir dist/worker)
  echo "Dry run: the Worker is bundled and its configuration checked; nothing is uploaded."
else
  echo "Deploying to Cloudflare."
fi

if is_set "${WORKER_NAME:-}"; then
  args+=("--name=$WORKER_NAME")
  echo "Worker name: from WORKER_NAME"
else
  echo "Worker name: from wrangler.jsonc"
fi

written_config=false
cleanup() {
  if $written_config; then rm -f wrangler.deploy.jsonc; fi
  # Wrangler leaves an empty .wrangler/tmp next to wrangler.jsonc (as after npm run check:cf).
  node scripts/cf/clean-tmp.mjs || true
}
trap cleanup EXIT
config_args=()
if ! $workers_dev; then
  config_args+=(--workers-dev=false)
  echo "workers.dev: off (WORKERS_DEV=false)"
else
  echo "workers.dev: as wrangler.jsonc says (on; once a custom domain works, WORKERS_DEV=false keeps it off)"
fi
if $email_binding; then
  config_args+=(--email-binding)
  echo "Email binding: EMAIL, for Cloudflare Email Service ($($cloudflare_mail && echo MAIL_TRANSPORT=cloudflare || echo EMAIL_BINDING=true))"
else
  echo "Email binding: as wrangler.jsonc says"
fi
if ((${#config_args[@]} > 0)); then
  written_config=true
  node scripts/ci/wrangler-config.mjs "${config_args[@]}"
  args+=(--config=wrangler.deploy.jsonc)
fi

set_vars=()
for name in "${VARIABLES[@]}"; do
  value=${!name:-}
  if is_set "$value"; then
    args+=(--var "$name:$value")
    set_vars+=("$name")
  fi
done
unset value
echo "Variables set (${#set_vars[@]}): ${set_vars[*]:-none; the Worker keeps the ones it has}"

if $dry_run; then
  echo "Secrets: not read for a dry run"
elif is_set "${SECRETS_FILE:-}"; then
  [[ -f $SECRETS_FILE ]] || fail "SECRETS_FILE names no file: $SECRETS_FILE"
  # The names the file lists, one per line, after checking it holds only secrets of SECRETS with values.
  listed=$(node -e '
const fs = require("node:fs");
const [file, ...allowed] = process.argv.slice(1);
const stop = (why) => {
  console.error(`::error::${file} ${why}`);
  process.exit(1);
};
let secrets;
try {
  secrets = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  stop("is not a JSON file");
}
if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) stop("does not hold a JSON object");
for (const [name, value] of Object.entries(secrets)) {
  if (name === "RECOVERY_TOKEN") {
    stop("lists RECOVERY_TOKEN, which no deploy sets: set it by hand only while you need it (docs/cloudflare.md, \"Locked out\")");
  }
  if (!allowed.includes(name)) stop(`lists ${JSON.stringify(name).slice(0, 80)}, which is not one of ${allowed.join(", ")}`);
  if (typeof value !== "string" || value.trim() === "") stop(`has no value for ${name}`);
}
console.log(Object.keys(secrets).join("\n"));
' "$SECRETS_FILE" "${SECRETS[@]}")
  secrets=()
  if [[ -n $listed ]]; then mapfile -t secrets <<< "$listed"; fi
  if ((${#secrets[@]} > 0)); then
    args+=("--secrets-file=$SECRETS_FILE")
    echo "Secrets set (${#secrets[@]}): ${secrets[*]}"
  else
    echo "Secrets: none set; the Worker keeps the ones it has"
  fi
else
  echo "Secrets: none set (no SECRETS_FILE); the Worker keeps the ones it has"
fi

npx --no -- wrangler "${args[@]}"
