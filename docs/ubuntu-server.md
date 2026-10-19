# Lyren Plan on Ubuntu Server 26.04

This guide installs Lyren Plan on Ubuntu Server 26.04 LTS as a systemd service that runs on **Ubuntu's own Node.js** (the `nodejs` package from apt). It uses the release download `lyren-plan-<version>-node.tar.gz`, so the server needs no npm, no build and no Docker. You get:

- a service user without a login, and the app in a read-only, versioned folder;
- a sandboxed systemd service that starts at boot and restarts after a crash;
- HTTPS through nginx and Let's Encrypt (or Caddy), or plain HTTP on your LAN;
- accounts for the people you work with, invitations by mail (or by links you pass on), and passkeys over HTTPS;
- nightly backups by a systemd timer, with old ones pruned;
- upgrades that can be rolled back, also from Lyren Plan 1.x.

The commands are meant to be pasted in order into a shell (bash) as a user with `sudo` rights. Replace `<owner>/<repo>` with the GitHub project that publishes Lyren Plan, and `plan.example.com` with your host name.

| Path | What it is |
|---|---|
| `/usr/bin/node` | Node.js, from Ubuntu's `nodejs` package |
| `/opt/lyren-plan/lyren-plan-<version>/` | One release: `server.mjs` and `web/`, owned by root, read-only for the service |
| `/opt/lyren-plan/current` | Symbolic link to the release that runs |
| `/var/lib/lyren-plan/` | The data: `lyren.db` (the accounts and the list of spaces), `spaces/` (one database per space) and `backups/` with automatic snapshots. Owned by `lyren`, mode 0700 |
| `/var/backups/lyren-plan/` | Nightly backup sets (`.tar`), owned by `lyren`, mode 0700 |
| `/etc/systemd/system/lyren-plan.service` | The service |
| `/etc/systemd/system/lyren-plan-backup.service`, `.timer` | The nightly backup |
| The journal | Everything the app prints: `journalctl -u lyren-plan` |

Contents:

1. [Before you start](#1-before-you-start)
2. [Install Node.js from Ubuntu](#2-install-nodejs-from-ubuntu)
3. [Create the service user](#3-create-the-service-user)
4. [Download and install a release](#4-download-and-install-a-release)
5. [The systemd service](#5-the-systemd-service)
6. [First start and the setup code](#6-first-start-and-the-setup-code)
7. [HTTPS with a reverse proxy, or LAN only](#7-https-with-a-reverse-proxy-or-lan-only), and the public address
8. [Firewall](#8-firewall)
9. [Backups](#9-backups)
10. [Restore a backup](#10-restore-a-backup)
11. [Forgotten password](#11-forgotten-password)
12. [Upgrade and roll back](#12-upgrade-and-roll-back)
13. [Logs](#13-logs)
14. [Settings](#14-settings)
15. [Node.js security updates](#15-nodejs-security-updates)
16. [Troubleshooting](#16-troubleshooting)
17. [Uninstall](#17-uninstall)
18. [Alternative: build the release on the server](#18-alternative-build-the-release-on-the-server)
19. [How this guide was tested](#19-how-this-guide-was-tested)

---

## 1. Before you start

- **Ubuntu Server 26.04 LTS**, x64 or arm64, with systemd. The app itself is plain JavaScript, so the CPU does not matter.
- **Memory: 512 MB or more.** Node.js gives its heap about a quarter of the memory, and the largest need is an import, which holds the whole archive while it checks it. The default `IMPORT_MAX_JSON_VALUES` (1,000,000, an archive of about 25,000 tasks) fits 512 MB; for larger archives, raise it in [Settings](#14-settings) by about 1,000,000 for every 128 MB of heap the server can spare.
- **For HTTPS:** a host name (for example `plan.example.com`) whose DNS A and/or AAAA record points at the server, and ports 80 and 443 reachable from the internet, so that Let's Encrypt can check the name. Without that: on a private network you trust, such as your home LAN, use the [LAN-only setup](#73-option-c-lan-only-without-a-proxy); on a server with a public IP address, keep the app on 127.0.0.1 as set up below and reach it through an SSH tunnel ([section 6](#6-first-start-and-the-setup-code)) or a VPN, never over plain HTTP.
- **Maintenance commands run as `lyren`.** Every command of the app below (`backup`, `restore`, `reset-password`, ...) runs as the service user with `sudo -u lyren`: run as root on its data, a command stops with `Run this as the owner of /var/lib/lyren-plan, for example: sudo -u lyren …` instead of leaving files behind that the service cannot open.
- **sudo-rs and the Rust coreutils.** Ubuntu 26.04's `sudo` is sudo-rs, and most basic commands (`install`, `sha256sum`, `ln`, `date`, ...) come from the Rust coreutils. Every command in this guide works with them, and with GNU sudo and coreutils too. Two habits from older guides do not work:
  - `sudo -E` (keep my environment) is ignored by sudo-rs, with a warning, so a variable such as `DATA_DIR` would silently be lost. This guide passes variables with `sudo -u lyren env DATA_DIR=... command` instead.
  - `sudo -i -u lyren` or `sudo su lyren` fail, because the service user has no login shell. Run single commands with `sudo -u lyren`.
- **Node.js 22's warning.** Ubuntu's Node.js 22 prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time` (two lines) whenever Lyren Plan starts or runs a command, because it uses Node's built-in `node:sqlite`. The warning is harmless; the `--disable-warning=ExperimentalWarning` option in every `node` command below hides it.

## 2. Install Node.js from Ubuntu

```sh
sudo apt update
sudo apt install --no-install-recommends nodejs
node --version
```

Lyren Plan needs Node.js **22.13 or newer**. Ubuntu 26.04 ships Node.js 22 (`v22.22.1` when this guide was written). npm is not needed: the release download contains everything, already built.

`nodejs` is in Ubuntu's **universe** component, which a standard installation enables (`Components: main universe restricted multiverse` in `/etc/apt/sources.list.d/ubuntu.sources`). If apt answers `Unable to locate package nodejs`, add `universe` to both `Components:` lines of that file and run `sudo apt update` again. What universe means for security updates is explained in [Node.js security updates](#15-nodejs-security-updates).

## 3. Create the service user

```sh
sudo useradd --system --user-group --home-dir /nonexistent --no-create-home \
  --shell /usr/sbin/nologin --comment "Lyren Plan" lyren
```

`lyren` is a system account with its own group, no home folder, no password and no login shell. Only the service and the maintenance commands below run as it. Its data folder, `/var/lib/lyren-plan`, is created by systemd when the service first starts.

## 4. Download and install a release

Choose the version to install from the project's releases page, `https://github.com/<owner>/<repo>/releases`:

```sh
VERSION=1.0.0
```

Or take the newest release (pre-releases excluded). GitHub redirects `releases/latest` to that release's page, whose address ends in `/releases/tag/v<version>`. When the project has no such release yet, it stays on the list of releases, and these commands say so instead of setting `VERSION`:

```sh
url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/<owner>/<repo>/releases/latest)
case $url in
  */releases/tag/v*) VERSION=${url##*/releases/tag/v}; echo "$VERSION" ;;
  *) echo "No release found at $url: set VERSION by hand." >&2 ;;
esac
```

Download the archive and its checksum file into a new temporary folder:

```sh
cd "$(mktemp -d)"
base=https://github.com/<owner>/<repo>/releases/download/v$VERSION
curl -fLO "$base/lyren-plan-$VERSION-node.tar.gz"
curl -fLO "$base/lyren-plan-$VERSION-node.tar.gz.sha256"
```

Check the archive and, only if it is intact, extract it into its own folder and point `current` at it:

```sh
sha256sum -c "lyren-plan-$VERSION-node.tar.gz.sha256" &&
  sudo install -d -m 755 /opt/lyren-plan &&
  sudo tar -xzf "lyren-plan-$VERSION-node.tar.gz" -C /opt/lyren-plan --no-same-owner &&
  sudo ln -sfn "lyren-plan-$VERSION" /opt/lyren-plan/current &&
  node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs help | head -n 1
```

`sha256sum` must print `lyren-plan-1.0.0-node.tar.gz: OK` (with your version); the `&&` run the other commands only then. If it prints `FAILED` or `No such file`, nothing is installed: download again. The checksum file comes from the same place as the archive, so it detects a broken download. To also detect a file replaced after publishing, compare the value with the one in the release notes, which the release workflow wrote when it published the files.

The last command prints `Lyren Plan 1.0.0` (your version). The archive holds one folder, `lyren-plan-<version>/`, with `server.mjs` (the server and all its dependencies in one file) and `web/` (the built web app), and nothing else: no `node_modules`, no source maps. Its files belong to root and are readable by everyone, so the service can run them but not change them. `--no-same-owner` makes root's `tar` give the files to root whatever the archive says.

Each version gets its own folder, and `current` decides which one runs. That keeps the previous version at hand for a [roll-back](#12-upgrade-and-roll-back).

## 5. The systemd service

Write the unit file (paste the whole block, down to the line `EOF`):

```sh
sudo tee /etc/systemd/system/lyren-plan.service > /dev/null <<'EOF'
# Lyren Plan on Ubuntu's Node.js. See docs/ubuntu-server.md of Lyren Plan.
[Unit]
Description=Lyren Plan
After=network.target

[Service]
Type=exec
User=lyren
Group=lyren
# --disable-warning: Node.js 22 warns at every start that node:sqlite is experimental.
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs
Environment=DATA_DIR=/var/lib/lyren-plan
Environment=HOST=127.0.0.1
Environment=PORT=8080
Environment=TRUST_PROXY=true
# Creates /var/lib/lyren-plan for User=, owner-only, and keeps it writable under ProtectSystem=strict.
StateDirectory=lyren-plan
StateDirectoryMode=0700
UMask=0077
SyslogIdentifier=lyren-plan
Restart=on-failure
RestartSec=5
# Exit code 2 is a configuration error, such as an invalid PORT: restarting would not help.
RestartPreventExitStatus=2
# The server closes the database and ends within 5 s of SIGTERM, even with requests running.
TimeoutStopSec=20

# Sandboxing, tested with Lyren Plan. Do not add MemoryDenyWriteExecute=yes: Node.js compiles
# JavaScript to machine code at run time, and the service would be killed at start (SIGTRAP).
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateIPC=yes
RemoveIPC=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM

[Install]
WantedBy=multi-user.target
EOF
```

What the important lines do:

- **`ExecStart`** runs Ubuntu's Node.js on the release that `current` points to. No working directory is needed: every path is absolute.
- **`Environment`** sets the app's [configuration](../README.md#configuration): the data folder, and, for a reverse proxy on the same machine (next section), listening on 127.0.0.1:8080 only and trusting the proxy's `X-Forwarded-For` and `X-Forwarded-Proto` headers. [LAN only](#73-option-c-lan-only-without-a-proxy) changes `HOST` and `TRUST_PROXY`; [Settings](#14-settings) shows how to change variables without editing this file.
- **`StateDirectory=lyren-plan`** makes systemd create `/var/lib/lyren-plan` for `lyren` at each start if it is missing, and keeps it writable although `ProtectSystem=strict` makes the rest of the system read-only for the service. **`StateDirectoryMode=0700`** keeps it private (systemd's default would be 0755), and systemd applies that mode at every start. The app itself creates its files owner-only (0600) too, whatever the umask.
- **`Type=exec`** makes `systemctl start` fail at once when `/usr/bin/node` cannot be run. The app does not notify systemd when it is ready, so `Type=notify` would time out.
- **`Restart=on-failure`** starts the server again 5 seconds after a crash or a start-up error, such as a port that is still taken, but not after a configuration error (exit code 2, `RestartPreventExitStatus=2`).
- **Sandboxing**: the service gets no privileges or capabilities, a read-only view of the system with only its data folder writable, no access to home folders, its own `/tmp`, no devices, only IP and Unix sockets, and only the system calls that ordinary services need. `systemd-analyze security lyren-plan` rates the unit 1.3 (OK), where a unit with only `User=` and `ExecStart=` rates 9.0 (UNSAFE).

## 6. First start and the setup code

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now lyren-plan
systemctl status lyren-plan
```

`status` shows `active (running)` and the last lines the app printed (if they are not there yet, the app needed a moment longer: run `systemctl status lyren-plan` again):

```
lyren-plan[2104]: Lyren Plan 1.0.0 listening on http://127.0.0.1:8080
lyren-plan[2104]: Database: /var/lib/lyren-plan/lyren.db
lyren-plan[2104]:   First run: open the app in your browser and create your account.
lyren-plan[2104]:   Setup code: 5d0a8c9e1f3b
```

The **setup code** is what the setup page asks for when you create your account (your email address, which you sign in with, your name and a password), so that nobody else can claim a freshly installed Lyren Plan. That first account is the instance administrator. Until the account exists, every start prints a new one; after that it is not used any more. To read it again:

```sh
journalctl -u lyren-plan -n 20 --no-pager
```

Who can read it: on Ubuntu, members of the `adm` group (the user created during installation is one) and of `systemd-journal` can read the journal without `sudo`; everyone else needs `sudo journalctl -u lyren-plan`. (`id` lists your groups.) Use this generated code. The app would also take a code of your own from `SETUP_TOKEN`, but set with `Environment=` in a unit or drop-in it is visible to every local user (`systemctl show lyren-plan`); [Settings](#14-settings) shows the safe way if you want one anyway.

Check that the server answers:

```sh
curl -fsS http://127.0.0.1:8080/api/health
```

It prints `{"ok":true,"version":"1.0.0"}`. The server listens on 127.0.0.1 only, so other computers reach it through the reverse proxy of the next section. To create your account before that is set up, open an SSH tunnel from your own computer, `ssh -L 8080:127.0.0.1:8080 you@server`, and open <http://localhost:8080> there.

## 7. HTTPS with a reverse proxy, or LAN only

Lyren Plan speaks plain HTTP and leaves TLS to a reverse proxy in front of it (see [Reverse proxy and HTTPS](../README.md#reverse-proxy-and-https) in the README). Choose one option:

- **A. nginx and Let's Encrypt** (recommended): nginx is in Ubuntu's main component, with security updates from Ubuntu for the life of the release; certbot gets and renews the certificate.
- **B. Caddy**: gets certificates by itself, with a two-line configuration, but install it from Caddy's own repository (see below).
- **C. LAN only**, without a proxy and without HTTPS, for a private network you trust.

Installing the app as a PWA and using it offline only work over HTTPS (or on `http://localhost`). Over plain HTTP everything else works, but nothing is encrypted (see option C).

### 7.1 Option A: nginx and Let's Encrypt

Install nginx and give Lyren Plan its own site. Put your host name in place of `plan.example.com` before you paste (here and in the `certbot` command below):

```sh
sudo apt install nginx
sudo tee /etc/nginx/sites-available/lyren-plan > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name plan.example.com;

    # Imports can be up to 50 MB (IMPORT_BODY_LIMIT); nginx accepts 1 MB by default.
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/lyren-plan /etc/nginx/sites-enabled/lyren-plan
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` must report `syntax is ok` and `test is successful`. Removing `default` takes away nginx's welcome page, which would otherwise answer requests for any other name or the bare IP address.

Now the certificate, with certbot from its snap (the installation [recommended by certbot's authors](https://certbot.eff.org/instructions?ws=nginx&os=snap); snapd is part of Ubuntu Server). If the [firewall](#8-firewall) is already active, allow ports 80 and 443 first (`sudo ufw allow 'Nginx Full'`).

```sh
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
sudo certbot --nginx -d plan.example.com
sudo certbot renew --dry-run
```

certbot asks for an e-mail address and your agreement to the terms, gets the certificate, and changes the site file: the server block then listens on 443 with the certificate, and a new block on port 80 redirects to HTTPS (certbot's default with `--nginx`). The snap renews the certificate automatically and reloads nginx; `renew --dry-run` tests that. To also send HSTS, which the app leaves to the proxy, add `--hsts` to the `certbot --nginx` command: browsers then refuse plain HTTP for that name for a year. (Ubuntu also packages certbot, `sudo apt install certbot python3-certbot-nginx`, in its universe component.)

Open `https://plan.example.com` and create your account with the setup code. Then tell the app its address: [7.4](#74-the-public-address-links-and-passkeys).

### 7.2 Option B: Caddy

Do not use Ubuntu's own `caddy` package: it is version 2.6.2 from 2022, in universe, with known vulnerabilities that Ubuntu had not fixed when this guide was written (October 2026). Install Caddy from Caddy's repository instead, with the commands from [caddyserver.com/docs/install](https://caddyserver.com/docs/install) (section "Debian, Ubuntu, Raspbian"). Like Ubuntu's package, it starts Caddy at once, with a welcome page on port 80, until the next step replaces the configuration:

```sh
sudo apt install --yes debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

Then replace its configuration (with your host name) and reload it:

```sh
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
plan.example.com {
	reverse_proxy 127.0.0.1:8080
}
EOF
sudo systemctl reload caddy
```

Caddy gets a certificate for the name by itself (it needs the DNS record and ports 80 and 443 open), redirects HTTP to HTTPS, renews the certificate, and sends `X-Forwarded-For` and `X-Forwarded-Proto` to the app. `journalctl -u caddy` shows how getting the certificate went. Then tell the app its address: [7.4](#74-the-public-address-links-and-passkeys).

### 7.3 Option C: LAN only, without a proxy

Use this only on a private network you trust, such as your home LAN behind its router, and never on a server with a public IP address. Over plain HTTP the setup code, your password and the session cookie cross the network unencrypted: anyone who can see the traffic (on the same Wi-Fi, for example) can read them and use your session. To reach the app from elsewhere, use option A or B, or a VPN.

Make the app listen on the network and trust no proxy headers (clients could otherwise forge their address). Write this as a drop-in file, so the unit file stays as it is:

```sh
sudo mkdir -p /etc/systemd/system/lyren-plan.service.d
sudo tee /etc/systemd/system/lyren-plan.service.d/lan.conf > /dev/null <<'EOF'
[Service]
Environment=HOST=0.0.0.0
Environment=TRUST_PROXY=false
EOF
sudo systemctl daemon-reload
sudo systemctl restart lyren-plan
```

`HOST=0.0.0.0` listens on every IPv4 address of the server. If the server is also connected to other networks, put its LAN address there instead, for example `Environment=HOST=192.168.1.10` (`ip -brief address` lists the addresses), so that the app cannot be reached from the others; when that address is not there yet at boot, the service tries again every 5 seconds. `HOST=::` listens on IPv6 and IPv4 (the log then shows `listening on http://:::8080`).

Then **turn on the [firewall](#8-firewall)** with the rule for option C, so that only your LAN reaches port 8080, and open `http://<server-ip>:8080` on a computer in your LAN.

### 7.4 The public address: links and passkeys

With option A or B, tell the app the address people open, in `PUBLIC_URL`. Links in mail and the invitation and reset links you copy are built from it (never from what a request says), and **passkeys** need it: they work only when `PUBLIC_URL` is an `https` address and the page is opened at that address. A drop-in file, with your host name:

```sh
sudo mkdir -p /etc/systemd/system/lyren-plan.service.d
sudo tee /etc/systemd/system/lyren-plan.service.d/public-url.conf > /dev/null <<'EOF'
[Service]
Environment=PUBLIC_URL=https://plan.example.com
EOF
sudo systemctl daemon-reload
sudo systemctl restart lyren-plan
```

- **Passkeys behind the proxy.** The browser talks HTTPS to nginx or Caddy, and the app sees plain HTTP from 127.0.0.1; with `TRUST_PROXY=true` (in the unit above) it takes the `X-Forwarded-Proto: https` the proxy sends, so the session cookie becomes `__Host-lyren_session` with `Secure`. With `PUBLIC_URL` set, passkeys are offered on the sign-in page and in **Account settings → Security**. Nothing else needs configuring: the browser and the app check a passkey against `PUBLIC_URL`, not against the proxy.
- **Choose the host name before people add passkeys.** A passkey belongs to its host name (or, with `Environment=WEBAUTHN_RP_ID=example.com`, to the whole domain `example.com`): after a move to another name, the passkeys registered before stop working, and accounts that only have passkeys need a reset link (**Administration → Users**, or `reset-password`, [section 11](#11-forgotten-password)).
- **LAN only** (option C): an `http://` address with an IP address cannot have passkeys. Set `PUBLIC_URL=http://<server-ip>:8080` anyway if others should get copied links that work on their devices.
- A value that is not an origin (one with a path, say) stops the server with `Invalid value for PUBLIC_URL: …` (exit code 2, not restarted).

## 8. Firewall

Ubuntu's firewall front end, ufw, is installed on standard installations but turned off. Option C needs it; with options A and B it is recommended. Before you turn it on, **allow SSH**, so that it never cuts off the connection you are working through:

```sh
sudo apt install ufw
sudo ufw allow OpenSSH
```

(If SSH listens on another port, allow that one instead, for example `sudo ufw allow 2222/tcp`.) Then allow what your option from section 7 needs, with **one** of these:

- A, nginx (ports 80 and 443): `sudo ufw allow 'Nginx Full'`
- B, Caddy: `sudo ufw allow 80,443/tcp`, and `sudo ufw allow 443/udp` for HTTP/3
- C, LAN only, with your LAN's address range: `sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp`

Check that the SSH rule is in the list, then turn the firewall on and look at the result:

```sh
sudo ufw show added
sudo ufw enable
sudo ufw status verbose
```

`ufw enable` asks `Command may disrupt existing ssh connections. Proceed with operation (y|n)?`; answer `y` only when `show added` listed your SSH rule. The default policy then drops every other incoming connection, over IPv4 and IPv6. With options A and B, port 8080 needs no rule: the app listens on 127.0.0.1 only.

## 9. Backups

The `backup` command writes a backup set while the server runs: one `.tar` file with the accounts and every space, each a consistent snapshot, without sign-in sessions and tokens. A systemd timer runs it every night and deletes backups older than 30 days.

Create the backup folder once:

```sh
sudo install -d -o lyren -g lyren -m 700 /var/backups/lyren-plan
```

The backup service and its timer:

```sh
sudo tee /etc/systemd/system/lyren-plan-backup.service > /dev/null <<'EOF'
# Nightly backup of Lyren Plan (lyren-plan-backup.timer). See docs/ubuntu-server.md of Lyren Plan.
[Unit]
Description=Lyren Plan backup
After=lyren-plan.service

[Service]
Type=oneshot
User=lyren
Group=lyren
Environment=DATA_DIR=/var/lib/lyren-plan
# The shell fills in the date; in a unit file "%%" stands for "%".
ExecStart=/bin/sh -c 'exec /usr/bin/node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs backup "/var/backups/lyren-plan/lyren-$(date +%%F-%%H%%M%%S).tar"'
# Only after a successful backup: delete backups older than 30 days (backup sets, and .db files of
# versions before spaces).
ExecStartPost=/usr/bin/find /var/backups/lyren-plan -maxdepth 1 -type f '(' -name 'lyren-*.tar' -o -name 'lyren-*.db' ')' -mtime +30 -delete
StateDirectory=lyren-plan
StateDirectoryMode=0700
ReadWritePaths=/var/backups/lyren-plan
UMask=0077
SyslogIdentifier=lyren-plan-backup

NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateNetwork=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
SystemCallErrorNumber=EPERM
EOF
sudo tee /etc/systemd/system/lyren-plan-backup.timer > /dev/null <<'EOF'
[Unit]
Description=Nightly Lyren Plan backup

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now lyren-plan-backup.timer
```

Make the first backup now, and look at it:

```sh
sudo systemctl start lyren-plan-backup
journalctl -u lyren-plan-backup -n 5 --no-pager
sudo ls -l /var/backups/lyren-plan
systemctl list-timers lyren-plan-backup.timer
```

The journal shows `Backup written to /var/backups/lyren-plan/lyren-2026-10-16-153012.tar (1 space)`, and `list-timers` the next run. `sudo tar -tvf /var/backups/lyren-plan/lyren-2026-10-16-153012.tar` lists what a set holds: `lyren-backup.json` (what it holds), `directory.db` and `spaces/<id>.db` for each space. `sudo systemctl start lyren-plan-backup` is also the way to make a backup by hand at any time, for example before an upgrade.

- **Schedule and retention.** The backup runs at 03:00; `Persistent=true` catches up on a run missed while the server was off. To keep backups longer, change `+30` (days) in `lyren-plan-backup.service`, then `sudo systemctl daemon-reload`. Pruning only runs after a successful backup, so failing backups never make the old ones disappear, and it only deletes files named `lyren-*.tar` or `lyren-*.db` (from versions before spaces) directly in `/var/backups/lyren-plan`.
- **The backup needs the data folder writable** (SQLite opens the live databases read-write, and the snapshots are taken in a temporary folder there), hence the same `StateDirectory=` as the service.
- **While a restore waits** for the next start ([section 10](#10-restore-a-backup)), the backup refuses to run, and `systemctl --failed` shows it until its next successful run (or `sudo systemctl reset-failed lyren-plan-backup`).
- **Check on it now and then:** `systemctl status lyren-plan-backup` shows the last result; a failed backup shows as `failed` in `systemctl --failed`.
- **Copy the backups off the server.** They are on the same disk as the database, so they do not survive the loss of that disk or of the server. Copy `/var/backups/lyren-plan` to another machine regularly, with the backup tool you already use (restic, borg, rsync, ...), run as root: only `lyren` and root can read the files. They contain the password hashes (scrypt), so keep the copies private. A manual alternative is **Administration → Overview → Download backup** in the app.
- **Automatic snapshots.** Independently of these backups, the app writes snapshots into `/var/lib/lyren-plan/backups/`: of a space before an import replaces its content (`spaces/<id>/pre-import-*.db`), and of a database before an upgrade changes it (`directory-v<N>-before-upgrade-*.db`, `spaces/<id>/space-v<N>-before-upgrade-*.db`, and once `lyren-v1-before-upgrade-*.db`, [section 12](#12-upgrade-and-roll-back)). It keeps the newest 10 of each kind (`SNAPSHOT_KEEP`).

## 10. Restore a backup

The `restore` command checks the backup and prepares the restore; the next start of the service completes it, after moving what it replaces to `/var/lib/lyren-plan/backups/before-restore-<time>/`, which is never deleted automatically. It can run while the server runs, which keeps the current data until the restart:

```sh
sudo ls -l /var/backups/lyren-plan               # choose a file
sudo systemctl start lyren-plan-backup           # optional: first a backup of the current state
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs restore /var/backups/lyren-plan/lyren-2026-10-16-030012.tar
sudo systemctl restart lyren-plan
journalctl -u lyren-plan -n 10 --no-pager
```

`restore` answers `Staged the restore of the backup set made … (1 space) from …` and `Restart Lyren Plan to complete the restore (systemctl restart lyren-plan, or docker restart lyren-plan). The current data will be moved to backups/before-restore-<time>/.`; after the restart the journal shows `Restored the backup set made …`.

- **A file only root can read**, such as a downloaded backup in your home folder (`restore` then says `` … cannot be read as this user (lyren): pipe it in with `restore -` (see the README). ``): pipe it in, and `restore -` reads it from standard input. `sudo -v` first, so that the two `sudo` in the pipe do not both ask for your password:

  ```sh
  sudo -v
  sudo cat ~/lyren-backup-2026-10-16.tar | sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs restore -
  ```
- **What it takes:** a backup set (`.tar`, from the timer, the `backup` command or **Administration → Overview → Download backup**); one space's database, such as its snapshot from before an import, `restore backups/spaces/<id>/pre-import-<time>.db` (a path relative to the data folder works, from any working folder), which replaces only that space and undoes the import; or a backup made by a version before spaces (`.db`), which the restart then upgrades ([section 12](#12-upgrade-and-roll-back)). It refuses a backup made by a newer version, and the snapshot of a space deleted for good, before anything changes.
- **Until the restart**, nothing changes, and the maintenance commands (the nightly backup too) refuse to run with `A restore is waiting: restart Lyren Plan to complete it, or delete /var/lib/lyren-plan/.restore-pending to cancel it.` To cancel, `sudo -u lyren rm -r /var/lib/lyren-plan/.restore-pending`.
- **If a start was interrupted while it applied the restore** (a power loss, say), the commands say `A restore was interrupted while it was being applied: start Lyren Plan to finish it. Do not delete /var/lib/lyren-plan/.restore-pending; the data it replaces is in backups/before-restore-<time>/.` Then do not delete the folder: part of the current data has already moved out, and `sudo systemctl start lyren-plan` finishes the restore.
- **If the restart says** `Lyren Plan is still running with this data folder. Stop it, then start it again to complete the restore.`, another process still had the data open (a second server, say): stop it, then start the service again.
- Sign in with the password that was valid when the backup was made. Backup sets contain no sign-in sessions, so every device signs in again. A restored space keeps its members as they are now.
- A backup from an older version is migrated when the server starts (after writing a before-upgrade snapshot).
- **On a new server**, restore before the first start: follow sections 2 to 5, create the data folder with `sudo install -d -o lyren -g lyren -m 700 /var/lib/lyren-plan`, run the `restore` command above, then `sudo systemctl enable --now lyren-plan`.

**By hand**, without the command (for example to look at a backup on another machine): stop the service, move the current data aside, and extract the set **as `lyren`**. A `tar -x` run by root would create files owned by root, which the service cannot open (`unable to open database file`).

```sh
sudo systemctl stop lyren-plan
sudo -u lyren sh -c 'cd /var/lib/lyren-plan && d=backups/before-restore-by-hand-$(date +%F-%H%M%S) &&
  mkdir -p -m 700 backups && mkdir -m 700 "$d" .restore-tmp &&
  for f in lyren.db lyren.db-wal lyren.db-shm spaces; do [ ! -e "$f" ] || mv "$f" "$d"/; done'
sudo -u lyren tar -xf /var/backups/lyren-plan/lyren-2026-10-16-030012.tar -C /var/lib/lyren-plan/.restore-tmp
sudo -u lyren sh -c 'cd /var/lib/lyren-plan && mv .restore-tmp/directory.db lyren.db && mv .restore-tmp/spaces spaces && rm -r .restore-tmp'
sudo systemctl start lyren-plan
```

(Root can also extract with `sudo tar --no-same-owner -xf … -C /var/lib/lyren-plan/.restore-tmp` and then `sudo chown -R lyren:lyren /var/lib/lyren-plan`.)

## 11. Forgotten password

`reset-password` sets a new password, signs the account out on every device and clears any lock-out from failed sign-ins. It takes the account's email address, or the username of an account from before email addresses (such as `owner` after an upgrade from 1.x). It can run while the server runs. It runs as `lyren`, with the service's `DATA_DIR`:

```sh
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs reset-password you@example.com
```

This generates a password and prints it: `New password for you@example.com: xHYAsWKjnC47GeIL`. To choose the password yourself, pipe it in, so that it appears neither on the screen nor in your shell history. `sudo -v` first makes sudo ask for your own password before the pipe starts, and `IFS=` keeps spaces at the start or end of the new password (`read` would drop them otherwise):

```sh
sudo -v
IFS= read -rsp 'New password: ' PW; echo
printf '%s\n' "$PW" | sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs reset-password you@example.com
unset PW
```

It answers `Password updated for you@example.com.` and `Any lock-out from failed sign-ins has been cleared.`

- Replace `you@example.com` with the account's address. Forgot it? Any name lists up to 20 accounts: `No account with the email address or username "x". Accounts: you@example.com, …`.
- The password must be 8 to 256 characters (8 is the instance's minimum unless an admin changed it); anything else changes nothing.
- **No admin can sign in?** `promote-admin <email-or-username>` makes an account an instance admin, with the same `sudo -u lyren env DATA_DIR=… node … server.mjs` in front.

## 12. Upgrade and roll back

Download and check the new version as in [section 4](#4-download-and-install-a-release), and extract it next to the running one:

```sh
VERSION=1.1.0
cd "$(mktemp -d)"
base=https://github.com/<owner>/<repo>/releases/download/v$VERSION
curl -fLO "$base/lyren-plan-$VERSION-node.tar.gz"
curl -fLO "$base/lyren-plan-$VERSION-node.tar.gz.sha256"
sha256sum -c "lyren-plan-$VERSION-node.tar.gz.sha256" &&
  sudo tar -xzf "lyren-plan-$VERSION-node.tar.gz" -C /opt/lyren-plan --no-same-owner
```

Go on only if `sha256sum` printed `OK`: the new version is then in its own folder next to the running one (`ls /opt/lyren-plan`). If you build the archives on the server, [section 18](#18-alternative-build-the-release-on-the-server) replaces this step.

Then back up with the version that still runs, stop it, switch `current`, and start the new one:

```sh
sudo systemctl start lyren-plan-backup
sudo systemctl stop lyren-plan
sudo ln -sfn "lyren-plan-$VERSION" /opt/lyren-plan/current
sudo systemctl start lyren-plan
journalctl -u lyren-plan -n 10 --no-pager
```

The journal shows `Lyren Plan 1.1.0 listening on ...` (if not yet, run the `journalctl` line again a second later). When the new version changes a database, it first writes a snapshot and says so: `[lyren] Database snapshot written to /var/lib/lyren-plan/backups/directory-v1-before-upgrade-<time>.db before upgrading schema v1 -> v2` (a space's go to `backups/spaces/<id>/`). Browsers load the new web app on their next page load; close and reopen an installed PWA.

**From 1.x to the version with spaces.** Its first start turns the single database of 1.x into the accounts (`lyren.db`) and one space with all your data (`spaces/<id>.db`, with the same ids, task references and links), after saving the old file as `backups/lyren-v1-before-upgrade-<time>.db`. The journal shows `Upgraded the database for multi-user spaces: your data is now in the space "<your name>'s space" (spaces/<id>.db). The old database was saved as backups/lyren-v1-before-upgrade-<time>.db.` Signed-in browsers stay signed in, and the old username keeps working at the sign-in form. Reload any Lyren Plan tab that was open during the upgrade: until then it runs the old app, whose pages say `Lyren Plan has been updated. Reload the page to continue.` If something else still has the old file open (a 1.x server that is still running), it stops with `Lyren Plan or another program still has /var/lib/lyren-plan/lyren.db open. Stop it and start Lyren Plan again.` and changes nothing; systemd tries again 5 seconds later. A 1.x server started while the upgrade runs stops with `database disk image is malformed`: keep it stopped. Until that first start, the nightly `backup` keeps writing 1.x-style backups (`.tar` in the name, a 1.x database inside, which `restore` accepts), and the other maintenance commands refuse to run.

Why stop before switching: the backup timer and the maintenance commands run whatever `current` points to, and a newer version upgrades the database as soon as it opens it. That must not happen while the older version is still serving.

Keep the previous version's folder until you are sure you won't roll back. To tidy up later, `ls /opt/lyren-plan` lists the versions and `readlink /opt/lyren-plan/current` the one that runs; remove an old one with `sudo rm -rf /opt/lyren-plan/lyren-plan-1.0.0`, never the one `current` points to (the running server serves its web app from there).

**Roll back** to the previous version:

```sh
sudo systemctl stop lyren-plan
sudo ln -sfn lyren-plan-1.0.0 /opt/lyren-plan/current
```

If the upgrade changed the data (the journal showed a snapshot or upgrade line above), the old version cannot open it any more: put the snapshot from before the upgrade back. Everything changed since the upgrade is lost, and the snapshot still contains the sign-in sessions of that moment. Do it as `lyren`, so that every file keeps belonging to the service. For an upgrade from 1.x (the old version has no `restore` command):

```sh
sudo ls /var/lib/lyren-plan/backups
sudo -u lyren sh -c 'cd /var/lib/lyren-plan && d=backups/rolled-back-$(date +%F-%H%M%S) && mkdir -m 700 "$d" &&
  for f in lyren.db lyren.db-wal lyren.db-shm spaces; do [ ! -e "$f" ] || mv "$f" "$d"/; done'
sudo -u lyren cp /var/lib/lyren-plan/backups/lyren-v1-before-upgrade-<time>.db /var/lib/lyren-plan/lyren.db
```

After an upgrade between two versions with spaces, move the same files aside and put back `backups/directory-v<N>-before-upgrade-<time>.db` as `lyren.db` and each `backups/spaces/<id>/space-v<N>-before-upgrade-<time>.db` as `spaces/<id>.db`, all as `lyren`. A space is upgraded, and gets such a snapshot, only when it is first opened: one without a snapshot was not changed, so put its `spaces/<id>.db` back from the folder you moved aside.

Then start it again:

```sh
sudo systemctl start lyren-plan
```

- Started on the upgraded data by mistake, 1.x refuses it: `Database schema version 100 is newer than this build supports (1). Upgrade the app.`, followed by a stack trace. The trace is expected; nothing was changed.
- Upgrading again later starts from the restored 1.x file, and moves the space file of the earlier upgrade, if you left it in `spaces/`, to `backups/orphaned-<time>/`.

## 13. Logs

The app writes to standard output, which systemd puts in the journal:

```sh
journalctl -u lyren-plan -f                      # follow (Ctrl+C ends)
journalctl -u lyren-plan -b --no-pager           # since the last boot
journalctl -u lyren-plan --since "1 hour ago"
journalctl -u lyren-plan-backup -n 20 --no-pager # the backups
systemctl status lyren-plan                      # state, and the last lines
```

- The app logs its errors at the same priority as everything else, so `journalctl -p err` does not show them. Search with `grep` instead, or read the lines around a start.
- Every request is logged with `LOG_REQUESTS=true` (see [Settings](#14-settings)).
- The journal keeps logs across reboots on Ubuntu (`/var/log/journal`) and limits their size by itself.

## 14. Settings

The app is configured with the environment variables listed in the README under [Configuration](../README.md#configuration). Change them with a drop-in file instead of editing the unit file: `override.conf` is the file that `sudo systemctl edit lyren-plan` would open. For example, shorter sessions and a log line for every request:

```sh
sudo mkdir -p /etc/systemd/system/lyren-plan.service.d
sudo tee /etc/systemd/system/lyren-plan.service.d/override.conf > /dev/null <<'EOF'
[Service]
Environment=SESSION_TTL_DAYS=14
Environment=LOG_REQUESTS=true
EOF
sudo systemctl daemon-reload
sudo systemctl restart lyren-plan
systemctl cat lyren-plan                         # the unit with its drop-ins
```

- An invalid value stops the server with a message naming the variable, and systemd does not restart it ([Troubleshooting](#16-troubleshooting)).
- A different `PORT` must also go into the proxy's configuration (`proxy_pass` or `reverse_proxy`).
- `Environment=` values are not secret: every local user can read them with `systemctl show lyren-plan`, and the drop-in files are readable by everyone. That matters for the secrets: `SETUP_TOKEN`, `SMTP_PASS`, `RESEND_API_KEY` and `RECOVERY_TOKEN`. Keep each in a file only root can read, loaded with `EnvironmentFile=`, as the mail and setup code examples below do.

**A data folder of your own.** A `DATA_DIR` outside `/var/lib/lyren-plan`, for example `/srv/lyren-plan`, must belong to `lyren` with mode 0700, and **both** services need it, each with `ReadWritePaths=` for it: `ProtectSystem=strict` makes everything else read-only, and the backup has to write the data folder too (with a read-only view it fails whenever the server is stopped). Write literal paths; `ReadWritePaths=` does not expand variables. Set this up before the first start (with data already in `/var/lib/lyren-plan`, stop the service and copy it over first with `sudo cp -a /var/lib/lyren-plan/. /srv/lyren-plan/`):

```sh
sudo install -d -o lyren -g lyren -m 700 /srv/lyren-plan
sudo mkdir -p /etc/systemd/system/lyren-plan.service.d /etc/systemd/system/lyren-plan-backup.service.d
sudo tee /etc/systemd/system/lyren-plan.service.d/data-dir.conf > /dev/null <<'EOF'
[Service]
Environment=DATA_DIR=/srv/lyren-plan
ReadWritePaths=/srv/lyren-plan
EOF
sudo cp /etc/systemd/system/lyren-plan.service.d/data-dir.conf /etc/systemd/system/lyren-plan-backup.service.d/
sudo systemctl daemon-reload
sudo systemctl restart lyren-plan
```

The maintenance commands then need `DATA_DIR=/srv/lyren-plan` too (`sudo -u lyren env DATA_DIR=/srv/lyren-plan node ...`), and the paths in [Restore](#10-restore-a-backup) change accordingly. Run them as `lyren`, as everywhere in this guide: run as root, they refuse to touch the data.

**Mail.** Without it (the default), nothing is sent: invitations are links that the inviter passes on, and an administrator makes password reset links (**Administration → Users**). With mail, invitations, sign-up, forgotten passwords and address checks work by mail. The README's [Mail](../README.md#mail) section lists the variables; mail also needs `PUBLIC_URL` ([7.4](#74-the-public-address-links-and-passkeys)). The ones that are not secret go into a drop-in; the password (`SMTP_PASS`, or `RESEND_API_KEY` with `MAIL_TRANSPORT=resend`) goes into a file in a folder that only root can open, which systemd reads before it starts the service (`systemctl show` shows only its path). Put your provider's values in place of the examples:

```sh
sudo install -d -m 700 /etc/lyren-plan
sudo install -m 600 /dev/null /etc/lyren-plan/mail.env
sudo tee /etc/lyren-plan/mail.env > /dev/null <<'EOF'
SMTP_PASS=your-mail-password
EOF
sudo mkdir -p /etc/systemd/system/lyren-plan.service.d
sudo tee /etc/systemd/system/lyren-plan.service.d/mail.conf > /dev/null <<'EOF'
[Service]
Environment=MAIL_TRANSPORT=smtp
Environment=MAIL_FROM=plan@example.com
Environment=SMTP_HOST=smtp.example.com
Environment=SMTP_SECURITY=tls
Environment=SMTP_USER=plan@example.com
EnvironmentFile=/etc/lyren-plan/mail.env
EOF
sudo systemctl daemon-reload
sudo systemctl restart lyren-plan
```

Then send yourself a test message from **Administration → Overview**, and verify your own address (**Account settings → Profile**): inviting by mail needs a verified address. The service's `RestrictAddressFamilies=` already allows the outbound connection to the mail server. Without a `-` in front of its path, a missing `mail.env` keeps the service from starting instead of leaving the password out. A mail server whose certificate comes from a private certificate authority also needs `Environment=NODE_EXTRA_CA_CERTS=/etc/lyren-plan/relay-ca.pem` (the authority's certificate, which is no secret; the `lyren` user must be able to read it, so keep it outside the 0700 folder, for example in `/usr/local/share/ca-certificates/`).

**Who can create accounts, and invitations.** Nobody can sign up on their own by default (`invite_only`): the people you work with get an account by accepting an invitation, which a space's admins and owners send from its **Settings → Invitations**, and administrators from **Administration → Invitations** (an account without a space). With mail the invitation is emailed; without it you get a link to pass on, which works for 7 days. To change the policy, use **Administration → Settings**, or the command line:

```sh
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs policy
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs policy closed
```

The first prints the policy, the second sets it: `invite_only`, `closed` (only administrators' invitations create accounts) or `open` (anyone can sign up with an address that a mailed link confirms; refused without mail). `SIGNUP_POLICY` in a drop-in only sets the first value, when the data is created. `promote-admin <email>` makes an account an instance administrator, and `spaces` lists the spaces with their owners and sizes.

**The recovery token** ([Locked out](../README.md#locked-out)) is a secret too: put `RECOVERY_TOKEN=…` in `/etc/lyren-plan/recovery.env` the same way, load it with a drop-in of its own (`EnvironmentFile=/etc/lyren-plan/recovery.env`), and remove both files and run `sudo systemctl daemon-reload` and `sudo systemctl restart lyren-plan` once you are back in.

**A setup code of your own.** The generated setup code (section 6) is the simpler choice. If you want to choose it with `SETUP_TOKEN`, keep it in a file in a folder that only root can open (mode 0700), and load that with `EnvironmentFile=`: systemd reads the file before it starts the service, and `systemctl show` shows only its path. Put your code in place of `choose-a-long-code`:

```sh
sudo install -d -m 700 /etc/lyren-plan
sudo tee /etc/lyren-plan/setup.env > /dev/null <<'EOF'
SETUP_TOKEN=choose-a-long-code
EOF
sudo mkdir -p /etc/systemd/system/lyren-plan.service.d
sudo tee /etc/systemd/system/lyren-plan.service.d/setup-token.conf > /dev/null <<'EOF'
[Service]
EnvironmentFile=-/etc/lyren-plan/setup.env
EOF
sudo systemctl daemon-reload
sudo systemctl restart lyren-plan
```

The journal then shows that code as the setup code. Once your account exists the code is not used any more: remove both files with `sudo rm /etc/lyren-plan/setup.env /etc/systemd/system/lyren-plan.service.d/setup-token.conf` and run `sudo systemctl daemon-reload`. (The `-` in `EnvironmentFile=-` lets the service start even when the file is missing.)

## 15. Node.js security updates

With this setup, Node.js gets its security updates **from Ubuntu only**, through `apt` like any other package. What that means:

- `nodejs` is in **universe**. Canonical's standard security maintenance covers the main component; universe packages are maintained by the community, and Canonical covers them through **Ubuntu Pro** ("Expanded Security Maintenance for Applications", esm-apps), which is free for personal use on up to 5 machines: `sudo pro attach <token>`, then `pro security-status` shows what it covers.
- Updates arrive later than upstream, if at all. When this guide was written (October 2026), Ubuntu 26.04 had Node.js 22.22.1, while Node.js 22 had had three security releases since (22.22.2, 22.23.0 and 22.23.2), and [Ubuntu's CVE tracker](https://ubuntu.com/security/cves) listed their vulnerabilities as not yet assessed for 26.04, with Ubuntu Pro too.
- Node.js 22 reaches its upstream end of life on 30 April 2027; Ubuntu 26.04 is supported until 2031. After that date, fixes for Node.js 22 can only come from Ubuntu.
- Install updates as usual (`sudo apt update && sudo apt upgrade`, or unattended-upgrades, which on Ubuntu installs security updates automatically). The service must restart to use an updated Node.js or one of its libraries (libnode, SQLite, OpenSSL); needrestart, which Ubuntu Server installs by default, normally restarts it right after the upgrade. Otherwise run `sudo systemctl restart lyren-plan`; `systemctl status lyren-plan` shows since when it runs.
- The setup above limits Node.js's exposure: the app listens on 127.0.0.1 only, so other computers reach it only through nginx (security-maintained in main), which parses every request before passing it on, and it runs inside a tight sandbox. That narrows the risk of an unpatched Node.js; it does not remove it. Programs and accounts on the server itself can still connect to 127.0.0.1:8080 directly, and because the app trusts `X-Forwarded-For` (`TRUST_PROXY=true`), they can make up the client address that the sign-in rate limit and the list of signed-in devices see. That matters only on a server shared with people you do not trust.
- If you need upstream Node.js security releases as soon as they appear, that takes a Node.js from outside Ubuntu, which this guide deliberately does not use.

## 16. Troubleshooting

First look at `systemctl status lyren-plan` and `journalctl -u lyren-plan -n 50 --no-pager`. Start-up problems are explained in a few plain lines (a stack trace means something unexpected; please report it).

| What you see | Cause and fix |
|---|---|
| `status=203/EXEC` | `/usr/bin/node` is missing: `sudo apt install --no-install-recommends nodejs`. |
| `status=217/USER` | The user `lyren` does not exist: [section 3](#3-create-the-service-user). |
| `status=226/NAMESPACE` | A folder named in `ReadWritePaths=` does not exist (every one must): for the backup, `/var/backups/lyren-plan` (`sudo install -d -o lyren -g lyren -m 700 /var/backups/lyren-plan`); with a [data folder of your own](#14-settings), that folder. |
| `Error: Cannot find module '/opt/lyren-plan/current/server.mjs'` | `current` is missing or points to a folder that isn't there: `ls -l /opt/lyren-plan`, then `sudo ln -sfn lyren-plan-<version> /opt/lyren-plan/current`. |
| `Invalid value for PORT: ... (expected 1..65535)`, `status=2/INVALIDARGUMENT`, not restarted | Correct the named variable (unit file or drop-in), then `sudo systemctl daemon-reload` and `sudo systemctl restart lyren-plan`. The same for every setting, such as `Invalid value for PUBLIC_URL: …`, `MAIL_FROM is required with MAIL_TRANSPORT=smtp` or `WEBAUTHN_RP_ID is set, but passkeys are off: …`. |
| No passkey button on the sign-in page, and none in **Account settings → Security** | Passkeys need `PUBLIC_URL` with an `https` address ([7.4](#74-the-public-address-links-and-passkeys)), and the page opened at exactly that address (not at the server's IP address or another name). **Administration → Overview** warns while `PUBLIC_URL` is not set. |
| **Administration → Overview → Send a test email** fails | The answer names the mail server's error: a wrong `SMTP_HOST`, port or `SMTP_SECURITY`, a refused login (`SMTP_USER`, the password in `mail.env`), or a certificate the server's name does not match ([Settings](#14-settings)). |
| `Could not open the database /var/lib/lyren-plan/lyren.db: unable to open database file` (or `: attempt to write a readonly database`), followed by `... must be writable by the user running the server (uid ...)` and `Give them to that user (e.g. sudo chown -R <uid> /var/lib/lyren-plan) ...` | The database or the folder does not belong to `lyren`, or `lyren` can read it but not write it, typically after a restore with `sudo cp` (which creates 0644 files owned by root where there was no file) or `sudo mv`: `sudo chown -R lyren:lyren /var/lib/lyren-plan`. With a `DATA_DIR` of your own: it is missing from `ReadWritePaths=`, see [Settings](#14-settings). |
| The app answers `The server cannot open this space's data; its log says why.` for one space, and the journal has `[lyren] Could not open the database /var/lib/lyren-plan/spaces/<id>.db: …` | The same cause for that space's file (`spaces/` and its files must belong to `lyren` too): `sudo chown -R lyren:lyren /var/lib/lyren-plan`. The space opens again at its next request; no restart is needed. |
| `Could not open the database ...: ENOENT: no such file or directory, mkdir '...'` with `can't be created because a directory above it (or its drive) does not exist` | `DATA_DIR` points outside `/var/lib/lyren-plan`, and that folder does not exist, or is not in `ReadWritePaths=` (the read-only file system is then reported as a missing folder). See [Settings](#14-settings). |
| `... It does not exist yet, and this user cannot create it in ...` | A `DATA_DIR` of your own that does not exist, in a folder `lyren` cannot write: create it for `lyren`, `sudo install -d -o lyren -g lyren -m 700 <folder>`, and name it in `ReadWritePaths=` ([Settings](#14-settings)). |
| `... is a file, not a folder.` | A file stands where the data folder should be: move it away, or correct `DATA_DIR`. |
| `Port 8080 is already in use on 127.0.0.1: is Lyren Plan (or another server) already running?` | `sudo ss -ltnp 'sport = :8080'` shows which program uses it. Stop that, or set another `PORT` (and change the proxy too). The service retries every 5 seconds. |
| `Not allowed to listen on port 80 (ports below 1024 need extra privileges).` | Keep 8080 and let nginx or Caddy serve ports 80 and 443. |
| `HOST=... is not an address of this machine.` | Use `127.0.0.1`, `0.0.0.0` or `::`. |
| `Web client not found: no index.html in /opt/lyren-plan/lyren-plan-1.0.0/web.`, and the browser says the web client is missing | The release folder is incomplete, or the folder of the running version was deleted: extract the release again, then `sudo systemctl restart lyren-plan`. |
| `Database schema version 100 is newer than this build supports (1). Upgrade the app.` (1.x, with a stack trace), or `… is newer than this build supports …` | An older version was started on data that a newer one has upgraded: point `current` at the newer version again, or [roll back](#12-upgrade-and-roll-back) with the before-upgrade snapshot. |
| `Lyren Plan or another program still has /var/lib/lyren-plan/lyren.db open. Stop it and start Lyren Plan again.` | The upgrade from 1.x changes nothing while something else has the database open: stop the other server (a 1.x one still running, say); systemd starts the service again by itself. |
| `This data has not been upgraded yet. Start Lyren Plan once with this version, then run the command again.` from a maintenance command | A 1.x database: start the service once with this version ([section 12](#12-upgrade-and-roll-back)). |
| `Run this as the owner of /var/lib/lyren-plan, for example: sudo -u lyren …` | A maintenance command was run as root: run it with `sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node ...`. |
| `A restore is waiting: restart Lyren Plan to complete it, or delete /var/lib/lyren-plan/.restore-pending to cancel it.` | `sudo systemctl restart lyren-plan` completes the restore ([section 10](#10-restore-a-backup)); `sudo -u lyren rm -r /var/lib/lyren-plan/.restore-pending` cancels it. |
| `A restore was interrupted while it was being applied: start Lyren Plan to finish it. Do not delete …` | A start stopped halfway through a restore: `sudo systemctl start lyren-plan` finishes it. Keep the folder. |
| `The staged restore in /var/lib/lyren-plan/.restore-pending is incomplete.` or `… was made by a newer version of Lyren Plan. …` at start | The staged files cannot be used (files missing, or staged by a newer version); nothing was moved. Delete that folder as `lyren` and run `restore` again, with this version (or install the newer one). |
| `` … cannot be read as this user (lyren): pipe it in with `restore -` (see the README). `` from `restore` | `lyren` cannot open the file or a folder on its way: pipe it in ([section 10](#10-restore-a-backup)). |
| `Lyren Plan is still running with this data folder. Stop it, then start it again to complete the restore.` | Another process has the data open: stop it, then `sudo systemctl start lyren-plan`. |
| `No database at /home/you/data/lyren.db.` from `backup` or `reset-password` | The command did not get `DATA_DIR=/var/lib/lyren-plan`: use `sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node ...` exactly as shown. `sudo -E` does not pass it (sudo-rs: `'-E' is ignored`). |
| `... already exists; choose a new file name.` from `backup` | `backup` never overwrites a file. Choose another name. |
| `This is not a Lyren Plan backup set: …`, `… is not a Lyren Plan backup: …` or `This backup was made by a newer version of Lyren Plan. …` from `restore` | The file is not a backup this version can restore; nothing was changed. |
| `This account is currently not available.` | `sudo -i -u lyren` or `sudo su lyren`: the account has no shell. Run the single command with `sudo -u lyren`. |
| `code=killed, status=5/TRAP` with `# Fatal error ... Check failed` | `MemoryDenyWriteExecute=yes` was added to the unit: remove it. |
| `(node:1234) ExperimentalWarning: SQLite is an experimental feature ...` | Harmless; that `node` command lacks `--disable-warning=ExperimentalWarning`. |
| nginx answers `502 Bad Gateway` | Lyren Plan is not running, or on another port: `systemctl status lyren-plan`, `curl -fsS http://127.0.0.1:8080/api/health`. |
| nginx answers `413 Request Entity Too Large` for an import | `client_max_body_size 50m;` is missing from the site. |
| Sign-in answers "Too many attempts" (HTTP 429) | Wait 15 minutes, or clear the lock-out with `reset-password` ([section 11](#11-forgotten-password)). |

## 17. Uninstall

```sh
sudo systemctl disable --now lyren-plan-backup.timer lyren-plan.service
sudo systemctl clean --what=state lyren-plan-backup.timer
sudo rm -f /etc/systemd/system/lyren-plan.service /etc/systemd/system/lyren-plan-backup.service /etc/systemd/system/lyren-plan-backup.timer
sudo rm -rf /etc/systemd/system/lyren-plan.service.d /etc/systemd/system/lyren-plan-backup.service.d /etc/lyren-plan
sudo systemctl daemon-reload
sudo rm -rf /opt/lyren-plan
```

`systemctl clean --what=state` removes the time stamp that `Persistent=true` keeps for the timer. The proxy: for nginx, `sudo rm /etc/nginx/sites-enabled/lyren-plan /etc/nginx/sites-available/lyren-plan`, `sudo systemctl reload nginx` and `sudo certbot delete --cert-name plan.example.com`; for Caddy, remove the site from `/etc/caddy/Caddyfile`. Firewall rules: `sudo ufw status numbered`, then `sudo ufw delete <number>`.

The data, the backups and the user are deleted for good with the commands below (add a [data folder of your own](#14-settings) to the `rm`); copy what you want to keep first.

```sh
sudo rm -rf /var/lib/lyren-plan /var/backups/lyren-plan
sudo userdel lyren
```

`sudo apt remove nodejs && sudo apt autoremove` removes Node.js, if nothing else uses it.

## 18. Alternative: build the release on the server

You can also build the release archive yourself from the source code, for example to run a commit that has no release. That needs Ubuntu's npm package, which brings several hundred packages (about 360 with `--no-install-recommends`), and git. Build as your own user, not as root:

```sh
sudo apt install --no-install-recommends npm git
git clone https://github.com/<owner>/<repo>.git lyren-plan-src
cd lyren-plan-src
git checkout v1.0.0
npm ci --ignore-scripts
npm run package:node
```

`npm run package:node` builds the app and writes `dist/lyren-plan-<version>-node.tar.gz` with its `.sha256` file: an archive with the same files as the release's (its checksum differs, because the files carry the time of your build). `--ignore-scripts` keeps the packages' install scripts from running; the build does not need them. Install the archive as in [section 4](#4-download-and-install-a-release), without the downloads, from the `lyren-plan-src` folder:

```sh
sudo install -d -m 755 /opt/lyren-plan
sudo tar -xzf dist/lyren-plan-1.0.0-node.tar.gz -C /opt/lyren-plan --no-same-owner
sudo ln -sfn lyren-plan-1.0.0 /opt/lyren-plan/current
```

**To upgrade**, build the new version's archive in the same folder and extract it next to the running one:

```sh
VERSION=1.1.0
git fetch --tags
git checkout "v$VERSION"
npm ci --ignore-scripts
npm run package:node
sudo tar -xzf "dist/lyren-plan-$VERSION-node.tar.gz" -C /opt/lyren-plan --no-same-owner
```

Then continue with the second block of [section 12](#12-upgrade-and-roll-back): back up, stop, switch `current`, start. (`git pull` does not work in this folder: after `git checkout` of a tag it is on no branch.)

## 19. How this guide was tested

On Ubuntu 26.04 (in WSL 2) with systemd 259, without root. Ubuntu's `nodejs` 22.22.1 was not installed with apt: the packages that `sudo apt install --no-install-recommends nodejs` installs were downloaded with apt, checked against apt's checksums, unpacked with `dpkg-deb -x` and run from there, with Node.js's library and file paths pointed at the unpacked copy. The release archive was also run on Node.js 22.13.0, the oldest supported version, with `scripts/ci/smoke-node.sh` (start, `backup`, the restore of a backup set, and the upgrade from a 1.x database made by the previous release). Tested that way:

- the release archive: download check (also with a damaged and a missing download), extraction, `help`, start, health check, web app, setup, `backup`, restore, `reset-password`, stop with SIGTERM, upgrade and roll-back between two versions, also with archives built on the server (section 18, with Ubuntu's npm 9.2.0);
- for the version with spaces: the upgrade from a 1.x database made by the previous release, sign-in with the old password afterwards, 1.x refusing the upgraded data, the roll-back to the 1.x snapshot, backup sets, `restore` of a set, of one space's pre-import snapshot and from standard input, run as the developer's own user rather than as `lyren` (the units themselves were not run again); the refusal as root only in the unit tests, with an injected uid (not run as root);
- `systemd-analyze verify` and `systemd-analyze security` on the unit files exactly as printed here (the public address drop-in of [7.4](#74-the-public-address-links-and-passkeys) and the mail drop-in of [Settings](#14-settings), added later, only with `systemd-analyze verify` together with the unit: they were not run under systemd; the `policy` command as shown, on a copy of a data folder);
- the three units and the drop-ins (LAN only, settings, a data folder of your own, a setup code of your own) under systemd's per-user service manager with the same settings, except that it runs them as the logged-in user (no `User=` and `Group=`), cannot apply `PrivateNetwork=` and `RemoveIPC=`, and keeps the data folder in the home folder (so `ProtectHome=tmpfs` with that folder bound in, instead of `ProtectHome=yes`);
- Ubuntu's nginx 1.28 (unpacked like Node.js) with the site above, `nginx -t` and proxying to the app, with a self-signed certificate in place of certbot's; Caddy 2.11 from Caddy's GitHub release with the Caddyfile above; the apt source of Caddy's repository with `apt update` as a normal user; the ufw commands checked with ufw's own parser, without applying them.

Not tested: anything that needs root on a real server, that is `apt install` itself (of nodejs, nginx and Caddy), `useradd`, sudo-rs, the units run by the system service manager as `lyren` (with `/var/lib`, `/var/backups` and the sandboxing options that only it applies), and turning ufw on; certbot and getting certificates from Let's Encrypt; needrestart and unattended-upgrades; Ubuntu Pro; AppArmor (off in WSL); arm64. Please report anything that does not work as described.
