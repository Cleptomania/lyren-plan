# Lyren Plan on Cloudflare

Lyren Plan also runs on Cloudflare, within the Workers **Free** plan to start with, as long as the CPU checks of the runbook (steps [5](#5-measure-the-password-hash-before-any-account-exists) and [11](#11-a-passkey-and-the-heavy-requests)) pass: whether Free's 10 ms of CPU per request applies to Durable Objects is not settled, and several requests take longer than that ([CPU time](#cpu-time-and-the-password-hash)). A Worker routes each request to a Durable Object, one for the accounts (the directory) and one per space, each with its own SQLite database, and Workers Static Assets serve the web app (`wrangler.jsonc`; design: [docs/design/multi-user-and-cloudflare.md](design/multi-user-and-cloudflare.md) §10). Nothing in this repository belongs to one deployment: anyone can deploy their own copy, from their computer, from a fork with the GitHub workflow, or with the Deploy to Cloudflare button. What belongs to one deployment (its Worker's name, custom domain and settings) is in a file of its own, [its instance configuration](#your-instance-configuration). This page is the runbook for all three, the configuration reference, and what the Free plan holds.

The examples use `plan.example.com` for your host name, `example.com` for your domain and `<owner>/<repo>` for your copy of the repository: put your own in their place.

- [How it runs](#how-it-runs)
- [Before you start](#before-you-start)
- [Your instance configuration](#your-instance-configuration)
- [Deploying, step by step](#deploying-step-by-step)
- [Configuration](#configuration)
- [Mail](#mail)
- [Hostnames, passkeys and workers.dev](#hostnames-passkeys-and-workersdev)
- [Upgrades and rollbacks](#upgrades-and-rollbacks)
- [Moving to an instance configuration](#moving-to-an-instance-configuration)
- [Backups, and moving to a server of your own](#backups-and-moving-to-a-server-of-your-own)
- [Locked out](#locked-out)
- [The Free plan in plain words](#the-free-plan-in-plain-words)
- [CPU time and the password hash](#cpu-time-and-the-password-hash)
- [Measured cost](#measured-cost)
- [Security on Cloudflare](#security-on-cloudflare)
- [Local development](#local-development)
- [What only production can show](#what-only-production-can-show)

## How it runs

| Part | What it does |
|---|---|
| The Worker (`server/src/runtime/cloudflare/worker.ts`) | Answers `/api/*`: refuses another origin than `PUBLIC_URL`'s, another host or plain HTTP (421, and the web app moves to `PUBLIC_URL`; without `PUBLIC_URL` plain HTTP is refused except on your own machine), unusual paths, requests without the CSRF header or with a body over the limit, and space requests without a session cookie, all without a Durable Object request. Everything else goes to the directory or to one space. It adds `Strict-Transport-Security` to every answer over HTTPS. |
| `DirectoryDO`, one object named `directory` | Accounts, sessions, passkeys, sign-in limits, spaces and memberships, invitations, mail, the instance settings, and an hourly alarm for maintenance (expired sessions and links, the purge of deleted spaces). Password hashing runs here, never in the Worker. |
| `SpaceDO`, one object per space | One space's projects, tasks, comments, work logs, activity, boards and settings. It keeps a sign-in for `AUTH_CACHE_SECONDS` (30 s) and asks the directory again after that. |
| Workers Static Assets | `dist/web`, the same web app as on Node. Every path that is not a file (an app route, the links in mail) gets `index.html`. `web/public/_headers` gives these files the same Content-Security-Policy as on Node. Asset requests are free and do not count against any limit. |

What differs from a server of your own (Node):

- There is no command line: no `backup`, `restore`, `reset-password`, `promote-admin` or `policy`. Administration in the app does what they do, and [the recovery token](#locked-out) replaces `reset-password` when no administrator can sign in.
- There is no backup download and no copy of a space kept before an import replaces it. Owners download their spaces' archives ([Backups](#backups-and-moving-to-a-server-of-your-own)).
- The defaults fit the Free plan: a 12-character password minimum, sessions that end after 90 days whatever happens, 5 spaces per account, 20 members per space, imports of at most 4 MiB and 50,000 rows ([Configuration](#configuration)).
- A sign-out, or a session ended in Account settings, can keep working against a space for up to 30 seconds (`AUTH_CACHE_SECONDS`). Password changes and resets, disabling an account, removing a member and demotions reach the spaces at once.

## Before you start

You need:

- **A Cloudflare account.** The Free plan is enough to start ([what it holds](#the-free-plan-in-plain-words)).
- **A host name.** Every Worker gets `<name>.<your-subdomain>.workers.dev` for free (`<name>` is the Worker's, `lyren-plan` unless you choose another; `<your-subdomain>` is your account's, shown in the dashboard under **Workers & Pages**). That is fine for a few people who know each other. A **public instance needs a custom domain** on a zone in the same account, because only a zone can have the rate-limiting rule that stops floods ([Hostnames](#hostnames-passkeys-and-workersdev)). Decide before anybody registers a passkey: passkeys belong to their host name (or the domain in `WEBAUTHN_RP_ID`) and stop working after a move. A new account has no workers.dev subdomain yet: open **Workers & Pages** once and choose it before the first deployment (one with workers.dev off, at a custom domain listed in `routes`, needs none). Wrangler in a terminal (way A) asks for it too, but the workflow (way B) cannot, and stops with "You need to register a workers.dev subdomain before publishing to workers.dev".
- **A way to send mail, or none.** Without mail (the default), invitations are links that the inviter passes on, an administrator makes password reset links, and open sign-up is not possible. With mail: an SMTP account at a mail provider (which may not work on the Free plan), Resend with a sending domain, or Cloudflare's Email Service on Workers Paid ([Mail](#mail)). Set up SPF, DKIM and DMARC for the sender's domain at the provider.
- **For deploying from your computer** (way A below, and to check the build): Node.js 22.13 or newer (24 is what the project uses) with npm, and a checkout of the repository. **For the workflow** (B): a GitHub account and a fork. **For the button** (C): a GitHub or GitLab account.

## Your instance configuration

Everything that belongs to one deployment, and nothing else, is in one file of yours: the instance configuration. It is part of a Wrangler configuration, in Wrangler's own keys (`name`, `routes`, `vars`, …), and it never holds a secret's value, only the names of the secrets the Worker must have. The committed `wrangler.jsonc` keeps everything the app owns (its code, its Durable Objects and their `migrations`, the compatibility date), the same for every instance, so an upgrade reaches yours with nothing to edit in it.

Every Wrangler command for your instance runs through `scripts/cf/wrangler.mjs`: `npm run check:cf`, `npm run deploy:cf` and `npm run cf -- <command>`. It finds the instance configuration and checks it, together with `wrangler.jsonc` and with the app's own configuration parser (`server/src/core/config.ts`: a value the Worker would refuse stops the deploy, instead of making the API answer 503 afterwards). Then it lays it over `wrangler.jsonc` as `wrangler.deploy.<id>.jsonc`, a file of that one run (git-ignored; `<id>` is 8 random hex digits, so that two runs at once, a `tail` and a deploy say, never share one), runs the pinned Wrangler from the checkout's root with `--config=wrangler.deploy.<id>.jsonc`, and removes the file when Wrangler ends. The file's header names the run that wrote it: its process ID, where it runs (the computer's name and, on Linux, its process namespace), and whether it builds. A file that a stopped run on this computer left behind is removed by the next run, which says so (`Removed wrangler.deploy.<id>.jsonc, left by a run that was stopped.`); the file of a run that is still going, or of a run elsewhere (a container or another WSL distribution that shares the checkout), is left alone. A deploy or a check (`deploy` or `versions upload`, dry runs included) builds the web client into `dist/web`, which it empties first, so a second one in the same checkout, while the first is going on, is refused: `another deploy or check may be running in this checkout (wrangler.deploy.<id>.jsonc): wait for it to end, or remove the file if none is`. A `tail` or a `secret` command never waits, and a run without an instance configuration is not part of this. The output names settings, never their values.

**What the check sees.** The app's parser reads the file's variables, and nothing else: not the variables the Worker keeps from the dashboard (`keep_vars`), and not a secret's value. So keep every variable in the file, and at least those that the file's own depend on: `MAIL_FROM` and `PUBLIC_URL` with `MAIL_TRANSPORT`, `PUBLIC_URL` with `WEBAUTHN_RP_ID`. The run says what it checked, `App configuration: the file's variables are valid on Cloudflare (server/src/core/config.ts)`. A refusal that names a setting the file lacks says so, `MAIL_FROM is required with MAIL_TRANSPORT=cloudflare (the check reads only this file's variables: put MAIL_FROM here)`, and a mail setting that only the Worker's own `MAIL_TRANSPORT` would read gets a note: `SMTP_HOST is not read unless the Worker's MAIL_TRANSPORT is smtp: put MAIL_TRANSPORT here so that the check reads it`.

**Where it lives.** The first of these wins, and the first line of the output names it (`Instance configuration: wrangler.instance.jsonc (from the checkout)`):

1. `--instance=<file>` on the command line, for one command: `npm run deploy:cf -- --instance=wrangler.instance.staging.jsonc` deploys another instance from the same checkout.
2. `LYREN_INSTANCE_FILE=<file>` in the environment, for a file you keep anywhere: set it once in your shell profile (`export LYREN_INSTANCE_FILE="$HOME/lyren/plan.jsonc"`), and a fresh clone finds it too.
3. `wrangler.instance.jsonc` at the root of the checkout. Start from the example, which has every key, commented, with a word on each:

   ```sh
   cp wrangler.instance.example.jsonc wrangler.instance.jsonc
   ```

   Git ignores it (every `wrangler.instance*.jsonc` but the example), so `git pull` never touches it.

A relative path starts in the directory you run npm from. A file that `--instance` or `LYREN_INSTANCE_FILE` names must exist: it is never passed over for the next one. In your own copy of the repository (a fork for the workflow, the Deploy button's copy, a private repository) you commit it: `git add -f wrangler.instance.jsonc` (`.gitignore` lists it), or GitHub's **Add file → Create new file**, which `.gitignore` does not affect. In a fork that you also send pull requests from, commit it to a branch of its own ([step 4B](#4-deploy)), so that your pull requests never carry it. This repository never has that file, so updating your copy from it never conflicts with yours. Committed to a public repository, it is public: `SMTP_USER` and `MAIL_REPLY_TO` can stay out of `vars` as secrets (`secrets`, below), and every other setting is in the file. Wherever it is, keep a copy somewhere else: it is not secret, but it is yours, and nothing can write it again for you.

**What it holds:**

| Key | What it is |
|---|---|
| `name` | **Required.** The Worker's name: lower-case letters, digits and dashes, at most 63. Another name is another Worker, with new, empty Durable Objects. In Workers Builds it must be the Worker that the build deploys. |
| `vars` | The app's settings ([Configuration](#configuration)), as text: `"MAIL_DAILY_CAP": "96"` (a number, `true` or `false` is sent as text too). Each one replaces the Worker's at every deploy; the Worker's others keep their values, unless `keep_vars` is `false`. |
| `secrets` | `{ "required": ["SMTP_USER"] }`: settings kept as the Worker's secrets instead, among `SMTP_USER`, `SMTP_PASS`, `MAIL_REPLY_TO` and `RESEND_API_KEY`. Wrangler refuses a deploy while the Worker lacks one. Names only. |
| `routes` | Custom domains, `[{ "pattern": "plan.example.com", "custom_domain": true }]`, in a zone of the account, `PUBLIC_URL`'s host among them. Each deploy attaches them, and the list replaces the Worker's custom domains: list every one it should have. Without `routes`, the ones added in the dashboard stay as they are. |
| `workers_dev` | `true` or `false`: the `*.workers.dev` address. When absent: off when `routes` is listed, otherwise on, and a run with a custom domain as `PUBLIC_URL` warns: `PUBLIC_URL is a custom domain, but this deploy turns workers.dev on (wrangler.jsonc): add "workers_dev": false once the domain works`. |
| `keep_vars` | `false`: each deploy removes the variables this file does not list (one set in the dashboard, one taken out of the file). When absent, they stay. |
| `send_email` | Only to limit the senders of the binding `EMAIL`: `[{ "name": "EMAIL", "allowed_sender_addresses": ["plan@example.com"] }]`, `MAIL_FROM` among them. `MAIL_TRANSPORT=cloudflare` adds the binding by itself. |
| `limits` | Workers Paid: `{ "cpu_ms": 100 }`, the CPU time a request may use ([CPU time](#cpu-time-and-the-password-hash)), and `subrequests`. |
| `account_id` | With several accounts: the one to deploy to, which every other command uses too (the same as `CLOUDFLARE_ACCOUNT_ID` when that is set too). |
| `observability`, `placement`, `logpush`, `tail_consumers` | Passed to Wrangler as they are; `observability` is merged onto `wrangler.jsonc`'s. |
| `$schema` | `"node_modules/wrangler/config-schema.json"`: an editor completes Wrangler's keys with it. |

**What a run adds by itself:**

- `"workers_dev": false` when `routes` is listed and `workers_dev` is not.
- The `send_email` binding `EMAIL` of Cloudflare Email Service when `MAIL_TRANSPORT` in `vars` is `cloudflare` and the file lists no `send_email`, so the variable and its binding always come in the same deploy ([step 10](#cloudflare-email-service)).
- In `secrets.required`, the secrets that the app's own rules require of these settings: `SMTP_PASS` with `MAIL_TRANSPORT=smtp` and `SMTP_USER` (and the other way round), `RESEND_API_KEY` with `resend`. A dry run reads no secrets file, so its `Secrets the Worker must have` can list a secret that the real deploy's `--secrets-file` then uploads itself (and so no longer requires).

**What it refuses, and why** (each refusal says what to do instead):

- `wrangler.jsonc`'s own keys (`main`, `build`, `assets`, `durable_objects`, `migrations`, `compatibility_date`, …): they are the same for every instance.
- `env` (another instance is another file), `route` (use `routes`), routes that are no custom domains (a path or a zone's route would break `PUBLIC_URL`'s one origin), and bindings Lyren Plan does not read (KV, D1, R2, Queues, …).
- In `vars`: the secrets `SETUP_TOKEN`, `SMTP_PASS`, `RESEND_API_KEY` and `RECOVERY_TOKEN` (`npm run cf -- secret put <NAME>`), `MAIL_LOG_BODIES` (development only: `.dev.vars`), the Node server's settings, empty values (remove the line; to clear a value set in the dashboard, delete it there), a `LOG_REQUESTS` other than `1`, `true`, `yes`, `on`, `0`, `false`, `no` or `off`, and any other name, with the nearest setting's. A name is a variable or a required secret, never both.
- `SETUP_TOKEN` in `secrets.required` (it stays optional: without it the Worker makes a setup code), `RECOVERY_TOKEN` there (set by hand only while you need it), and a `send_email` limited to some recipients (invitations go to anyone).
- A value the app refuses, as the Worker would read it: `Invalid value for PUBLIC_URL: <value> (…)`. Messages name the setting, with `<value>` in place of its value.
- Values for `wrangler dev` only, which belong in `.dev.vars`: a `PUBLIC_URL` or `SMTP_HOST` on this machine (`localhost`, `127.0.0.1`, `[::1]`: `vars.PUBLIC_URL is a local address, for wrangler dev only: put it in .dev.vars, never in an instance configuration`), and `SMTP_SECURITY` `none` (`vars.SMTP_SECURITY none is for a local relay under wrangler dev only: use tls or starttls`).
- A name given twice in one object, which JSON would settle without a word by keeping the last: `<file>:<line>:<column>: "vars.MAIL_TRANSPORT" is given twice`. Like a syntax error, it stops every command that runs with an instance configuration, in that file and in `wrangler.jsonc` alike (without one, `check:cf` and the Workers Builds deploy hand `wrangler.jsonc` to Wrangler as it is).
- An instance configuration or a secrets file saved as UTF-16 or UTF-32: `<file> is saved as UTF-16: save it as UTF-8`. One in UTF-8 with a byte-order mark, as some Windows editors save it, is read.
- A `wrangler.jsonc` that holds one instance's settings (`routes`, `route`, `vars`, `send_email`, `secrets`, `account_id`, `env`, `limits`, or `workers_dev` other than `true`), as copies edited under earlier instructions do: put back the project's file (`git checkout <upstream>/master -- wrangler.jsonc`) and move those settings here. A different `name` there is fine (the Deploy button writes one): the instance configuration's wins.

`check:cf` and a deploy stop at any problem, after listing them all:

```
::error::wrangler.instance.jsonc: "migrations" comes from wrangler.jsonc, the same for every instance: remove it here
::error::wrangler.instance.jsonc: vars.MAIL_TRANSPRT is not a setting of Lyren Plan (did you mean MAIL_TRANSPORT?)
::error::wrangler.instance.jsonc: vars.SMTP_PASS is a secret, never in a file: npm run cf -- secret put SMTP_PASS
Nothing was deployed (3 problems).
```

Other commands (`secret`, `tail`, `rollback`, …) take only the Worker's `name` and `account_id` from the file, with no variables and no domains, so they need only a file that parses and names its Worker, and whose `account_id`, if any, is valid (the same as `CLOUDFLARE_ACCOUNT_ID` when that is set): the two pick the Worker the command acts on. They print the other problems as warnings, and work during an incident too.

**The commands:**

| Command | What it does |
|---|---|
| `npm run check:cf` | Checks the instance configuration, then `wrangler deploy --dry-run` with it: bundles the Worker into `dist/worker`, offline. Nothing is uploaded and no account is needed. |
| `npm run deploy:cf` | Checks it, then `wrangler deploy` with it. `-- --secrets-file=<file>` uploads secrets with the new version (a JSON object of some of `SETUP_TOKEN`, `SMTP_USER`, `SMTP_PASS`, `MAIL_REPLY_TO` and `RESEND_API_KEY`). `npm run deploy` is the same, for the deploy command the Deploy button fills in. |
| `npm run cf -- --validate` | Checks only, and runs no Wrangler (the workflow's check job). Without an instance configuration it fails, since there is nothing to check. |
| `npm run cf -- secret put <NAME>` | Sets a secret of your instance's Worker (Wrangler asks for the value and does not echo it); also `secret list` and `secret delete <NAME>`. |
| `npm run cf -- tail --format pretty` | The Worker's logs as they happen. |
| `npm run cf -- rollback`, `versions list`, `deployments list` | Any other Wrangler command, for your instance's Worker. |

The wrapper's options and Wrangler's go after npm's `--`, as above. Without it, npm takes `--instance`, `--secrets-file`, `--validate` and `--dry-run` for itself and the script never sees them, so the run stops when npm has taken one, and names the script you ran: `npm took --instance for itself: put -- before it (npm run check:cf -- --instance=<file>)` after `npm run check:cf --instance=<file>` (for `npm run cf`, `npm run cf -- --instance=<file> <command>`), or, for a deploy, `npm took --dry-run for itself: npm run check:cf, or npm run cf -- deploy --dry-run. Nothing was deployed.`

Options that would leave the instance configuration out are refused, each with where the setting goes instead: `--config`, `--name`, `--env`, `--env-file` and `--cwd` for every command; for a deploy also `--var` (`vars`), `--routes` and `--domains` (`routes`), `--keep-vars` (`keep_vars`) and the compatibility options. So is a `CLOUDFLARE_ENV` in the environment (`CLOUDFLARE_ENV is not passed on: one instance configuration is one Worker; unset it`; Wrangler gets it empty, and `--env=`, its top-level environment, on every run, so that a `.env` or `.env.local` in the checkout cannot choose an environment either), and a `--` among Wrangler's arguments, after npm's own (`-- is not passed on: give Wrangler's options without it`): Wrangler would not read the run's `--config` after it. `wrangler dev` is `npm run dev:cf` ([Local development](#local-development)), which never reads the instance configuration. Refused too: `wrangler preview` (Lyren Plan has no previews), `wrangler triggers deploy` (`npm run deploy:cf` applies routes and workers.dev) and `wrangler types` (`npx wrangler types` reads `wrangler.jsonc`, which is all the code's types need).

A run prints one line per decision, with names only, on stderr: stdout is Wrangler's alone, so `npm run -s cf -- secret list` gives Wrangler's JSON and nothing else. For a custom domain added in the dashboard, workers.dev off and Cloudflare Email Service:

```
Instance configuration: wrangler.instance.jsonc (from the checkout)
Worker name: from the instance configuration
workers.dev: off (the instance configuration)
Custom domains: none listed; those added in the dashboard stay as they are
Mail binding: EMAIL (MAIL_TRANSPORT=cloudflare)
Variables (6): PUBLIC_URL INSTANCE_NAME MAIL_TRANSPORT MAIL_FROM MAIL_FROM_NAME MAIL_DAILY_CAP
Secrets the Worker must have: none
App configuration: the file's variables are valid on Cloudflare (server/src/core/config.ts)
Note: PUBLIC_URL: decide its host before the first passkey: passkeys belong to it, or to WEBAUTHN_RP_ID
Deploying: wrangler deploy with wrangler.deploy.<id>.jsonc, 6 variables, no secrets file.
…Wrangler, whose list of bindings shows each variable as "(hidden)"…
Removed wrangler.deploy.<id>.jsonc.
```

**A plain `npx wrangler deploy` is refused** in a checkout with an instance configuration (`wrangler.instance.jsonc`, or `LYREN_INSTANCE_FILE` set). `wrangler.jsonc`'s build command, `scripts/cf/build-web.mjs`, lets a deploy or a version upload through only with the token of a run that `scripts/cf/wrangler.mjs` started, and stops any other before anything is built or uploaded: `::error::This checkout has an instance configuration (wrangler.instance.jsonc), but this wrangler deploy does not use it: deploy with npm run deploy:cf (in Workers Builds: Settings → Build → Deploy command). Nothing was uploaded.` So a habit can neither deploy the Worker without its settings nor write the dashboard's values into the tracked `wrangler.jsonc` ([step 8](#8-the-custom-domain)). A file named only with `--instance` is not seen there.

**Without an instance configuration**, `npm run check:cf` checks `wrangler.jsonc` as it is, `npm run cf -- --validate` fails (`No instance configuration to check (--instance, LYREN_INSTANCE_FILE or wrangler.instance.jsonc): cp wrangler.instance.example.jsonc wrangler.instance.jsonc and edit it (docs/cloudflare.md, "Your instance configuration")`), and `npm run deploy:cf` refuses: `No instance configuration: cp wrangler.instance.example.jsonc wrangler.instance.jsonc and edit it, or point LYREN_INSTANCE_FILE at yours (docs/cloudflare.md, "Your instance configuration"). Nothing was deployed.` The one exception is a Workers Builds build (the Deploy button's first one), which deploys `wrangler.jsonc` as it is, on workers.dev.

**Two examples.** A public instance at its custom domain, with workers.dev off and Cloudflare Email Service (Workers Paid):

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "lyren-plan",
  // Each deploy attaches the domain and turns workers.dev off.
  "routes": [{ "pattern": "plan.example.com", "custom_domain": true }],
  "vars": {
    "PUBLIC_URL": "https://plan.example.com",
    "INSTANCE_NAME": "Lyren Plan",
    // Each deploy adds the send_email binding EMAIL because of this.
    "MAIL_TRANSPORT": "cloudflare",
    "MAIL_FROM": "plan@example.com",
    "MAIL_DAILY_CAP": "96"
  }
}
```

A team's instance on workers.dev, sending through an SMTP provider:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "team-plan",
  // No routes: the instance answers at https://team-plan.<your-subdomain>.workers.dev.
  "vars": {
    "PUBLIC_URL": "https://team-plan.<your-subdomain>.workers.dev",
    "INSTANCE_NAME": "Team plan",
    "MAIL_TRANSPORT": "smtp",
    "MAIL_FROM": "plan@example.com",
    "SMTP_HOST": "smtp.example.com",
    "SMTP_SECURITY": "tls"
  },
  // The account at the provider, kept off the record as a secret of the Worker. SMTP_PASS needs no line:
  // the app requires it with SMTP_USER.
  "secrets": { "required": ["SMTP_USER"] }
}
```

The second one prints `Secrets the Worker must have: SMTP_PASS SMTP_USER`: set both before its first deploy ([step 4A](#4-deploy)).

## Deploying, step by step

The first deployment, in order. Steps 5 to 11 are done once, before you invite anybody. Steps 5 and 11 are gates: they show whether the Free plan's CPU limit holds this instance, and if one fails, change what it says (the password hash, or Workers Paid) before anybody else signs up. Step 9 is done by hand in the dashboard, and so is step 8 unless your instance configuration lists the domain: they belong to your zone, and nothing of one deployment is in this repository.

### 1. Decide

The Worker's name (`lyren-plan`, or your own), the host name (workers.dev, or a custom domain for a public instance), the mail option, and whether passkeys should work for a parent domain (`WEBAUTHN_RP_ID=example.com` for `https://plan.example.com`).

### 2. Check the build

In a checkout:

```sh
npm ci
npm run check      # typecheck, both test suites (offline), build
npm run check:cf   # bundles the Worker as a deploy would, offline, into dist/worker
```

`check:cf` runs `wrangler deploy --dry-run`: it validates `wrangler.jsonc` (with your instance configuration laid over it, once step 3 has written one), builds the web client, and prints the bundle's size, `Total Upload: 2131.06 KiB / gzip: 410.39 KiB` at the time of writing. The limit is 64 MiB uncompressed and 1 s to start. Nothing is uploaded and no Cloudflare account is needed.

### 3. The instance configuration

Write [your instance configuration](#your-instance-configuration), in the checkout of step 2 (with way B or C it then goes into your copy of the repository: step 4 says how):

```sh
cp wrangler.instance.example.jsonc wrangler.instance.jsonc   # git-ignored; edit the copy
```

- **`name`**: the Worker's name, `lyren-plan` or your own. Its workers.dev address is `https://<name>.<your-subdomain>.workers.dev`.
- **`PUBLIC_URL`**, in `vars`: the origin people will open, `https://` and a host name. Links in mail and copied links use it, passkeys need it, and the API answers no other origin: elsewhere it answers 421 and the web app moves to `PUBLIC_URL`. So it must be an address that already reaches the Worker when you do steps 5 to 7:
  - **Your custom domain** (`https://plan.example.com`, a host in a zone of this account): list it in `routes` as well, `"routes": [{ "pattern": "plan.example.com", "custom_domain": true }]`. The first deploy then attaches it and turns workers.dev off ([step 8](#8-the-custom-domain)).
  - **workers.dev for now**: `https://<name>.<your-subdomain>.workers.dev`, until step 8 moves the instance to your domain.

  If you do not know it yet, leave it out, and set it right after the first deployment, before step 5.
- **Mail**: `MAIL_TRANSPORT` stays `log` (nothing is sent) until step 10, or set up the transport of step 10 now (step 4A then says which secrets come first).
- Any other [variable](#configuration) whose default does not suit you. Never set `MAIL_LOG_BODIES` on an instance others can reach: it writes sign-in links to the logs (the instance configuration refuses it).
- **`SETUP_TOKEN`** (a secret, recommended; never in the file): the code that the first-run setup asks for, so that nobody else can claim the new instance. Choose a long random value (`openssl rand -base64 24`); step 4 says where it goes. Without it a code is generated and written to the Worker's logs.

`npm run check:cf` (step 2) then checks the file with the app's own rules, and prints what a deploy would do.

### 4. Deploy

Choose one way. Each gives you a Worker named as your instance configuration's `name`, its two Durable Object classes (created from the `migrations` of `wrangler.jsonc`) and the web app. Note the `*.workers.dev` address it prints or shows (there is none with workers.dev off).

**A. From your computer, with Wrangler.** In the checkout of step 2, with the instance configuration of step 3:

```sh
npx wrangler login                     # opens the browser to authorize Wrangler for your account
npm run deploy:cf                      # checks the instance configuration, then deploys with it
npm run cf -- secret put SETUP_TOKEN   # step 3; asks for the value; it is not echoed or kept in your shell's history
```

When `npm run check:cf` or the deploy prints `Secrets the Worker must have: …` with names (for a transport set up in step 3: `SMTP_PASS`, say), Wrangler refuses to deploy a new Worker without them: set those first. Either with `npm run cf -- secret put <NAME>` for each, before `npm run deploy:cf`: on a Worker that does not exist yet, Wrangler asks "There doesn't seem to be a Worker called … Do you want to create a new Worker with that name and add secrets to it?", and yes makes an empty Worker with the secret, which the first deploy then replaces. Or upload them with the deploy, `npm run deploy:cf -- --secrets-file=<a JSON file>` ([step 10](#10-mail)). Wrangler's own message is wrong here: it says "This Worker does not exist yet, so secrets cannot be set in advance with `wrangler secret put`", but `secret put` works as above, and of the secrets files it suggests, `SECRET_NAME=value` lines or JSON, the run reads JSON only (`{ "SMTP_PASS": "…" }`).

`npm run deploy:cf` builds the web client, bundles the Worker and uploads both, with the instance configuration laid over `wrangler.jsonc` ([what it prints](#your-instance-configuration)). Each variable of the file replaces the Worker's at every deploy; one set in the dashboard that the file does not list stays (`keep_vars`). `npm run cf -- secret put` sets a secret of your instance's Worker and creates a new version with it at once; set the secrets before you open the site in step 6. `npm run cf -- secret list` shows their names. Another instance from the same checkout is another file: `npm run deploy:cf -- --instance=wrangler.instance.staging.jsonc`.

**B. With the GitHub workflow** (`.github/workflows/deploy-cloudflare.yml`, manual only). It deploys a fork, from the instance configuration committed to it; this repository itself has none, and never deploys through the workflow.

1. Fork the repository. GitHub turns workflows off in a fork: on its **Actions** tab, enable them.
2. In Cloudflare, create an API token (**My Profile → API Tokens → Create Token**) from the **Edit Cloudflare Workers** template, limited to your account (and to the zone, if your instance configuration lists `routes`). Copy your account ID (**Workers & Pages**, on the right, or in the dashboard's address).
3. In the fork, **Settings → Environments → New environment**, named `cloudflare` (the workflow's):
   - **Deployment branches and tags**: **Selected branches and tags**, with the rule of the branch that will hold your instance configuration: the fork's default branch (`master` for this repository), or, in a fork you also send pull requests from, a branch of its own such as `deploy`, so that the default branch and the branches of your pull requests never carry the file.
   - **Required reviewers**: yourself, and anybody else who may deploy. Every run then waits for an approval before its deploy job starts (the dry run's too).
   - **Environment secrets**: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; optionally the app's secrets `SETUP_TOKEN`, `SMTP_USER`, `SMTP_PASS`, `MAIL_REPLY_TO` and `RESEND_API_KEY`, which each deploy uploads with the new version. A secret that your instance configuration requires must be here, or on the Worker already.

   Not as repository secrets (**Settings → Secrets and variables → Actions → Secrets**): those reach every workflow run in the repository, so anybody who can push a branch to the fork could read the Cloudflare token with a workflow of their own, without any approval, and deploy whatever they like, which can read every space. An environment's secrets reach only the jobs its rules let run.
4. Commit the instance configuration of step 3 to that branch, as `wrangler.instance.jsonc` at its root (`git add -f wrangler.instance.jsonc`, since `.gitignore` lists it, or **Add file → Create new file** on GitHub). Or commit it anywhere in the branch and set the repository variable `LYREN_INSTANCE_FILE` to its path from the root (**Settings → Secrets and variables → Actions → Variables**: a repository variable, which the check job reads too). **It is as public as the fork**, its history included: `SMTP_USER` and `MAIL_REPLY_TO`, the two settings that may be secrets, can stay out of it: list them in `"secrets": { "required": [...] }` instead, and add them to the environment's secrets. Every other setting is in the file. The app reads the Worker's variables and secrets alike; never set one name both ways.
5. **Actions → Deploy to Cloudflare → Run workflow**, on that branch, with **dry_run** ticked (the default). The run checks the instance configuration (in its first job, before anybody approves anything; a branch without one stops there), bundles the Worker with it, uploads nothing and uses no Cloudflare token. Its log shows `Variables (<n>): <names>` and the bundle's size.
6. Run it again with **dry_run** unticked: that deploys.

The workflow has two jobs. **Typecheck, test and build** checks the instance configuration (and fails without one) and runs `npm run check` with no secret at all, and keeps the built web client. **Deploy** starts on a new runner, installs the dependencies without their install scripts, writes the app's secrets into a private file with `node -e` alone, and runs `scripts/cf/wrangler.mjs deploy`: the instance configuration is checked again with the app's own parser (bundled by Wrangler's esbuild, and refused if it ever imports a package), then `wrangler deploy` runs with it, the secrets uploaded together with the new version (`--secrets-file`), so the Worker never runs without them. No code from the build or the tests runs where a secret is. Only the deploy job uses the `cloudflare` environment, and so its secrets: with the rules of step 3, nothing is deployed without your approval, and nothing but the deployment branch.

The workflow removes only what the instance configuration says to: the custom domains that `routes` does not list (when it lists any), the workers.dev address with `"workers_dev": false` (which `routes` implies), and the variables the file does not list with `"keep_vars": false`. Anything else stays. A variable you take out of the file stays on the Worker while `keep_vars` is true, and a secret you delete from the environment stays too, because `--secrets-file` only adds and replaces: delete them in the dashboard (**Workers & Pages → lyren-plan → Settings → Variables and Secrets**) or with `npm run cf -- secret delete <NAME>`. And the workflow never sets `RECOVERY_TOKEN` ([Locked out](#locked-out)) or `MAIL_LOG_BODIES`.

**C. With the Deploy to Cloudflare button** (in the README):

1. Click it, sign in to Cloudflare, and connect your GitHub or GitLab account. Cloudflare copies the repository into a new repository of your own (a copy, not a fork) and builds it there with Workers Builds.
2. Keep the build command that Cloudflare fills in (`npm run build`) and the deploy command (`npm run deploy`, `package.json`'s `deploy` script, the same as `npm run deploy:cf`): the web client is built once (in a Workers Builds build, `scripts/cf/build-web.mjs` keeps the client that the build command has just built), and nothing else needs setting up. This first build has no instance configuration, so it deploys `wrangler.jsonc` as it is, on workers.dev.
3. Cloudflare asks for `SETUP_TOKEN`: enter a long random value, or leave it empty to have a code generated and written to the logs (an empty value counts as unset).
4. When it is deployed, add the instance configuration of step 3 to your copy, as `wrangler.instance.jsonc` at its root (GitHub's **Add file → Create new file**, or `git add -f wrangler.instance.jsonc` and a push), with the Worker's name as `name`: the build deploys that Worker, and refuses a file that names another. The push deploys it. Secrets go in **Workers & Pages → lyren-plan → Settings → Variables and Secrets**, as **Secret** (`SMTP_PASS`, `RESEND_API_KEY`), before the push that needs them.

Every push to your copy's production branch deploys again. Free Workers Builds allow 3,000 build minutes a month. A copy made before `package.json` had its `deploy` script has `npx wrangler deploy` as its deploy command: set **Settings → Build → Deploy command** to `npm run deploy:cf` before you push the instance configuration, or its builds are refused ("This checkout has an instance configuration (wrangler.instance.jsonc), but this wrangler deploy does not use it"). Builds of other branches run `wrangler versions upload` or `wrangler preview`, which are refused the same way: turn them off (**Settings → Build → Branch control**), or set their deploy command to `npm run cf -- versions upload`. Leave the copy's `wrangler.jsonc` as this repository has it: your settings are in the instance configuration. To update the copy, pull this repository's changes into it (`git remote add upstream https://github.com/<owner>/<repo>.git`, `git pull upstream master`, `git push`): they never touch your instance configuration.

### 5. Measure the password hash, before any account exists

Whether the Free plan's 10 ms of CPU per request applies to Durable Objects is not settled in Cloudflare's documentation, and a password hash at the default cost takes about 15 ms ([CPU time](#cpu-time-and-the-password-hash)). Find out now, while changing the hash is free:

1. Sign in three times with an address that has no account: each attempt hashes at the cost new passwords will have. The site shows only the setup page until the first account exists, so send the attempts with curl:

   ```sh
   PUBLIC_URL=https://lyren-plan.<your-subdomain>.workers.dev   # yours, as set in step 3
   for i in 1 2 3; do
     curl -sS -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' -H 'X-Lyren-Request: 1' \
       -d '{"identifier":"nobody@example.com","password":"not the password"}' "$PUBLIC_URL/api/auth/login"
   done
   ```

   `401` three times is the answer for a wrong password: the hash fits. `421` means `PUBLIC_URL` is another address (step 3). Anything else (503, or Cloudflare's error 1102) needs a look at the logs.
2. In the dashboard, look at the Worker's logs and metrics (**Workers & Pages → lyren-plan → Observability**, or `npm run cf -- tail --format pretty` while you try) for `exceeded resource limits` and at the CPU time of those requests.
3. If the attempts fail, set the variable **`PASSWORD_KDF=pbkdf2`** (about 8 ms a hash, 11 ms for the whole sign-in locally, against 22 ms with scrypt) in the instance configuration's `vars` now, deploy again, and try again. Changing it later does not help the accounts that exist by then: each stored hash is checked at the cost it was made with, so they would need reset links. (scrypt stays the default: it is the stronger hash where it fits, and pbkdf2 did not bring a whole sign-in under 10 ms locally either.)
4. If ordinary requests fail the same way, the Free plan cannot run this instance: Workers Paid is the way forward ([The Free plan](#the-free-plan-in-plain-words)).

### 6. The setup code

It is your `SETUP_TOKEN`, or, without one, the code generated when the site is first opened: search the Worker's logs for `Setup code` (**Observability → Logs**, or `npm run cf -- tail` while you open the site). A failed setup attempt writes it again.

### 7. The first administrator

Open the site at `PUBLIC_URL` and complete the setup: your email address, your name and a password (at least 12 characters on Cloudflare); sample data is optional. This account is the instance administrator.

### 8. The custom domain

In your instance configuration, or by hand in the dashboard. Either way the domain's zone must be in the account, and Cloudflare creates the DNS record and the certificate.

- **In the instance configuration** (step 3 may have listed it from the start): `"routes": [{ "pattern": "plan.example.com", "custom_domain": true }]` and `PUBLIC_URL=https://plan.example.com` in `vars`, then deploy again. Each deploy attaches the domain and turns workers.dev off. The list replaces the Worker's custom domains: list every one it should keep. With the workflow, the token must reach the zone too (step 4B).
- **By hand in the dashboard**: **Workers & Pages → lyren-plan → Settings → Domains & Routes → Add → Custom domain**, for example `plan.example.com`. Then set `PUBLIC_URL=https://plan.example.com` and `"workers_dev": false` in the instance configuration, and deploy again. While it lists no `routes`, a deploy leaves the domains added in the dashboard as they are.

Then, in the zone, turn on **SSL/TLS → Edge Certificates → Always Use HTTPS**: the API answers plain HTTP with 421 (the web app then moves to `https://`), but without that setting the web app's files are served over plain HTTP too. Set `WEBAUTHN_RP_ID` as well if passkeys should belong to the parent domain. Never in `wrangler.jsonc`: nothing of one deployment is committed.

**Wrangler's warning after a change in the dashboard.** The first deploy after a change in the dashboard (a variable, the domain) may stop with "The local configuration being used … differs from the remote configuration of your Worker set via the Cloudflare Dashboard", a diff, and "Would you like to continue?". It compares the dashboard's state with the configuration the run generated: what it shows as removed is a variable set only in the dashboard, which `keep_vars` keeps, or, while the instance configuration lists no `routes`, the custom domain added in the dashboard, which such a deploy leaves alone. So answer **yes**; with workers.dev off and no `routes`, Wrangler then says "No targets deployed", which is expected: the domain serves the new version. **No** deploys nothing (and Wrangler still exits with 0), and its next question, "Would you like to update the local config file with the remote values?", can only write into the run's generated `wrangler.deploy.<id>.jsonc`, which the run then removes, saying so: `wrangler.jsonc` and your instance configuration stay as they are, and what you want to keep goes into the instance configuration. A run without a terminal (the workflow, Workers Builds) goes on by itself. The warning comes back after the next change in the dashboard.

Do this before inviting anybody or registering passkeys.

### 9. The rate-limiting rule

Required for a public instance, and made by hand in the dashboard: the app's own limits count failures per address and network, but only the zone's rule stops a flood from many addresses before it uses up the day's requests. In the zone: **Security → WAF → Rate limiting rules → Create rule**:

- **If incoming requests match**: URI Path starts with `/api/auth/` (expression `starts_with(http.request.uri.path, "/api/auth/")`).
- **With the same characteristics**: IP.
- **When rate exceeds**: 20 requests per 10 seconds; **then**: Block, for 10 seconds.

The Free plan includes one such rule. Someone it blocks is told "Too many requests. Wait a moment and try again." (the sign-in form says "Too many attempts. Wait a few minutes before trying again."). A plan with a second one can add a looser rule for `/api/` (for example 120 requests per 10 seconds). The rule cannot apply to `*.workers.dev`, which is one more reason to turn it off. A private instance for a few people can stay on workers.dev without a rule.

### 10. Mail

Choose a transport ([Mail](#mail) has the details), set its variables in the instance configuration's `vars` and its secret on the Worker, and deploy:

- **SMTP**: `MAIL_TRANSPORT=smtp`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` and `SMTP_USER` (or `SMTP_USER` as a secret, listed in `secrets.required`), with the secret `SMTP_PASS`. If the test below fails with a connection error (outbound connections may not be allowed on the Free plan), switch to Resend.
- **Resend**: `MAIL_TRANSPORT=resend`, `MAIL_FROM` at your verified Resend domain and `MAIL_DAILY_CAP=90`, with the secret `RESEND_API_KEY`.
- **Cloudflare Email Service** (Workers Paid): the [steps below](#cloudflare-email-service).

Whichever it is, put `MAIL_TRANSPORT` in the file together with the settings it needs, `MAIL_FROM` and `PUBLIC_URL`, even where the dashboard has them: a deploy checks the file's variables alone, and refuses a file that lacks them: `MAIL_FROM is required with MAIL_TRANSPORT=smtp (the check reads only this file's variables: put MAIL_FROM here)`.

The app requires `SMTP_PASS` with `SMTP_USER`, and `RESEND_API_KEY` with `resend`, so a deploy requires them of the Worker (`Secrets the Worker must have: SMTP_PASS`), and Wrangler refuses it while the Worker lacks one. Set them first: `npm run cf -- secret put SMTP_PASS` (way A; with way B they are environment secrets, which each deploy uploads; with way C, each one goes in the dashboard as **Secret**). On a Worker that does not exist yet, Wrangler asks "There doesn't seem to be a Worker called … Do you want to create a new Worker with that name and add secrets to it?": yes makes an empty Worker with the secret, which the first deploy then replaces. Or upload it with the deploy, from a file that you remove afterwards: `npm run deploy:cf -- --secrets-file=<file>`, the file a JSON object such as `{ "SMTP_PASS": "…" }` (`scripts/ci/write-secrets-file.sh <file>` writes one, mode 0600, from the environment).

Then **Administration → Overview → Send test email**, and verify your own address (**Account settings → Profile**): inviting by mail needs a verified address.

#### Cloudflare Email Service

Sending to anybody but the account's own verified addresses needs **Workers Paid** (at least $5 a month; it includes 3,000 messages a month, then $0.35 per 1,000), and Email Sending is in beta. The app sends through a `send_email` binding named `EMAIL`. The committed `wrangler.jsonc` has none, so that it suits the Free plan: `MAIL_TRANSPORT=cloudflare` in your instance configuration adds it to every deploy (step 4 below). Nothing of it is secret.

1. **Workers Paid.** Subscribe the account to it, in the dashboard's **Workers & Pages** section. (A request may then use 30 s of CPU time: the Free plan's 10 ms of steps 5 and 11 no longer applies.)
2. **Onboard the sending domain.** **Compute → Email Service → Email Sending → Onboard Domain**, choose the domain (a zone on Cloudflare DNS, in this account), review the records and select **Done**. Cloudflare adds MX records and an SPF record on `cf-bounce.<domain>`, a DKIM record on `cf-bounce._domainkey.<domain>` and a DMARC record on `_dmarc.<domain>` (`v=DMARC1; p=reject;`), usually within 5 to 15 minutes (up to 24 hours; **Email Sending → Settings** shows them). The domain needs no MX of its own for this, so mail it receives elsewhere is not affected. Cloudflare's docs do not say what happens to a `_dmarc` record that is already there: if the domain already sends mail through another provider, onboard a subdomain instead, for example the app's own `plan.example.com` (a separate sending domain with records of its own), and send from an address there.
3. **Turn Email preview off.** In the domain's settings under **Email Sending**, turn off **Enable email preview** (on by default for new sending domains): it keeps each message, readable in the dashboard's Activity log for about seven days, and invitations, password resets and verification messages hold links that work.
4. **The variables**, in the instance configuration's `vars`: `MAIL_TRANSPORT=cloudflare`, `MAIL_FROM` at the onboarded domain (`plan@example.com`), `PUBLIC_URL` (step 3), optionally `MAIL_FROM_NAME` and `MAIL_REPLY_TO`, and `MAIL_DAILY_CAP=96` to stay within the 3,000 included messages in a 31-day month (the allowance is the whole account's, every Worker in it; mail to its verified addresses is free). No secret. `MAIL_TRANSPORT=cloudflare` there is all the binding needs: every deploy from the instance configuration then carries it (`Mail binding: EMAIL (MAIL_TRANSPORT=cloudflare)`), so the variable and its binding always arrive together. Keep `MAIL_TRANSPORT` in the file, with `MAIL_FROM` and `PUBLIC_URL`, not in the dashboard: a deploy keeps the Worker's variables but not its bindings, so one whose file has no `MAIL_TRANSPORT` leaves a dashboard's `cloudflare` with nothing to send through, and the app stops working until a deploy with the binding (API requests answer 503, the directory's with "Configuration error: MAIL_TRANSPORT=cloudflare needs a send_email binding named EMAIL …"). A run without `MAIL_TRANSPORT` in the file says so in a note: `MAIL_TRANSPORT is not in the file: the Worker keeps the one it has; put MAIL_TRANSPORT and the settings it needs (MAIL_FROM, PUBLIC_URL) here so that the check sees them`.
5. **Deploy**: `npm run deploy:cf`, the workflow, or a push to your copy. A plain `npx wrangler deploy`, which would leave the binding out, is refused in a checkout with an instance configuration ([Your instance configuration](#your-instance-configuration)).

   Wrangler lists `env.EMAIL (unrestricted)  Send Email` among the bindings (`npm run check:cf` shows it too). "Unrestricted" is right: the app mails whoever it invites. To limit the sender, list the binding in the instance configuration yourself, `"send_email": [{ "name": "EMAIL", "allowed_sender_addresses": ["plan@example.com"] }]`, with `MAIL_FROM` among the addresses (a run checks it). A binding limited to some recipients (`destination_address`, `allowed_destination_addresses`) is refused.
6. **Test it**: **Administration → Overview → Send test email**, then invite an address outside the account: the test goes to your own address, and if that is a verified destination address of the account (Email Routing), Cloudflare delivers it even without Workers Paid or a finished onboarding. A failed invitation says only "The invitation email could not be sent"; Workers Logs then has `[lyren] Mail not sent: invitation to an address at …` with the reason. A refusal names Cloudflare's code: `E_SENDER_NOT_VERIFIED` or `E_SENDER_DOMAIN_NOT_AVAILABLE` (`MAIL_FROM` is not at an onboarded domain, or its records are not ready yet), `E_RECIPIENT_SUPPRESSED` (that address bounced or complained before: Cloudflare's suppression list), `E_DAILY_LIMIT_EXCEEDED` or `E_RATE_LIMIT_EXCEEDED` (a new account starts with a small daily quota that grows with use). **Email Sending → Analytics** and the Activity log show what was sent.

### 11. A passkey, and the heavy requests

Register a passkey for the administrator (**Account settings → Security → Add a passkey**): it is the cheapest sign-in and a second way in.

Then check the requests that take more than 10 ms of CPU locally ([CPU time](#cpu-time-and-the-password-hash)): import a large archive into a new space (**Spaces → Import a space…**), open its task list and its dashboard, and download its archive (**Settings → Data**). A test archive of the size the measurements below used (2,001 tasks, 1.46 MB) can be written from the checkout with

```sh
npx tsx -e "import('./server/test/support/archiveFixture.ts').then((m) => require('node:fs').writeFileSync('review-archive.json', JSON.stringify(m.reviewArchive())))"
```

(`review-archive.json`, 1.46 MB; its import writes 32,474 rows, a third of the day's writes; delete the space afterwards). Look for `exceeded resource limits` (error 1102) and the Durable Objects' CPU time in the dashboard. If these fail, the Free plan works for small spaces only, and Workers Paid is the way forward for imports and exports.

### 12. Watch the budget

After a day of real use, compare the Worker's and the Durable Objects' metrics in the dashboard (requests, rows read and written, duration, storage) with [the Free plan](#the-free-plan-in-plain-words). When a daily limit is reached, the logs show the platform's error; note its exact text: the app takes an error for the daily limit when its message has the word "exceeded" and one of "free tier", "daily", "quota", "rows read" or "rows written" (also "row read" and "row written"; `isDailyQuotaError` in `server/src/core/db.ts`, in any case), and then answers "This Lyren Plan instance has reached its daily usage limit. It resets at 00:00 UTC."; only production can show that the platform's text matches.

One error the logs may show is expected and harmless: `Uncaught TypeError: Can't read from request stream after response has been sent` (with a note about a trace with exceptions; seen under `wrangler dev`), each time a space refuses a write before reading its body (a viewer's change, a space over its daily write budget, a member removed meanwhile). The refusal reached the browser; the error is the platform discarding the unread body.

### 13. Who can create accounts

Keep the default, `invite_only`: people get an account by accepting an invitation, from a space's **Settings → Invitations** or from **Administration → Invitations**. `open` sign-up (**Administration → Settings**) needs mail, and on a Free account only makes sense with the budget in mind: every account may create 5 spaces, each with a daily write budget. `closed` lets only administrators' invitations create accounts.

### 14. Backups

Cloudflare keeps Durable Object data durably, but there is no backup download on Cloudflare. Owners download their spaces' archives regularly (**Settings → Data → Download space archive**): [Backups](#backups-and-moving-to-a-server-of-your-own).

### 15. Upgrades

From your computer: `git pull`, `npm ci`, `npm run deploy:cf`. With the workflow: **Sync fork** on the fork's page (and, with a `deploy` branch of step 4B, merge the default branch into it), then run it. With the button: pull this repository's changes into your copy and push (step 4C). Nothing in the instance configuration needs editing. Roll back as in [Upgrades and rollbacks](#upgrades-and-rollbacks).

### 16. When a limit is reached

Wait for 00:00 UTC, when every daily limit starts again. If it happens often: set the sign-up policy to `closed`, disable accounts that abuse the instance (**Administration → Users**), tighten the zone's rule, lower the [quotas](#configuration), or move to Workers Paid.

### 17. Locked out

When no administrator can sign in: [Locked out](#locked-out).

## Configuration

Every setting is a variable or a secret of the Worker. Variables go in `vars` of your [instance configuration](#your-instance-configuration), which every deploy sends (as text: `"MAIL_DAILY_CAP": "96"`; a number, `true` or `false` is sent as text too), or in `.dev.vars` for `wrangler dev`. Secrets are set on the Worker, with `npm run cf -- secret put <NAME>` or in the dashboard (**Workers & Pages → lyren-plan → Settings → Variables and Secrets**, as **Secret**), never in a file of the repository or in the instance configuration. A variable set in the dashboard (as **Text**) works too, and stays across deploys (`keep_vars`) while the instance configuration does not list it; for every name it lists, the file wins. But a deploy checks the file's variables alone ([what the check sees](#your-instance-configuration)): a setting that they depend on goes in the file too (`MAIL_FROM` and `PUBLIC_URL` with `MAIL_TRANSPORT`, `PUBLIC_URL` with `WEBAUTHN_RP_ID`), and the simplest is to move every **Text** variable of the dashboard into the file.

- An empty value, or one of spaces, counts as unset: the dashboard and the Deploy button make them easy to create. The instance configuration refuses one: remove the line instead.
- An invalid value makes every API request answer 503 with the reason (`Configuration error: Invalid value for …`), naming the variable and never a secret's value. Fix it and the next request works. A deploy first checks the instance configuration's variables, those alone, with the same parser, and refuses an invalid one.
- Booleans are true for `1`, `true`, `yes` or `on`, in any case. Numbers are whole numbers; `0` means no limit where the table says so.
- `SETUP_TOKEN`, `SMTP_PASS`, `RESEND_API_KEY` and `RECOVERY_TOKEN` are always secrets. `SMTP_USER` and `MAIL_REPLY_TO` may be either: as secrets their values are not shown (the dashboard shows variables' values, and an instance configuration committed to a public repository shows its own), and listed in the file's `secrets.required`, a deploy checks that the Worker has them. Every other setting goes in `vars`: a deploy's check cannot read a secret's value, so a setting kept as a secret is unset as far as the check knows. The app reads variables and secrets alike; never set one name both ways: a variable whose name is a secret of the Worker replaces that secret ([Moving to an instance configuration](#moving-to-an-instance-configuration) says what Wrangler asks then).
- The defaults below are Cloudflare's, chosen for the Free plan. The [README's configuration](../README.md#configuration) lists the Node defaults, which differ where noted.
- A Worker can have 64 variables and secrets; Lyren Plan reads 41.

| Variable | Cloudflare default | Secret | Meaning |
|---|---|---|---|
| **Address and passkeys** | | | |
| `PUBLIC_URL` | (unset) | | The origin people open, `https://plan.example.com`: https, or `http://localhost` (also `127.0.0.1`) under `wrangler dev`. Mail links and copied links use it, passkeys need it (with a host name), and the API answers no other origin, another host or plain HTTP (421; the web app then moves to it). Without it: no mail, no passkeys, any host over HTTPS. |
| `WEBAUTHN_RP_ID` | the host of `PUBLIC_URL` | | The domain passkeys belong to: that host, or a parent domain with at least two labels (`example.com`), never `workers.dev` or `pages.dev`. Set while passkeys are off, it is a configuration error. |
| `INSTANCE_NAME` | `Lyren Plan` | | The name in the app, in mail and for passkeys (at most 100 characters). |
| **Sign-up and passwords** | | | |
| `SETUP_TOKEN` | generated, logged | yes | The first-run setup code. Not used once the first account exists. |
| `SIGNUP_POLICY` | `invite_only` | | `open`, `invite_only` or `closed`: who can create an account. Read once, when the directory is created; afterwards **Administration → Settings** decides. `open` needs mail (with the `log` transport it starts as `invite_only`, with a warning). |
| `PASSWORD_MIN_LENGTH` | `12` (Node 8) | | The shortest new password, 8 to 64. Read once, like `SIGNUP_POLICY`. |
| `PASSWORD_KDF` | `scrypt` | | `scrypt` or `pbkdf2`, for new password hashes. Decide before the first account ([step 5](#5-measure-the-password-hash-before-any-account-exists)). |
| `PASSWORD_SCRYPT_P` | `1` (Node 5) | | scrypt's parallelization (N = 16384, r = 8), 1 to 8: about 15 ms per hash at 1. Existing hashes are made again with the new cost at their next sign-in. |
| `RECOVERY_TOKEN` | (unset) | yes | Break-glass recovery, at least 32 characters. Set it only while you need it ([Locked out](#locked-out)). |
| **Sessions and timings** | | | |
| `SESSION_TTL_DAYS` | `30` | | Days of inactivity after which a session ends (at most 400). |
| `SESSION_MAX_DAYS` | `90` (Node 0) | | Days after which a session ends however much it is used; `0` = no limit. |
| `REAUTH_MINUTES` | `10` | | How long confirming your password or passkey lasts for sensitive actions (1 to 1440). |
| `INVITATION_TTL_DAYS` | `7` | | How long an invitation link works (1 to 365). |
| `SPACE_DELETE_GRACE_DAYS` | `7` | | How long a deleted space can be restored (0 to 365; `0` = removed at once). |
| `AUTH_CACHE_SECONDS` | `30` | | Cloudflare only: how long a space keeps a sign-in before it asks the directory again (0 to 300; `0` = always ask, one more Durable Object request per call). A sign-out reaches a space within this time. |
| **Mail** ([Mail](#mail)) | | | |
| `MAIL_TRANSPORT` | `log` | | `log` (nothing is sent), `smtp`, `resend` or `cloudflare` (Workers Paid, with the `EMAIL` binding: [step 10](#cloudflare-email-service)). |
| `MAIL_FROM` | | | The sender address, required for every transport but `log`. |
| `MAIL_FROM_NAME` | `INSTANCE_NAME` | | The sender name. |
| `MAIL_REPLY_TO` | | may be | An address for replies. |
| `MAIL_DAILY_CAP` | `200` | | Messages per UTC day; 40% of them for mail that anonymous requests cause. `90` with Resend's free plan, `96` to stay within Cloudflare Email Service's 3,000 included a month. |
| `SMTP_HOST` | | | The provider's submission server, `smtp.example.com`. |
| `SMTP_SECURITY` | `tls` | | `tls` (port 465) or `starttls` (587; the server must offer it). `none` only for a mail catcher on this machine under `wrangler dev`. |
| `SMTP_PORT` | `465`, or `587` with `starttls` | | Port 25 is blocked on Workers. |
| `SMTP_USER` | | may be | The account at the provider, with `SMTP_PASS`. |
| `SMTP_PASS` | | yes | Its password. |
| `SMTP_EHLO_NAME` | the host of `PUBLIC_URL` | | The name the client introduces itself with. |
| `RESEND_API_KEY` | | yes | With `MAIL_TRANSPORT=resend`. |
| `MAIL_LOG_BODIES` | off | | Development only: the `log` transport writes whole messages, links included, so that sign-up, forgotten passwords, verification and email changes work from the links in the logs. Warned about everywhere on Cloudflare; never on an instance others can reach. An instance configuration refuses it: `.dev.vars` only. |
| **Quotas** (`0` = no limit) | | | |
| `MAX_SPACES_PER_USER` | `5` (Node 0) | | Spaces an account owns, deleted ones included until they are removed. |
| `SPACES_CREATED_PER_DAY` | `10` (Node 0) | | Spaces an account may create a day. |
| `MAX_MEMBERS_PER_SPACE` | `20` (Node 0) | | Members of a space, open invitations included. |
| `MAX_OPEN_INVITATIONS_PER_SPACE` | `50` | | Open invitations of a space, and of the instance's own invitations. |
| `INVITATIONS_PER_DAY` | `20` | | Invitations an account may send a day; 5 on its first day unless it is an administrator. |
| **Limits** | | | |
| `BODY_LIMIT` | `2097152` (2 MiB) | | The largest request body, except sign-in (64 KiB) and imports. |
| `IMPORT_BODY_LIMIT` | `4194304` (4 MiB; Node 50 MiB) | | The largest import, uploaded and unpacked. |
| `IMPORT_MAX_JSON_VALUES` | `300000` (Node 1,000,000) | | Objects, arrays and list items an import may hold, counted before it is parsed (memory grows with them). |
| `IMPORT_MAX_ROW_WRITES` | `50000` (Node 0) | | Estimated rows one import may write. |
| `IMPORT_DAILY_ROW_WRITES` | `60000` (Node 0) | | Estimated rows all imports of a UTC day may write, instance-wide. |
| `SPACE_DAILY_ROW_WRITES` | `20000` (Node 0) | | Rows a space may write a UTC day; then its writes answer 429 until 00:00 UTC. Imports have their own budget. |
| `SPACE_MAX_BYTES` | `209715200` (200 MiB; Node 0) | | The size above which a space takes no new content (deleting, and reading, still work). A Durable Object holds at most 1 GB on Free. |
| **Logging** | | | |
| `LOG_REQUESTS` | off | | One line per API request in the Worker's logs (`[lyren] GET /api/… 200`). |

**The instance configuration's other keys** ([Your instance configuration](#your-instance-configuration)): the Worker's `name`, its custom domains (`routes`), `workers_dev`, `keep_vars`, the secrets it must have (`secrets`), `send_email`, `limits` and a few more of Wrangler's. The deploy scripts read `LYREN_INSTANCE_FILE` (the instance configuration's path, when it is not `wrangler.instance.jsonc` in the checkout) and `LYREN_PREBUILT=1` (the workflow's: the built web client is used as it is); the workflow's secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are Wrangler's. The app reads none of them.

**Not read on Cloudflare** (an instance configuration refuses them): the Node server's `PORT`, `HOST`, `DATA_DIR`, `DB_PATH`, `WEB_DIR`, `TRUST_PROXY` (the client's address is `CF-Connecting-IP`), `COOKIE_SECURE` (the cookie is `Secure` over HTTPS), `SNAPSHOT_KEEP`, `SPACES_OPEN_MAX`, `ALLOW_ADMIN_BACKUP_DOWNLOAD` and `LYREN_DB_STRICT`.

## Mail

Nothing is sent until `MAIL_TRANSPORT` is set: with the default, `log`, each message is a line in Workers Logs that names the kind of message and the recipient's domain. The flows that only work by mail (sign-up, forgotten passwords, email verification) are off, invitations are links the inviter passes on, and an email change applies at once, unverified. Every other transport needs `MAIL_FROM` (the sender address) and `PUBLIC_URL` (the links). Set the variables in your instance configuration's `vars`, and the two secrets, `SMTP_PASS` and `RESEND_API_KEY`, with `npm run cf -- secret put <NAME>` (before the deploy that requires them: [step 10](#10-mail)); neither appears in a log line, an error or an API answer. A setting that is not valid makes the API answer 503 with the reason.

- **`smtp`**: our own client over `cloudflare:sockets` (design §5.10.4). `SMTP_HOST`, `SMTP_SECURITY=tls` (port 465, preferred) or `starttls` (587; the server must offer STARTTLS, or nothing is sent), `SMTP_USER` with the secret `SMTP_PASS`, and optionally `SMTP_PORT` and `SMTP_EHLO_NAME` (default the host of `PUBLIC_URL`). The certificate is verified against `SMTP_HOST`. Port 25 is blocked on Workers. Whether outbound TCP connections work on the Free plan is not documented: the test message (step 10) shows it, and Resend is the fallback. Any provider's submission server works (yours, or a personal mail account with an app password), and needs no domain of your own.
- **`resend`**: Resend's HTTP API with the secret `RESEND_API_KEY`. Add and verify your sending domain at Resend first (it gives you the DNS records), create an API key with sending access, and use an address at that domain as `MAIL_FROM`. Its free plan sends 100 messages a day, so set `MAIL_DAILY_CAP=90`.
- **`cloudflare`**: Cloudflare Email Service (Workers Paid, beta), through the `send_email` binding `EMAIL`, which `MAIL_TRANSPORT=cloudflare` in the instance configuration adds to every deploy (the committed `wrangler.jsonc` has none). The sender's domain is a zone on Cloudflare, onboarded for sending. No secret. Without the binding the directory answers 503 with the reason (the web app's files and `/api/health` still answer). The steps: [Cloudflare Email Service](#cloudflare-email-service).

`MAIL_DAILY_CAP` (default 200) bounds the messages a day (UTC); mail that anonymous requests cause (sign-up, forgotten passwords, notices of failed sign-ins) can use at most 40% of it, so invitations and verifications always have room, and one address gets at most 5 a day apart from security notices. Once mail is configured, an instance admin sends a test message to their own address from **Administration → Overview** (`POST /api/admin/mail/test`), which shows the server's error when it fails. Messages other than invitations and the test are sent just after the answer to the request that caused them, in the background of the directory object.

Locally, `wrangler dev` reaches servers on 127.0.0.1 and `localhost`: a mail catcher there works with `SMTP_HOST=localhost`, its port and `SMTP_SECURITY=none` in `.dev.vars` (accepted only for this machine, and without credentials; an instance configuration refuses both). To try TLS against a local server with a certificate of your own, start `wrangler dev` with `NODE_EXTRA_CA_CERTS=<your CA's PEM file>`, which the local runtime then trusts.

## Hostnames, passkeys and workers.dev

- **workers.dev or a custom domain.** `<name>.<your-subdomain>.workers.dev` is free and works at once. A custom domain needs the domain's DNS on Cloudflare, and is listed in `routes` of your instance configuration or added in the dashboard (step 8), never in `wrangler.jsonc`.
- **Turn workers.dev off once the custom domain works.** The committed `wrangler.jsonc` says `"workers_dev": true` (a first deployment needs some address), and Wrangler applies the deploying configuration's value at every deploy: so an instance with a custom domain has `"workers_dev": false` in its instance configuration, or lists the domain in `routes`, which turns workers.dev off by itself. A run whose `PUBLIC_URL` is a custom domain while the file has neither warns that the deploy turns workers.dev on. With `PUBLIC_URL` set, a workers.dev address that was left on serves only the web app, which moves to `PUBLIC_URL`: its API answers 421.
- **A public instance needs a custom domain and the rate-limiting rule** (step 9). Zone rules never apply to `*.workers.dev`.
- **Passkeys belong to their RP ID**, by default `PUBLIC_URL`'s host. A move to another host (from workers.dev to your domain, say) leaves every passkey registered before it unusable: they are shown as "Doesn't work here", people sign in with their password and register a new passkey, and accounts that have only passkeys need reset links (**Administration** warns and lists them; for an administrator's account, the recovery token). So **choose the final host name before people register passkeys**. `WEBAUTHN_RP_ID=example.com` with `PUBLIC_URL=https://plan.example.com` keeps passkeys working for any later host under `example.com`.
- **Passkeys and the web app** need the page to be opened at `PUBLIC_URL` itself, over HTTPS (or `http://localhost` under `wrangler dev`).

## Upgrades and rollbacks

- **Upgrade**: bring the new version into the branch you deploy from (`git pull` and `npm ci` in a checkout; **Sync fork**, or `git pull upstream master`, in a fork or a button's copy, then a merge into a fork's `deploy` branch), check it (`npm run check:cf`, or the workflow's dry run), and deploy (`npm run deploy:cf`, the workflow, or the push). Nothing in the instance configuration needs editing: it holds only your instance's settings, and what the new version changes in `wrangler.jsonc` (a compatibility date, a Durable Object migration) reaches your instance at that deploy. A setting that a later version retires is refused by name, with what replaces it, never ignored. The objects upgrade their databases when they next start; each upgrade first checks that nothing would be lost.
- **Roll back**: `npm run cf -- rollback` (or **Workers & Pages → lyren-plan → Deployments**, a previous version, **Rollback**) puts back an earlier version of the code. **Durable Object data is not rolled back.** A version that knows an older database layout still opens a newer one when the newer layout only added things (every database migration says which older versions can still read it), so a rollback across such changes is safe. Otherwise the objects answer 503 "This data was upgraded by a newer version of Lyren Plan. Deploy that version again." The release notes say when a version cannot be rolled back.
- **The Durable Object classes** (`migrations` in `wrangler.jsonc`) are append-only: never edit or remove a tag that has been deployed.

## Moving to an instance configuration

A deployment made before instance configurations keeps its settings on the Worker (variables in the dashboard, or the workflow's repository variables) and was deployed with `--var`, `--name`, `WORKERS_DEV=false`, `EMAIL_BINDING`, `scripts/ci/deploy-cloudflare.sh`, `scripts/ci/wrangler-config.mjs` or a `wrangler.local.jsonc` of your own. None of these is read any more: `npm run deploy:cf` refuses to deploy without an instance configuration, and one that lists `WORKER_NAME`, `WORKERS_DEV` or `EMAIL_BINDING` in `vars` is refused with what replaces each. Write it once, from what the Worker has, in about ten minutes (from your computer; a fork and a button's copy, below):

1. `git pull` and `npm ci` in your checkout. A `wrangler.deploy.jsonc` that `scripts/ci/wrangler-config.mjs` left there is no longer read (a run notes it: `wrangler.deploy.jsonc is left from an earlier version and no longer read: remove it`): remove it. A `wrangler.local.jsonc` is no longer read either (a run notes it): its settings go into the instance configuration.
2. In the dashboard, open **Workers & Pages → lyren-plan → Settings → Variables and Secrets**: it lists the Worker's variables and secrets.
3. `cp wrangler.instance.example.jsonc wrangler.instance.jsonc`, and in it:
   - `name`: the Worker's name, as the dashboard shows it.
   - `vars`: every **Text** variable, with its value. The check reads only the file's variables ([what the check sees](#your-instance-configuration)), so one left in the dashboard can make it refuse what the Worker accepts, or pass what the Worker would refuse. Edit the example's own lines (`INSTANCE_NAME`, `MAIL_TRANSPORT` and the commented ones) rather than adding others next to them, and list each variable once: a name given twice is refused (`<file>:<line>:<column>: "vars.MAIL_TRANSPORT" is given twice`). A **JSON** variable was ignored by the app, which reads text only: write it as text to have it apply. Leave out `MAIL_LOG_BODIES` (development only) and any name the [Configuration](#configuration) table does not have.
   - The secrets `SETUP_TOKEN`, `SMTP_PASS`, `RESEND_API_KEY` and `RECOVERY_TOKEN` stay where they are, on the Worker, and so may `SMTP_USER` and `MAIL_REPLY_TO`, which you may list in `"secrets": { "required": [...] }`. Any other setting the Worker keeps as a secret (`MAIL_FROM`, say) moves into `vars`, with its value (step 5 says what Wrangler asks then).
   - `"workers_dev": false` when workers.dev is off (with a custom domain, it is: step 8). Without it the deploy turns workers.dev back on, and the run warns.
   - With Cloudflare Email Service, `MAIL_TRANSPORT=cloudflare` in `vars` brings the binding `EMAIL` with every deploy, in place of `EMAIL_BINDING`. A binding limited to some senders: copy it as `send_email`.
   - `routes` is optional: without it the custom domain stays as the dashboard has it. To have every deploy attach it instead, list it there with every other custom domain of the Worker (the list replaces them).
4. `npm run check:cf`: it checks the file with the app's own rules and prints what the deploy will do, `Mail binding: EMAIL (MAIL_TRANSPORT=cloudflare)` and `Variables (<n>): …` among it.
5. `npx wrangler whoami` (`npx wrangler login` when it says you are not logged in), then `npm run deploy:cf`. If the last change was made in the dashboard, Wrangler shows its diff and asks "Would you like to continue?": answer **y** ([step 8](#8-the-custom-domain) says what the diff shows). If a variable of the file is a secret of the Worker (step 3), Wrangler then says "Environment variable `MAIL_FROM` conflicts with an existing remote secret. This deployment will replace the remote secret with your environment variable." and asks "Would you like to continue?": **y** deploys, and the variable replaces the secret; **n** deploys nothing. Without a terminal (the workflow, Workers Builds), Wrangler goes on by itself.
6. Check `https://plan.example.com/api/health`, then **Administration → Overview → Send test email**.
7. Keep a copy of the file outside the checkout, or move it there and set `LYREN_INSTANCE_FILE`. Variables set only in the dashboard stay (`keep_vars`); once the file lists every one you want, delete the others there, or add `"keep_vars": false` to have each deploy remove them.

**A fork with the workflow**: first bring the new version into the fork (**Sync fork** on its page, or `git pull upstream master` and a push), then do steps 1 to 4 in a clone of it, and commit the file to the branch the workflow deploys (step 4B). Add `SMTP_USER` or `MAIL_REPLY_TO` to the `cloudflare` environment's secrets if the file requires them. Delete the old repository variables (the settings, `WORKER_NAME`, `WORKERS_DEV`, `EMAIL_BINDING`): nothing reads them any more. Check the environment's deployment branch: the branch that holds the file, the fork's default branch (`master` for this repository; earlier instructions said `main`) or a `deploy` branch of its own (step 4B). Then run the workflow on that branch, with **dry_run** first.

**A button's copy**: in a clone of the copy, first bring the new version in: pull this repository's changes (`git pull upstream master`) and put back its `wrangler.jsonc` (`git checkout upstream/master -- wrangler.jsonc`): an instance configuration refuses a `wrangler.jsonc` that carries `"workers_dev": false` or `send_email`, which earlier instructions put there. Push nothing yet: a build of that alone would deploy `wrangler.jsonc` as it is, with workers.dev on and no `EMAIL` binding. Then write the instance configuration as in steps 2 and 3, its `name` the Worker that the builds deploy, with the settings that `wrangler.jsonc` carried (`"workers_dev": false`; `MAIL_TRANSPORT=cloudflare` in `vars`). Set **Settings → Build → Deploy command** to `npm run deploy:cf`, then commit the file (`git add -f wrangler.instance.jsonc`) and push it all at once.

## Backups, and moving to a server of your own

Cloudflare stores Durable Object data durably, but offers no file to download: on Cloudflare there is no backup set, no `backup` command and no copy of a space kept before an import replaces it.

- **Owners download their spaces' archives** regularly: **Settings → Data → Download space archive** (`lyren-space-<name>-<date>.json.gz`, with every project, task, comment, work log, activity entry, tag, status, board and setting, and the names and addresses of the people its entries name). Keep them somewhere else. Accounts, passwords and passkeys are not in archives.
- **Replacing a space with an archive** (**Settings → Data → Replace this space**) asks you to download the current data first, and does not let you replace before the download has started: on Cloudflare that download is the only way back.
- **Moving to a server of your own** (Node, Docker, the Windows app): set up the new instance; as its administrator, create the accounts there (**Administration → Invitations**, one per person, so they keep their email addresses); download each space's archive here; import each one there (**Spaces → Import a space…**): as an administrator you can map the archive's people to any account, and the import suggests the accounts with the same email address; then invite the remaining people to the spaces. Entries keep their authors, task references and history. People who had passkeys register new ones at the new address.
- **Moving to Cloudflare** works the same way, within Cloudflare's import limits: 4 MiB per archive, about 50,000 row writes per import and 60,000 a day (a space of about 3,000 tasks). For a larger space the import offers to leave the activity history out, or raise the limits ([Configuration](#configuration)).

## Locked out

There is no command line on Cloudflare, so when no administrator can sign in, the recovery token is the way back in:

1. Set the secret: `npm run cf -- secret put RECOVERY_TOKEN` (or in the dashboard, as **Secret**), with a random value of at least 32 characters (for example from `openssl rand -base64 33`).
2. Open `/recover` on the instance (for example `https://plan.example.com/recover`) and enter the token and the account's email address. You get a reset link that works once, for 24 hours. When no active administrator is left, the account becomes one.
3. Choose a new password with the link, and sign in.
4. Delete the secret: `npm run cf -- secret delete RECOVERY_TOKEN`. **Administration → Overview** warns while it is set.

Whoever knows the token can get a reset link for any account while it is set. The account is told at its next sign-in and in its security events, and every admin's overview lists each use. A deploy never sets or removes it: an instance configuration refuses it, and a deploy refuses a secrets file that lists it.

## The Free plan in plain words

A Workers Free account has, **per day and for the whole account** (every Worker in it), 100,000 Worker requests, 100,000 Durable Object requests, 5,000,000 rows read, 100,000 rows written and 13,000 GB-s of Durable Object duration, plus 5 GB of storage (1 GB per object). Every count starts again at 00:00 UTC. The web app's files cost nothing. Measured in a space of 2,000 tasks ([Measured cost](#measured-cost)):

- **Requests.** A click in the app is one Worker request and one or two Durable Object requests (two after a pause of about 10 seconds, when the space asks the directory again). That is 50,000 to 100,000 API calls a day: 150 to 300 people at about 300 calls each.
- **Rows read** are the limit a busy instance reaches first. Opening a board reads about one row per task of the space plus two per task of the board; a task edit makes the board load again, about 3,700 rows in a 2,000-task space, so 5,000,000 rows hold about 1,350 edits a day (about 3,000 in a space of 700 tasks). Loads of data that did not change (a window regaining focus, other people's idle tabs) read nothing. A five-person team stays well inside it.
- **Rows written**: about 7,500 task edits a day. The app keeps the rest safe: each space may write 20,000 rows a day, all imports together 60,000, one import 50,000, and anonymous visitors write almost nothing.
- **Duration**: an object that waits for nothing is not billed, so a burst of clicks costs at most about 1.25 GB-s of the 13,000.
- **CPU**: [below](#cpu-time-and-the-password-hash).

When a limit is reached:

- **Worker requests**: Cloudflare itself answers the API with error 1027 until 00:00 UTC; the web app still loads and says "This instance has reached its daily usage limit. It resets at 00:00 UTC."
- **Durable Object requests or duration**: API requests answer 503 "Lyren Plan is temporarily unavailable. Try again in a minute."
- **Rows read or written**: requests that need them answer 503 "This Lyren Plan instance has reached its daily usage limit. It resets at 00:00 UTC." Reading may still work while writing does not; changes made in the app are rolled back on the screen.
- **A space's own budget** (`SPACE_DAILY_ROW_WRITES`): that space's changes answer 429 until 00:00 UTC, the others go on. A full space (`SPACE_MAX_BYTES`) takes no new content until something is deleted.
- **Workers Logs** stop for the rest of the day at their own limit (200,000 events a day; 0.5 GB from December 2026), setup codes included.

**Workers Paid** needs no code change: CPU time is 30 s a request by default (`"limits": { "cpu_ms": … }` in your instance configuration changes it), set `PASSWORD_SCRYPT_P=5`, use Cloudflare Email Service for mail if you like ([step 10](#cloudflare-email-service)), and raise the import limits, `SPACE_DAILY_ROW_WRITES`, `SPACE_MAX_BYTES` and the quotas. An object can then hold 10 GB. Cloudflare's pricing pages have the current prices and included amounts.

## CPU time and the password hash

Workers Free allows a Worker 10 ms of CPU time per request. Whether the same limit applies to Durable Objects is not settled: the Durable Objects limits page says 30 seconds per request, Cloudflare's FAQ says they have the same limits as Workers. The Worker itself only routes (12–41 µs a request once warm, about 2 ms the first time). Measured locally, inside the objects:

| Request | CPU time (local workerd) |
|---|---|
| A password sign-in (scrypt, `PASSWORD_SCRYPT_P=1`) | 18–29 ms; one hash about 15 ms |
| The same with `PASSWORD_KDF=pbkdf2` (100,000 iterations) | 11 ms; one hash about 8 ms (first-run setup 21–23 ms) |
| First-run setup | 34–41 ms |
| A passkey sign-in | about 3 ms (verifying the answer 0.1–0.25 ms) |
| The dashboard of a 2,000-task space | 10–13 ms |
| Its all-tasks list | 21–28 ms |
| Downloading its archive | 32–52 ms |
| Importing an archive of 2,001 tasks | 93 ms to check, 156 ms to write |
| Bootstrap, a board, an edit, a search | 2–8 ms |

If the 10 ms applied, these requests would fail with error 1102 ("exceeded resource limits"); Cloudflare's documentation also says an isolate may now and then run over its limit. Hence two checks after the first deployment:

- **Before the first account** (step 5): three sign-ins with an unknown address (sent with curl, since the site shows only the setup page then) show whether a password hash fits. If it does not, set `PASSWORD_KDF=pbkdf2` then: a failed sign-in does the work of every kind of hash in use (so that its time says nothing about the account), and an existing hash keeps its kind until its next sign-in, so the decision is cheap only before anybody has a password. pbkdf2 halves a sign-in's time, but locally the whole sign-in still took 11 ms: if the limit is enforced that strictly, passkeys or Workers Paid are what help. Passkeys avoid the question altogether.
- **With a large space** (step 11): an import, the task list and the archive's download. If these fail, small spaces still work; Workers Paid allows more CPU time.

## Measured cost

A Workers Free account has 100,000 Worker requests, 100,000 Durable Object requests, 5,000,000 rows read and 100,000 rows written a day, for the whole account (design §11.1). Rows read are the limit a busy space reaches first, so the queries a space runs most were rewritten to read few rows (design §2.4.1 item 7, Appendix D 42, 46 and 47).

**The space.** The shape the platform review measured: 2,000 tasks in five projects (17 and 4 in the sample data's two, 660, 660 and 659 in three more), 11 milestones, 40 epics, 12 tags (about 1.8 per task), 305 comments (the sample data's 5 and 300 more), and the activity of creating all of it.

**How it was measured.** `server/test-workers/cost.test.ts`, in the local workerd of Wrangler 4.147.0 (compatibility date 2026-10-01), offline. It builds the space as the review did (projects, milestones, epics and tags over HTTP; the tasks and comments inside the space's object with the same code the API runs), evicts the object, then sends each request through the real Worker and reads Durable Object SQLite's own counters (`rowsRead`/`rowsWritten` of every cursor, index entries included, which is what Cloudflare bills) before and after it. The test fails when a target is missed; run it with `npx vitest run --project workers server/test-workers/cost.test.ts --reporter=verbose` to see every number. "P2" is the code before any rewrite, "D 42" the first rewrite (the same test, run on each), "now" this version. Times are the local wall time of one request.

| Operation | Worker req. | DO req. | Rows written now (P2) | Rows read: P2 | D 42 | now | Target | Time |
|---|---|---|---|---|---|---|---|---|
| Static files (JS, CSS, icons, SPA routes) | 0 | 0 | 0 | 0 | 0 | 0 | | 0 |
| `GET /api/auth/status` (directory) | 1 | 1 | 0 | 17 | 17 | 17 | | 4 ms |
| `GET …/bootstrap` | 1 | 1 | 0 | 26,891 | 2,333 | **2,333** | ≤ 8,000 (≤ 4 per task) | 6 ms |
| `GET …/bootstrap` again, unchanged (304) | 1 | 1 | 0 | 0 | 0 | **0** | ≤ 1 | 2 ms |
| The same 304 after an eviction (a cold object) | 1 | 2 | 0 | 98 | 104 | 116 | | |
| `GET …/dashboard` | 1 | 1 | 0 | 38,341 | 2,569 | **2,403** | ≤ 8,000 | 10 ms |
| Board query, one project of 660 tasks | 1 | 1 | 0 | 10,784 | 1,538 | **1,333** | ≤ 3 per task (1,980) | 8 ms |
| The same with `closedWithinDays: 14` | 1 | 1 | 0 | 10,784 | 1,538 | 1,333 | ≤ 1,980 | 8 ms |
| All-tasks query (manual order) | 1 | 1 | 0 | 29,929 | 2,710 | **2,063** | ≤ 3 per task (6,000) | 22 ms |
| All-tasks query, by due date | 1 | 1 | 0 | 29,929 | 4,709 | 4,062 | | 23 ms |
| All-tasks query, by status | 1 | 1 | 0 | 29,929 | 4,715 | 4,068 | | 22 ms |
| Search (`thing 1234`) | 1 | 1 | 0 | 6,059 | 6,059 | 6,051 | | 5 ms |
| Edit a task's title (`PATCH`) | 1 | 1 | **13** (13) | 45 | 40 | 34 | ≤ 15 written | 4 ms |
| Edit a task's status | 1 | 1 | 13 (13) | 51 | 46 | 42 | | 3 ms |
| Swap one of a task's two tags | 1 | 1 | 18 (19) | 56 | 61 | 58 | | 3 ms |
| Create a task (with its activity) | 1 | 1 | 15 (15) | 51 | 45 | 44 | | 3 ms |
| Create a task with two tags | 1 | 1 | 21 (19) | 67 | 70 | 67 | | 3 ms |
| Add a comment | 1 | 1 | 9 (8) | 28 | 28 | 29 | | 3 ms |
| Export (archive v2, gzip; P2–P6: the v1 JSON) | 1 | 2 | 0 | 8,430 | 8,430 | 9,484 | | 32–52 ms |
| Password login (directory) | 1 | 1 | 14 (14) | 27 | 27 | 27 | | 18–29 ms (scrypt) |

The rows written include the space's write generation (one row per write, design §6.4.2). A tag added to or removed from a task writes one row more (the task's tag list, `tasks.tag_ids`), which is why a task created with two tags writes 21 rows instead of 19; a tag edit writes only the tags that change, which more than makes up for it on edits. Likewise a comment, and a work log with time spent, write their task's row once more (its comment count or logged minutes, Appendix D 46). The export reads its user columns once more than the v1 export did, to list the users first (design §8.2), and the tasks' tag lists from their rows instead of `task_tags`.

**An import** (design §8.9), of the platform review's archive: 2,001 tasks with 4,002 tag rows, 40 epics, 12 tags, 306 comments, 120 work logs and 2,417 activity entries, 1.46 MB of JSON (`server/test/support/archiveFixture.ts`). `server/test-workers/importCost.test.ts` runs the commit inside a space's object and compares DoDb's meter with `estimateRowWrites`; `server/test-workers/archive.test.ts` sends the same archive through the Worker. A row inserted counts once per index of its table (a task 8, a tag row 2), a row deleted once (its index entries and the rows its cascades delete counted as one each; Appendix D 60), and the tasks' tag lists, comment counts and logged minutes are written with the tasks, not by their triggers.

| Import of the review's archive | Rows written (measured) | Estimate | Rows read | Time |
|---|---|---|---|---|
| Into a new space, with the activity | 32,474 | 32,476 | 122,779 (through the Worker) | 156 ms commit, 93 ms analyze |
| Into a new space, without the activity (`skipActivity`) | 25,218 | 25,220 | | |
| Replacing a space that holds the same archive, with the activity | 41,371 | 41,391 | | |
| The same without the activity | 34,121 | 34,135 | | |

The analysis reads 12 rows and writes none (the file is checked twice: once to analyze, once to commit). With Cloudflare's defaults an import may write 50,000 rows (`IMPORT_MAX_ROW_WRITES`) and all imports of a day 60,000 (`IMPORT_DAILY_ROW_WRITES`), so a space of about 3,000 tasks imports in one go, a larger one without its activity history, and a second import of this size waits for 00:00 UTC. The platform review measured 40,183 rows written for this shape with the import of before P7 (43,824 as a replace of a near-empty space), about 6,000 of them a second pass over the ranks.

**What the review left out**, measured the same way in the same space (D 42 is the first rewrite's run of this test, "—" where that run stopped at a missed target):

| Operation | Worker req. | DO req. | Rows written now (D 42) | Rows read: D 42 | now | Target | Time |
|---|---|---|---|---|---|---|---|
| First-run setup (`POST /api/auth/setup`: the account, and its space without sample data) | 1 | 2 | 147 (134) | 163 | 264 | | 34–41 ms (scrypt) |
| Create a space (`POST /api/spaces`), without sample data | 1 | 2 | 129 (117) | 153 | 253 | | 7 ms |
| The same with the sample data | 1 | 2 | 663 (640) | 1,305 | 1,416 | | 9 ms |
| Add a work log | 1 | 1 | 10 (9) | 27 | 28 | | 3 ms |
| The task list's page (200 open tasks of the whole space, the web client's request), manual order | 1 | 1 | 0 | 4,276 | **3,129** | ≤ 3 per task (6,000) | 7 ms |
| The same, by due date | 1 | 1 | 0 | 4,215 | 3,107 | ≤ 6,000 | 5 ms |
| The same, by priority | 1 | 1 | 0 | 4,498 | 3,127 | ≤ 6,000 | 5 ms |
| The same after "Show more" (400 tasks), by due date | 1 | 1 | 0 | — | 3,529 | ≤ 6,000 | 7 ms |
| A page of one project's open tasks (660 tasks), any order (D 42: manual) | 1 | 1 | 0 | 3,493 | **1,739** | ≤ 3 per task (1,980) | 4–6 ms |
| Board of a project of 100 tasks over 32 epics and all 12 tags | 1 | 1 | 0 | 337 | 292 | ≤ 3 per task and 2 per epic and tag listed (388) | 3 ms |
| Board of a project of 662 tasks with 3 comments and 2 work logs each | 1 | 1 | 0 | 6,077 | **1,339** | what it read before the comments (1,339) | 7 ms |
| `GET …/dashboard` with those 1,324 work logs, all of this week | 1 | 1 | 0 | — | 3,849 | ≤ 8,000 | 13 ms |

Creating a space costs two Durable Object requests (the directory, and the new space's `init`) and writes its schema; the sample data adds about 530 rows. Setup does the same for the first account, and writes the account and its first session too (18 rows more).

How the numbers grow with a space: bootstrap reads one row per task plus the other lists (about 330 rows here); the dashboard one row per task plus the tasks it lists, the latest activity and this week's work logs (one row each); a project's board about two rows per task of the project (the task, and sorting it) plus two per project, epic and tag its tasks name; the all-tasks list one row per task, and one more per task for any order other than the manual one. The task list's page reads every matching task in order (once, or twice for an order no index gives), then two rows per task of the page (Appendix D 47), so its cost follows the list's scope, not the page; "Show more" adds two rows per task shown. Comments and work logs cost nothing when their tasks are listed: their counts are in the task's row. Search reads about three rows per task (the task, and each word of the query checked against its title and description); the command palette sends one search for each pause in typing.

**What this means for one Free account.**

- **Rows read** are still the first limit, but far away. A task edit makes the open board refetch bootstrap and the board query: about 3,700 rows read in a 2,000-task space (34 for the edit, 2,333 for bootstrap, 1,333 for a 660-task board; it was 37,700 before the rewrites), so 5,000,000 rows cover about 1,350 edits a day for the whole account (it was 130), and about 3,000 in a space of 667 tasks. With the task list open instead of a board, an edit refetches bootstrap and the list's page, about 5,500 rows here (900 edits a day). Opening the dashboard adds about 2,400, plus a row for each work log of the week. Refetches of data that did not change (a window regaining focus, other members' idle tabs, switching back to a space) are answered 304 and read nothing while the object is warm, about 120 rows when it has to start again. How much a space is discussed does not change what its lists cost. A day of ordinary use by a five-person team therefore stays well inside the limit; a busy instance with several large spaces can still reach it, and every read then fails until 00:00 UTC.
- **Rows written**: about 100,000 a day, so roughly 7,500 task edits (13 rows each), or 4,700 tasks created with two tags. Imports are capped at 60% of it per day (design §8.9), anonymous traffic writes almost nothing, and each space has a daily write budget of 20,000 rows (design §11.4).
- **Durable Object requests**: 100,000 a day. A space call costs one while the object and its sign-in cache are warm and two after an idle gap (the space asks the directory again), so about 50,000 to 100,000 API calls a day, or 150 to 300 active users at about 300 calls each.
- **Duration**: an idle object that can hibernate is not billed, so one burst of requests costs at most about 1.25 GB-s of the 13,000 a day (design §11.1).
- **CPU time**: a Durable Object runs its SQL synchronously, so the times above are CPU time. Workers Free gives a Worker 10 ms of CPU per request, and whether that limit applies to Durable Objects too is not settled (design §11.1). The Worker itself only routes (the review measured 12–41 µs a request once warm and about 2 ms the first time, on the `dist/worker` bundle). Several common requests take longer than 10 ms locally: the dashboard (10–13 ms here), the all-tasks list (21–28 ms here; the review measured 70–76 ms in a 5,000-task space, and 13–18 ms for bootstrap, 15–20 ms for the dashboard and 18–23 ms for a 1,500-task board there, before Appendix D 46 and 47), the export (32–52 ms), an import (93 ms to analyze and 156 ms to commit the review's archive), a password sign-in (18–29 ms, scrypt) and first-run setup (34–41 ms). A passkey sign-in stays well inside it: verifying the browser's answer costs 0.1–0.25 ms (ES256, Ed25519 and RS256 alike), and the whole `POST /api/auth/passkey/login` took about 3 ms through the Worker (`server/test-workers/passkeys.test.ts`, design Appendix D 57). If the limit applies, these requests fail with error 1102 on a Free account; the import and the export of the review's archive take 3 to 15 times the 10 ms in workerd (validating the archive alone 17–41 ms, writing it 46–61 ms). After the first deployment the runbook therefore checks the password hash before any account exists ([step 5](#5-measure-the-password-hash-before-any-account-exists)), and imports the review-sized archive into a new space, opens its task list and exports it ([step 11](#11-a-passkey-and-the-heavy-requests)), watching the Durable Objects' CPU time and 1102 errors in the dashboard; if they fail, Workers Paid is the way forward (design §11.5), at least for import and export.
- Bootstrap reads about 1.2 rows per task in this space, so the statistics stay in it: moving them to an endpoint of their own (the fallback of design §15 P3 and §11.2) is not needed at these numbers. Measured use of a real instance, which only a deployment can give (step 12), would be the reason to revisit it.

## Security on Cloudflare

The [README's security notes](../README.md#security-notes) apply here too. On Cloudflare in particular:

- **Who can read the data.** Everyone with access to your Cloudflare account can read every space and the logs (where the setup code is, until the first account exists). Administrators of the instance cannot download a backup here, but can do what the README describes (reset links for accounts without a verified address, among others).
- **Sign-outs reach the spaces within `AUTH_CACHE_SECONDS`** (30 s): a sign-out, or one session ended in Account settings, can keep working against a space for that long. Password changes and resets, a disabled or deleted account, a removed member and a demotion are pushed to the spaces before the answer.
- **One origin.** With `PUBLIC_URL` set, the API answers no other host (421), so a workers.dev address left on cannot be used to get around the zone's rules, and passkeys are never registered for an address that will not work. It answers no plain HTTP either (421, also without `PUBLIC_URL`, except on your own machine under `wrangler dev`), so a password or a session cookie never travels in clear, even on a zone without **Always Use HTTPS** (step 8 turns it on for the web app's files).
- **HSTS**: every answer over HTTPS carries `Strict-Transport-Security: max-age=31536000` (without `includeSubDomains`: your other hosts are not ours to decide). The web app's files carry the same Content-Security-Policy as on Node (`web/public/_headers`).
- **Secrets** are Worker secrets or the secrets of the fork's `cloudflare` environment (never repository secrets, which every workflow run can read: [step 4B](#4-deploy)), never files in the repository or the instance configuration, which names the secrets the Worker must have and never holds a value. The deploy scripts print settings' names only, never a value, but an instance configuration committed to a fork is as public as the fork: `SMTP_USER` and `MAIL_REPLY_TO` can be kept as secrets instead, and every other setting is in the file. Keep `RECOVERY_TOKEN` unset except while you need it, and `MAIL_LOG_BODIES` off.
- **Next to the Cloudflare token.** The workflow's deploy job runs only Wrangler and the app's own configuration parser, which Wrangler's esbuild bundles from `server/src` and `shared/src` alone, and which is refused at run time if it ever imports a package (`scripts/lib/app-config.mjs`). The build, its plugins and the tests run in the other job, with no secret.
- **Floods.** The app's limits keep anonymous requests from writing rows and count failed sign-ins per address, per network and instance-wide; only the zone's rate-limiting rule (step 9) stops a flood from many addresses before it uses up the day's requests, and then the instance is unavailable until 00:00 UTC, like any Free Worker.

## Local development

`wrangler dev` runs the Worker, both Durable Objects and the web app on your machine, offline, with their data in `.wrangler/state` (git-ignored):

```sh
cp .dev.vars.example .dev.vars        # git-ignored; Wrangler reads it as the Worker's variables and secrets
# in .dev.vars, add:
#   PUBLIC_URL=http://localhost:8787
#   MAIL_LOG_BODIES=1                 (sign-up and reset links in the console)
npm run dev:cf                        # wrangler dev on http://localhost:8787
```

`npm run dev:cf` runs `wrangler dev` with `wrangler.jsonc` and `.dev.vars` alone: it never reads your instance configuration, and local settings stay in `.dev.vars`. Open the app at `http://localhost:8787` (the Worker answers only `PUBLIC_URL`'s origin, and plain HTTP only on this machine): `localhost` is a secure context, so passkeys work there. The setup code is printed in the terminal unless `.dev.vars` sets `SETUP_TOKEN`. On another port, run Wrangler yourself, `npx wrangler dev --ip 127.0.0.1 --port 8790`, with `PUBLIC_URL=http://localhost:8790`.

For work on the web client with hot reload, put Vite's address in `.dev.vars` instead, `PUBLIC_URL=http://localhost:5173` (or leave `PUBLIC_URL` out): Vite's proxy passes the browser's `Host` on, so every API request reaches the Worker as `localhost:5173`, and with `PUBLIC_URL=http://localhost:8787` each one would answer 421 and move the page to the Worker's own address. Then run `LYREN_API_URL=http://localhost:8787 npm run dev:web` next to `npm run dev:cf` and open `http://localhost:5173`.

Tests: `npx vitest run --project workers` runs the Worker's tests in workerd, offline (`server/test-workers/`, configured by `server/test-workers/wrangler.test.jsonc`).

## What only production can show

Everything above was built and tested in Cloudflare's local runtime (workerd, through Wrangler 4.147.0 and the vitest pool), offline. These things can only be checked on a real deployment; the runbook's steps say where. Two of them need one run each before the ways to deploy are announced: the GitHub workflow in a fork (with actionlint on a machine that has it) and the Deploy button, against a throwaway Cloudflare account.

- [ ] **CPU time on the Free plan** (steps 5 and 11): whether Durable Objects get 10 ms; the real cost of a password sign-in (scrypt with `PASSWORD_SCRYPT_P=1`, or pbkdf2), first-run setup, a passkey verification, the dashboard, the all-tasks list, an export and an import of a large space; error 1102.
- [ ] **The Worker's startup time** with the bundle of about 2.1 MB (410 KiB compressed), about 620 KiB of it the passkey library's certificate parsing (SimpleWebAuthn's x509 and asn1 code, which the app does not use but cannot leave out): it must start in under 1 s.
- [ ] **Outbound TCP from Workers on the Free plan** (step 10): whether SMTP on ports 465 and 587 connects at all, and that port 25 is blocked as documented.
- [ ] **Real mail**: a message through a real SMTP provider (TLS and STARTTLS, with the platform's certificate check), through Resend's API, and through Cloudflare's Email Service on Workers Paid, with the binding `EMAIL` that `MAIL_TRANSPORT=cloudflare` adds to a deploy (`"send_email": [{ "name": "EMAIL" }]`, unrestricted) and with one limited by `allowed_sender_addresses`.
- [ ] **Mail sent after the answer**: messages are handed to the transport in the background of the directory object (`ctx.waitUntil`, after a 0 ms timer); that they complete in production, also when the object is otherwise idle.
- [ ] **The daily-limit errors** (step 12): the exact text of a Durable Object's error once rows read or written are used up (the app expects "exceeded" with "free tier", "daily", "quota", "rows read" or "rows written"), Cloudflare's own 1027 answer (the app expects a page that names 1027), and the rate-limiting rule's 429 (error 1015).
- [ ] **`wrangler deploy --secrets-file`**: that the workflow's first deployment has its secrets from the start, and that a later one keeps the secrets it does not list. **`secrets.required`**: that a deploy is refused while the Worker lacks one, and that `npm run cf -- secret put` on a Worker that does not exist yet makes one that the first deploy replaces, Durable Objects and all.
- [ ] **Data across deploys**: that a deployment, a rollback and a Deploy-button rebuild keep the Durable Objects' data (also on a workers.dev-only deployment), and that `keep_vars` keeps the dashboard's variables.
- [ ] **The Deploy button**: the copy, Workers Builds with the legacy `migrations` form, the `SETUP_TOKEN` prompt from `.dev.vars.example`, that the web client is built once (`WORKERS_CI=1`), and that the deploy command Cloudflare fills in is `npm run deploy` (`package.json`'s `deploy` script), with which the first build, without an instance configuration, deploys `wrangler.jsonc` as it is.
- [ ] **The guard under Workers Builds**: that Wrangler hands `WRANGLER_COMMAND` to the build command there too, so that a copy with an instance configuration and the deploy command `npx wrangler deploy` is refused before anything is uploaded, while `npm run deploy` passes; and that a `name` other than the build's Worker is refused (`WRANGLER_CI_OVERRIDE_NAME`).
- [ ] **The GitHub workflow in a fork**: actionlint (not run here), a dry run, then a deployment, with the secrets in the `cloudflare` environment (step 4B): that the deploy job gets them, waits for the required reviewer, and is refused from a branch other than the deployment branch (`master` here, or a `deploy` branch); that the check job's `--validate` and the dry run read the instance configuration committed to the fork, or the one the repository variable `LYREN_INSTANCE_FILE` names.
- [ ] **Custom domains**: that a later deploy keeps a domain added in the dashboard, that `"workers_dev": false` sticks, that a domain in `routes` is attached by the first deploy (and one already attached in the dashboard is kept as it is), which token permissions that needs (a token from the **Edit Cloudflare Workers** template with the zone, and `npx wrangler login`'s), and that with **Always Use HTTPS** off the API still answers plain HTTP with 421 (`request.url` keeps the browser's scheme).
- [ ] **The zone's rate-limiting rule** (step 9): that it blocks as configured, and that the app answers its own 429s as before.
- [ ] **Passkeys on real devices**: Safari and iOS, which want the browser's passkey dialog to follow a click closely (the app asks the server for the ceremony first); password managers that offer passkeys in the sign-in field's suggestions; and the signals that tell them about removed passkeys (`signalUnknownCredential`, `signalAllAcceptedCredentials`).
- [ ] **Smaller platform details**: the 2 MB limit on a row or string (the app keeps every row far below it), Cloudflare's compression of API answers, timers inside a Durable Object (the failure padding of sign-ins), the client address in `CF-Connecting-IP`, and that `ctx.id.name` may be missing (the app does not rely on it).
