# Lyren Plan

Lyren Plan is a self-hosted project manager for you and the people you work with. You track projects, which hold milestones, epics and tasks. Saved boards show your tasks the way you want. Every task has comments, a work log and a full change history. The projects live in **spaces**: every account has one of its own, and you can make more and share each with others by invitation, as an owner, admin, member or viewer. One Node.js process serves the web app and its JSON API, and all data lives in SQLite files: one for the accounts, one per space. It needs no external database and no third-party services (mail is optional), and the browser never loads anything from another origin. It works in desktop and mobile browsers and can be installed as a PWA. On Windows it also comes as a single program that needs nothing else installed: see [Windows app](#windows-app). It can also run on Cloudflare, on the free plan to start with when the runbook's CPU checks pass: see [Cloudflare](#cloudflare).

- [Features](#features)
- [Spaces, members and roles](#spaces-members-and-roles)
- [Quick start](#quick-start)
- [Ubuntu Server with systemd](docs/ubuntu-server.md) (separate guide)
- [Windows app](#windows-app)
- [Docker](#docker)
- [Cloudflare](#cloudflare)
- [Configuration](#configuration)
- [Reverse proxy and HTTPS](#reverse-proxy-and-https)
- [Data, backups and restore](#data-backups-and-restore)
- [Upgrading](#upgrading)
- [Forgotten password](#forgotten-password)
- [Security notes](#security-notes)
- [Development](#development)

---

## Features

| You asked for | What Lyren Plan does |
|---|---|
| Track different projects | Each project has a key (for example `WEB`) that prefixes task refs (`WEB-42`), a color, a status (active, on hold, completed, archived), a Markdown description and a progress bar. Each project page has four tabs: Overview, Board, Tasks and Activity. Archived projects are listed separately and their tasks are hidden by default. Progress counts archived tasks that were finished, so archiving done work never moves a bar backwards; archived open tasks no longer count. |
| Milestones in each project | Milestones have a status (planned, active, completed, cancelled), start and due dates, and progress rolled up from their epics' tasks. You can reorder them by dragging or from a menu. |
| Epics in milestones | An epic belongs to a project and optionally to one of its milestones. It has a color, a status (open, in progress, done, cancelled), dates and progress. You can move an epic between milestones. |
| Tasks in epics | A task belongs to a project and optionally to an epic; its milestone is the epic's milestone. A task has a title, a Markdown description, a status and a priority (none, low, medium, high, urgent). It also has tags, start and due dates, an estimate in points or hours (a setting), a manual order and an archive flag. Tasks can be duplicated or moved to another project, which gives them a new ref; a task moved back to a project it was in (for example with **Undo**) gets its old ref there again, so links to it keep working. A task opens in a side drawer or as a full page at `/s/<space>/tasks/WEB-42` (links from before spaces, such as `/tasks/WEB-42`, still lead there). Task lists (a project's Tasks tab, and the epic and milestone pages) hide closed and archived tasks until you tick **Closed** or **Archived**; an empty list says when everything in it is closed or archived and offers to show it. **Select** mode, in task lists and on boards, changes the status, priority, due date, epic or tags of several tasks at once, archives or unarchives them, or deletes them. |
| Highly configurable boards | Boards are saved views of your tasks. Boards of the whole space live on the Boards page, and each project can have several boards on its Board tab. See [Boards](#boards) below. |
| Tag tasks | Tags are colored and belong to the space. You can rename, recolor, merge and delete them, and create new ones while tagging a task. |
| Comments | Comments are written in Markdown (GitHub-flavored), and you can edit or delete your own (a space's admins and owners can delete anyone's). Unsent drafts are kept per task. Closing the task while you edit a comment or a work-log entry saves the edit; only **Cancel** discards it (a changed comment asks first). |
| Log activity (work log) | Every task has a work log. Each entry has a date, the time spent (`1h 30m`, `90`, `1.5h` and `1:30` all work) and a note. The task shows its total against the estimate when the estimate is in hours. The **Work log** page reports logged time by range (this week, last week, this month, last 30 days or custom), with totals per project and per day. |
| Log activity (history) | Changes are recorded automatically, field by field: title, description, status, priority, epic, dates, estimate, tags, archive and moves between projects. Changes to projects, milestones and epics, comments and work logs are recorded too. You can read the history on each task, on each project's Activity tab, and on the global Activity page. |
| Share with other people | Each space has its own members, with a role each: viewers read, members write, admins also manage statuses, tags and members, owners also invite admins, export, import and delete the space. People join by an invitation sent by mail, or by a link you pass on when the server sends no mail; open sign-up is an option for administrators. See [Spaces, members and roles](#spaces-members-and-roles). |
| Sign in safely | With an email address and a password, or with a passkey. Addresses are verified by a link when the server sends mail. A forgotten password is reset by mail, by an administrator's reset link, or on the command line. |
| Move a space to another instance | An owner downloads the space as one archive file and imports it on any instance (or the same one) into a new space, or over an existing one. The import maps the people the archive names to accounts there, by email address where it can, or keeps them as former members by name. |
| Self-hostable, no third parties | Runs as `npm ci && npm run build && npm start`, from a release archive on the system's Node.js, with Docker, or as a single program on Windows. The data is in SQLite files in one folder. There are no CDNs, web fonts, analytics or outbound calls (except to the mail server you configure), and the Content-Security-Policy blocks them. It also deploys to Cloudflare (the free plan, when the runbook's CPU checks pass), from this repository with no secret in it. |
| Web browser and mobile browser | Every screen works from 360 px wide. Phones get a bottom navigation bar (its **More** sheet holds the space switcher, Activity, Work log, Settings, Account settings, Administration for instance administrators, the theme and Sign out), a floating "+" button for new tasks, and full-screen sheets that the Back gesture closes. Board cards are dragged with a long press, and every card also has a menu that does the same moves without dragging. The app installs as a PWA and keeps its shell available offline. |

Also included:

- **Dashboard** with tasks that are overdue, due today, due in the next 7 days or in progress, plus tasks closed in the last 7 days. It also shows recent activity, progress for each active project, and the time logged today and this week. The tiles and each list's badge show exact totals. Each list shows its first 5 tasks; **Show N more** shows the rest, loading a long list in full and adding rows 200 at a time.
- **Search and command palette** (`mod+K` or `/`). It searches tasks (title, description and ref), projects, milestones, epics and boards. Archived tasks are found too: they are labelled **Archived** and come after live tasks that match as well. The palette also runs actions (new task, go to a page, switch theme, keyboard shortcuts) and lists recently opened items, refreshed from the server each time it opens, so a task archived, renamed or deleted on another device shows as it is now.
- **New tasks start in context.** The "+" button, `c`, the sidebar's New task and the palette's New task fill in the project and epic of the task you have open (in the drawer or as a page), else those of the page you are on.
- **Keyboard shortcuts.** Press `?` in the app for the full list. `mod` is Cmd on macOS and Ctrl elsewhere.

  | Where | Keys |
  |---|---|
  | Anywhere | `mod+K` or `/` search and commands · `c` new task · `?` shortcut help · `Esc` close the top dialog, drawer or menu. Single-key shortcuts are paused while you type or while a dialog or menu is open. |
  | Command palette | `↑` `↓` move (also `Ctrl+P` / `Ctrl+N`) · `Enter` open or run · `mod+Enter` open a task as a full page · `Esc` close |
  | Lists, menus, pickers | `↑` `↓` move · `→` `←` open or close a submenu · `Enter` choose |
  | Editors (descriptions, comments, work log, new task) | `mod+Enter` save, send or create · `mod+B` bold · `mod+I` italic · `Esc` leaves the editor: a task description is saved (only its **Cancel** button discards, after asking), a new comment keeps its draft, and editing an existing comment asks before discarding changes |
  | Boards | focus a card, then `Space` or `Enter` to pick it up · arrow keys to move it · `Space` or `Enter` to drop · `Esc` to cancel |

- **Dark mode.** Choose Light, Dark or System for each device, from the user menu, the phone's More sheet, Account settings → Preferences or the command palette.
- **Settings** come in three places.
  - **Account settings** (the user menu, or the phone's More sheet), for you in every space: Profile (display name; your email address, its verification and changes, or the username of a 1.x account, which can add an address there; sign out), Security (password, passkeys, your signed-in devices, which you can sign out, and recent security events), Preferences (theme, first day of the week, and home page: the dashboard or the space's default board) and Danger zone (delete your account).
  - **Settings** of a space (the sidebar), shown by your role there: General (the space's name, the estimate unit, points or hours, and the default board), Members (who is in the space and their roles), Invitations (admins and owners), Statuses, Tags, Data (download the space's archive, import one into a new space, or replace the space with one) and Danger zone (leave the space, transfer ownership, delete the space). Statuses can be added, renamed and reordered; each belongs to one of five fixed categories (backlog, to do, in progress, done, cancelled), and a new one is placed after the last status of its category. The defaults are Backlog, Todo, In Progress, In Review, Done and Cancelled.
  - **Administration** (instance administrators): the **Overview** (warnings, the instance's configuration and limits, what the administrators did lately, a test email, the backup download (a `.tar` backup set of the accounts and every space) and, on your own server or in the desktop app, the notes on running it: backups, restore, password resets), **Settings** (who can create an account, the minimum password length), **Users** (disable or enable an account, make it an administrator, create a password reset link, delete it), **Invitations** to an account of one's own, and **Spaces** (owners, members and size, never the content; delete and restore). Every change asks for your password (or a passkey) again when you last entered it more than a few minutes ago, and every administrator sees every change.
- **First-run setup.** On first start, the server prints a setup code to its log. You enter it on the setup page to create the first account, which is the instance administrator, with your email address, your name and a password, and with or without sample data.
- **Accounts and invitations.** You sign in with your email address. A space's admins and owners invite people from its **Settings → Invitations** (or **Members → Invite people**) with a role: when the server sends mail (see [Mail](#mail)) the invitation is emailed, otherwise you get a link to pass on yourself. The invited person joins with a new account or an existing one, and invitations to a verified address also wait on the **Spaces** page. With mail, administrators can open sign-up (the address is verified by a link first), a forgotten password is reset from the sign-in page's **Forgot password?**, and **Account settings → Profile** changes the email address once the new inbox confirms it; without mail an administrator makes a reset link instead. Every link (`#t=…`) works once, for a limited time.
- **Passkeys.** When the server has an `https` address in `PUBLIC_URL` (or `http://localhost`, see [Configuration](#accounts-and-invitations)), you can sign in with a passkey instead of a password: with **Sign in with a passkey**, or by picking it in the sign-in field's suggestions. Add, rename and remove passkeys in **Account settings → Security**, where an account with a passkey can also remove its password; a sign-up link, an invitation and a password reset link can set up a passkey instead of a password (a reset link's passkey replaces the old password). Passkeys work only at that address: the Windows app, an IP address and other addresses of the server show none of this.

### Boards

A board is a saved configuration. When you change a saved board, the change is saved about 400 ms later; use **Duplicate** to experiment on a copy. New boards can start from a template: Status board, Priority triage, Due this week, Per-project lanes, By epic, Custom columns starter or Blank. A default board called "All tasks" is created on first run.

| Setting | Options |
|---|---|
| Layout | Kanban (columns, optionally with swimlanes) or grouped list. On phones you can switch any board to the list layout for that device only. |
| Columns, grouped by | Status, status category, priority, project, milestone, epic, tag, due date, or **custom columns** |
| Swimlanes, grouped by | None, or any of the fields above, including custom lanes. A lane field that clashes with the column field is not offered. |
| Due-date groups | Earlier (closed) · Overdue · Today · Tomorrow · Later this week · Next week · Later · No due date |
| Custom columns and lanes | Up to 50 per board. Each has a name, a color and a match filter; the first matching column wins and unmatched tasks go to "Other". Each also sets what a drop changes: status, priority, project, epic, tags added or removed, a due date (relative or fixed) or the archive flag. |
| Group display | Reorder, hide or collapse groups. You can choose whether to show empty groups and the "No epic / No tag / ..." group. Columns can have a soft WIP limit; the header shows e.g. `7 / 5` with a warning but never blocks a drop. |
| Filter | Projects; milestones and epics (including "none"); statuses; status categories; priorities; tags (any or all, including untagged); excluded tags; and text, where every word must appear in the title, description or ref. Due presets: overdue, today, tomorrow, this week, next week, next 7 days, next 30 days, no date, has date. Also: archived tasks (exclude, include or only), how many days closed tasks stay visible, and whether to include archived projects. |
| Sort | Manual (drag order), priority, due date, start date, created, updated, title, number, estimate or status; ascending or descending |
| Cards | Which fields show: task key, project, milestone, epic, status, tags, priority, due date, start date, estimate, comment count, time logged, description preview (one line on compact cards, two on comfortable ones). Density: compact or comfortable. A colored edge by project, milestone, epic, priority, status or tag. |
| Quick filters | Text, tags, priorities and "hide closed" in the board header. They are kept in the URL and never saved to the board. On phones, tags, priorities and "hide closed" are in a **Filters** sheet; the button stays in view next to the search and shows how many are on. |

**Drag and drop edits the task.** A drop that changes both column and lane applies both changes. Targets that cannot take the card are dimmed while you drag. On a board with lanes, a label above the dragged card names the target (`→ Payments · In Progress`). A move to another column or lane ends with a toast that says where the task went (and the new ref after a move to another project), with **Undo**; the card menu's moves do the same. To cancel a drag, press `Esc` or release the card off the board (over the sidebar or the header, for example); the label above the card then reads "Release to cancel". On phones, where every column stacks its own lanes, a drag into another column keeps the card in its own lane; move your finger up or down in that column to pick another lane.

| Grouped by | Dropping a card into another group |
|---|---|
| Status | sets that status |
| Status category | sets the first status in that category (the first one the board's status filter allows, if it has one) |
| Priority | sets that priority |
| Project | moves the task to that project (new ref, epic cleared) |
| Epic | sets the epic, which may move the task to the epic's project. "No epic" clears it. |
| Milestone | not a drop target; the milestone comes from the epic. You can only reorder within the group. |
| Tag | replaces the source tag with the target tag. "No tag" removes all tags. A card from "No tag" gets the target tag added. |
| Due date | Today, Tomorrow, Later this week (end of week) and Next week (its first day) set the due date. "No due date" clears it. Overdue, Later and Earlier are not drop targets. |
| Custom | applies the target group's drop settings and removes the tags the source group had added. A toast tells you if the task ends up matching a different group. |

With manual sort, the drop position also sets the task's order (Undo puts it back exactly where it was, on every board and list). With any other sort, cards only move between groups. Every card's `⋯` menu offers **Move to column**, **Move to lane** and, with manual sort, **Move to top / bottom of column** as alternatives to dragging. On touch screens, a long press (250 ms) starts a drag, so normal swipes still scroll. **Select** on a board offers the same bulk actions as task lists.

---

## Spaces, members and roles

Everything you track lives in a **space**: its projects, milestones, epics, tasks, tags, statuses, boards, comments, work logs, history and settings. Every account gets a space of its own when it is created ("<your name>'s space"), and can create more on the **Spaces** page (the space switcher at the top of the sidebar, or the phone's **More** sheet, moves between them). Each space is a database of its own, so nothing ever crosses from one space to another, and a space can be renamed, shared, downloaded, imported, deleted (and restored for 7 days, `SPACE_DELETE_GRACE_DAYS`) on its own.

A space's members each have a role there:

| Role | Can |
|---|---|
| Viewer | read everything in the space, and leave it; the app shows a **View only** badge and no editing controls |
| Member | also create and edit projects and tags; create, edit and delete milestones, epics, tasks and boards; write comments and work logs, and edit and delete their own |
| Admin | also delete projects, manage statuses, merge and delete tags, change the space's settings, delete anyone's comments and work logs, move a former member's entries to a member, invite members and viewers, and remove them or change their role |
| Owner | also invite and manage admins and other owners, rename the space, download its archive, replace it with an import, transfer ownership and delete it; a space always has at least one owner |

- **Invitations.** Admins and owners invite people from the space's **Settings → Invitations** (or **Members → Invite people**) with an email address and a role. When the server sends mail, the invitation is emailed (and waits on the invited person's **Spaces** page too); otherwise you get a link to pass on yourself, which works for 7 days (`INVITATION_TTL_DAYS`). The invited person joins with a new account or one they already have. Members see each other's names and email addresses.
- **Who can create an account** (the sign-up policy, **Administration → Settings**, or `policy` on the command line): `invite_only` (the default) lets people create an account by accepting an invitation; `open` also lets anyone sign up with their email address, which a mailed link confirms first (so it needs mail); `closed` lets only instance administrators' invitations create accounts. Administrators can also invite people to an account of their own, without a space (**Administration → Invitations**).
- **Instance administrators** (the first account, and whoever an administrator makes one) manage the instance: its settings, accounts, invitations and spaces. Being one gives no access to any space's content: an administrator sees a space only as a member of it. What administrators can still do is in [Security notes](#security-notes).
- **Email addresses** are verified by a link when the server sends mail; an address is needed for invitations and for password resets by mail. Accounts from before spaces sign in with their username and can add an address in **Account settings → Profile**.
- **People who leave** keep their name on what they wrote ("(former member)"), and a deleted account's entries say "(deleted account)", without its address.
- **Archives.** An owner downloads the whole space as one file (**Settings → Data → Download space archive**), which anyone can import on any instance into a new space of their own (**Spaces → Import a space…**), mapping each person the archive names to an account they can see, by email address where it matches, or keeping them as a former member by name. See [Import](#import).

---

## Quick start

You need **Node.js 22.13 or newer**. The project uses Node 24: `.nvmrc` names the exact version that releases are built with. Node's built-in `node:sqlite` module is used, so nothing is compiled natively.

```sh
git clone <repository-url> lyren-plan   # or copy the source folder
cd lyren-plan
nvm install        # optional: installs and selects the Node version in .nvmrc
npm ci
npm run build      # builds dist/web (the web app) and dist/server.mjs (server and all dependencies)
npm start          # same as: node dist/server.mjs
```

npm 11 may warn during `npm ci` that it did not run esbuild's install script (`allow-scripts`). That is harmless: the build does not need it.

The first start prints something like this:

```
Lyren Plan 0.1.0 listening on http://0.0.0.0:8080
Database: /home/you/lyren-plan/data/lyren.db

  First run: open the app in your browser and create your account.
  Setup code: b92362507a29
```

Open <http://localhost:8080>, or `http://<server-ip>:8080` from another device. Then enter the setup code, your name, your email address (you sign in with it) and a password (at least 8 characters). **Create sample data** is ticked by default and adds two demo projects to your first space; untick it to start empty. This first account is the instance administrator. To let other people in, invite them (see [Spaces, members and roles](#spaces-members-and-roles)); for links that work on their devices, mail and passkeys, set `PUBLIC_URL` to the address they open (see [Configuration](#accounts-and-invitations)).

The setup code is only needed until the account exists. The setup page asks for it so that nobody else can claim a freshly exposed instance. A new random code is generated on every start until setup is done. Set `SETUP_TOKEN` to choose your own.

`dist/` is self-contained, so you can copy it to another machine that has Node ≥ 22.13 and run `node dist/server.mjs` there without `node_modules`. Copy the whole folder: without `dist/web` (or with `WEB_DIR` pointing elsewhere) the server logs `Web client not found: no index.html in …` and the browser shows a page saying the web client is missing. The database goes to `./data` under the **current working directory** unless you set `DATA_DIR`.

Every release also publishes exactly that as `lyren-plan-<version>-node.tar.gz`: `server.mjs` and `web/` in one folder `lyren-plan-<version>/`, without source maps (see [Releases](#releases)). A server then needs Node.js, but no npm, no `node_modules` and no build. `npm run package:node` makes an archive with the same files from a checkout.

On Node 22 (for example Ubuntu's `nodejs` package), every start and every command prints `ExperimentalWarning: SQLite is an experimental feature and might change at any time`. It is harmless; `node --disable-warning=ExperimentalWarning dist/server.mjs` hides it. Node 24 prints nothing.

### Running as a service (systemd)

**[docs/ubuntu-server.md](docs/ubuntu-server.md)** is a complete guide for Ubuntu Server 26.04 with Ubuntu's own Node.js (the `nodejs` package from apt): installing a release archive, a sandboxed systemd unit, HTTPS with nginx or Caddy (or LAN only) and the firewall, nightly backups with a systemd timer, restore, password reset, upgrades and roll-backs, and troubleshooting. In short:

- A system user `lyren`, without a home folder or login shell, runs the server.
- The release archive is extracted to `/opt/lyren-plan/lyren-plan-<version>/`, owned by root, and the symbolic link `/opt/lyren-plan/current` points to the version that runs.
- The unit runs `/usr/bin/node --disable-warning=ExperimentalWarning /opt/lyren-plan/current/server.mjs` as `lyren`, with `DATA_DIR=/var/lib/lyren-plan` (created by systemd with `StateDirectory=lyren-plan` and `StateDirectoryMode=0700`), `HOST=127.0.0.1` and `TRUST_PROXY=true` for a reverse proxy on the same machine, `Restart=on-failure` (except after a configuration error, exit code 2) and systemd's sandboxing (`ProtectSystem=strict` and more; not `MemoryDenyWriteExecute`, which kills Node).
- The setup code is in the journal: `journalctl -u lyren-plan`. The server shuts down cleanly on SIGTERM.
- Maintenance commands run as the service user with the service's data directory, for example `sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node /opt/lyren-plan/current/server.mjs backup <file>`; run as root on the service user's data, they stop with a hint. Pass variables with `env` like this: Ubuntu 26.04's sudo (sudo-rs) ignores `sudo -E`.

The unit works the same on other distributions with systemd and Node ≥ 22.13 at `/usr/bin/node`. The examples below use these paths.

The server (and every CLI command) creates its files owner-only: `DATA_DIR`, `spaces/` and `backups/` as 0700, the databases, their WAL and every snapshot as 0600, whatever umask it was started with. A data directory created by an earlier build may still be readable by other accounts; tighten it once with `chmod -R go-rwx /var/lib/lyren-plan`. Because the data is private to the service user, run the maintenance commands below (backup, restore, reset-password, ...) as that user, for example with `sudo -u lyren`. Run as root on another user's data folder, every command stops with `Run this as the owner of <folder>, for example: sudo -u <name> …` instead of leaving files behind that the service cannot open.

[Troubleshooting](docs/ubuntu-server.md#16-troubleshooting) in the Ubuntu guide lists what systemd and the app report when a service does not start.

### Start-up problems

Start-up problems are reported in a few plain lines instead of a stack trace:

| Message | Fix |
|---|---|
| `Invalid value for PORT: …` (exit code 2) | Correct the named environment variable (see [Configuration](#configuration)). |
| `Could not open the database …` with `must be writable by the user running the server` | Give the data directory to the service user, e.g. `sudo chown -R lyren: /var/lib/lyren-plan`, or for a Docker bind mount `sudo chown -R 1000:1000 ./data`. |
| `Could not open the database …` with `It does not exist yet, and this user cannot create it in …` | Create the data directory for the service user, e.g. `sudo install -d -o lyren -g lyren -m 700 /srv/lyren-plan`, or point `DATA_DIR` at a directory it owns. |
| `Could not open the database …` with `does not exist` or `is a file, not a folder` | Create or mount the directory above `DATA_DIR`, or point `DATA_DIR` (or `DB_PATH`) at a directory. |
| `Port 8080 is already in use …` | Stop the other process, or choose another port, e.g. `PORT=8081`. |
| `Web client not found: no index.html in …` (the server keeps running) | Run `npm run build`, copy the whole `dist/` folder, or point `WEB_DIR` at the built client. Reload the page; no restart is needed. |

---

## Windows app

Lyren Plan also comes as **one Windows program**, `lyren-plan-<version>-win-x64.exe` (about 91 MiB, nearly all of it the Node.js runtime). It contains Node.js, the server and the web app, so nothing else needs to be installed: no Node.js, no Docker, no internet connection. It runs on 64-bit Windows 10 and 11, and every feature works as in the Node version.

### Getting it

Download the `.exe` from the project's GitHub releases (see [Releases](#releases)) or wherever else it is published, or [build it yourself](#building-the-app). Put it anywhere, for example in `C:\Users\<you>\Apps`. There is no installer, and the program writes nothing next to itself.

If a `.sha256` file was published with it, compare it first: `Get-FileHash .\lyren-plan-0.1.0-win-x64.exe` in PowerShell.

The exe is not code-signed, unless whoever built it signed it (see [Signing the app](#signing-the-app)). Two different Windows protections may stop an unsigned exe:

- **Microsoft Defender SmartScreen** checks programs that were downloaded. For an unsigned or rarely downloaded one it shows **"Windows protected your PC"**, with the publisher "Unknown publisher". If you trust where the file came from, click **More info**, then **Run anyway**. Alternatively, before starting it, right-click the file, choose **Properties**, tick **Unblock** and click **OK**.
- **Smart App Control** (Windows 11) checks every program when it starts, downloaded or built on the PC. A program that Microsoft's cloud service doesn't recognise as safe runs only if it is signed with a certificate from a certificate authority that Microsoft trusts (its Trusted Root Program); otherwise it is blocked. There is no **Run anyway** and no exception for one app. In Command Prompt the block reads "... was blocked by your organization's Device Guard policy". Whether the service recognises an unsigned build of Lyren Plan is out of our hands: on our test PC it let some builds run and blocked others, including a copy that differed from an allowed build in one byte.
  - Smart App Control can be on without anyone turning it on. On a new Windows 11 installation it may start in an evaluation mode, in which it only watches, and later switch itself on (as on our test PC) or off. **Windows Security → App & browser control → Smart App Control settings** shows whether it is **On**, in **Evaluation** or **Off**.
  - If it blocks the app, a signed exe is the fix. We don't recommend turning Smart App Control off for this: it protects the PC against every unknown program, and depending on the Windows version, turning it back on may require resetting or reinstalling Windows.

### Starting and stopping

Double-click the exe. No window opens: Lyren Plan runs in the background and shows its icon in the **notification area**, at the right end of the taskbar near the clock. At the same time your default browser opens the app. On the first start that is the setup page with the setup code already filled in, so you only enter your name, your email address and a password. (The code travels in the part of the address after `#`, which is never sent to the server, and the page removes it from the address bar straight away.)

- **Finding the icon.** Windows 11 first puts new icons under the **^** arrow next to the clock. To keep Lyren Plan's icon on the taskbar, turn it on under **Settings → Personalization → Taskbar → Other system tray icons**. Windows names icons there after the program that shows them; Lyren Plan's is shown by Windows PowerShell (see [How the icon works](#how-the-icon-works)), so the entry may be listed as **Windows PowerShell** rather than Lyren Plan. Pointing at the icon shows "Lyren Plan - " and the address. On Windows 10, click the **^** arrow and drag the icon onto the taskbar.
- **The icon's menu** (right-click): **Open Lyren Plan** (also a left click; until your account exists it opens the setup page with the code again), **Open data folder**, with `--lan` **Copy address for other devices**, and **Quit Lyren Plan**. Web pages of the app show a one-time note about the icon.
- **To stop Lyren Plan**, choose **Quit Lyren Plan** in that menu, or run `lyren-plan-0.1.0-win-x64.exe stop` (see [Command line](#command-line)). Either way the database is closed cleanly, and so it is when you sign out of Windows or shut down. Closing the browser does not stop Lyren Plan.
- **Starting it again while it runs** opens the browser at the running copy (at the setup page until your account exists). Two copies never use the same database.
- To **bookmark** it or **install it as an app** (in Edge: **⋯ → Apps → Install this site as an app**), use the address the browser opened. If you open the bookmark or the installed app while Lyren Plan is not running, the page says **"Can't reach Lyren Plan"**: start the exe, then click **Try again**.
- **If something goes wrong**, for example a data folder you cannot write to, a port that is taken or an unexpected error, a message box says what happened, with the same text the console window showed in earlier versions. So do warnings, such as a data folder that other Windows accounts can read, and an address the browser could not be opened at. If a running Lyren Plan takes longer than two seconds to answer a second start, a message box says that it is waiting (and that the browser opens once it answers, unless `--no-browser` or `OPEN_BROWSER` turned the browser off for that start; the box names which).
- **The log file.** Everything Lyren Plan reports (the address, warnings, errors, and with `LOG_REQUESTS=true` every request) goes to `logs\lyren-plan.log` in the data folder, each line with its time. With `--db-path` the `logs` folder is next to the database file, and a database file with another name than `lyren.db` gets a log named after it, such as `logs\work.db.log` (see [Data folder](#data-folder)). The setup code is left out (it reads `[not in the log]`), so you can attach the log to a bug report; starting Lyren Plan again opens the setup page with the code filled in. When the file reaches 1 MiB it becomes `lyren-plan.1.log`, replacing the previous one, and a new file starts.
- **Commands from a shortcut.** `backup`, `restore`, `reset-password`, `promote-admin`, `policy`, `spaces`, `stop` and `help` started without a window (from a shortcut, with Win+R, from another file manager or launcher, or with PowerShell's `Start-Process`) show what they print when they finish: in a message box (Ctrl+C copies its text, for example a new password), or, for the long `help`, in a console window that stays open until you press Enter. The command itself does not wait for you: it ends with its exit code as soon as the box (or the window) is up, and the box stays until you click **OK**. Only where nobody can be at the screen do they show nothing: started by Task Scheduler, a Windows service or WMI, or in session 0 (a task that runs "whether user is logged on or not"); see [Scheduled tasks](#command-line).
- **Start it with Windows:** press Win+R, enter `shell:startup`, and create a shortcut to the exe in the folder that opens. In the shortcut's properties, add ` --no-browser` at the end of **Target**.

**In Command Prompt or PowerShell.** Started there, for example `lyren-plan-0.1.0-win-x64.exe --port 8090`, Lyren Plan runs in that window as it always has: it prints the address and the setup code there, Ctrl+C (or closing the window) stops it, and if something prevents the start, the message stays until you press Enter. It shows the icon too, so **Quit Lyren Plan** works as well. The commands (`backup`, `restore`, `reset-password`, `promote-admin`, `policy`, `spaces`, `stop` and `help`) print in the window, and the prompt waits for them.

**The console window of earlier versions (`--console`).** Started with `--console`, for example from a shortcut whose **Target** ends in ` --console`, Lyren Plan runs in a console window of its own, without the icon: the window shows the address and the setup code, and closing it or pressing Ctrl+C stops Lyren Plan. Lyren Plan switches to such a window by itself, with the same setup code and without opening the browser twice, when it cannot show the icon: when Windows PowerShell is missing or does not start, or when an application-control policy (App Control for Business, AppLocker) only lets it run in ConstrainedLanguage mode. The log file says why. If no console window can be opened either, Lyren Plan stops and a message box (or, without PowerShell, the log file) says so. A message that cannot be shown in a message box appears in such a window, too.

#### How the icon works

A program needs a window of its own to show an icon in the notification area, and Lyren Plan is a console program: that is what makes Command Prompt wait for its commands. So it starts **Windows PowerShell 5.1**, which is part of every Windows 10 and 11 and signed by Microsoft, hidden, and lets it show the icon with a short, readable script that is built into the exe and handed to PowerShell on its input. Nothing is written to disk, no execution policy is changed and no code of its own needs to be trusted by Smart App Control. The script also avoids the words for which PowerShell records a script as suspicious in its event log (a warning that security software watches for). That PowerShell process is the `powershell.exe` you see under Lyren Plan in Task Manager (about 100 MB of memory) and the reason why Windows may list the icon as Windows PowerShell. It ends together with Lyren Plan: if you end Lyren Plan in Task Manager, the icon disappears within a second or two. If PowerShell stops on its own, Lyren Plan starts it again, up to three times. Message boxes are shown the same way. Those of the running app go away with it; the box with the result of a command (see [Commands from a shortcut](#starting-and-stopping)) stays after the command has ended, until you click **OK**, and its PowerShell then ends.

**Older Windows.** Windows 11 version 24H2 and later start the exe without a console window. Windows 10 and Windows 11 up to 23H2 ignore that setting and open a console window for a double-click; Lyren Plan then starts itself again without one at once, so the window only flashes briefly. (This was tested on Windows 11 25H2 only.)

### Data folder

In `%LOCALAPPDATA%\Lyren Plan`, that is `C:\Users\<you>\AppData\Local\Lyren Plan`, which only your Windows account can read. (Local rather than Roaming AppData, because a SQLite database must not be copied around by roaming profiles.) The folder holds the same files as `DATA_DIR` of the Node version, see [Where the data lives](#where-the-data-lives), plus `desktop.json`, which remembers the port and identifies the running copy, and the `logs` folder with the log file. Deleting, moving or replacing the exe leaves the folder alone.

To keep the data somewhere else, for example on another drive, start the app with `--data-dir D:\Lyren` (add it to a shortcut's **Target**) or set `DATA_DIR`. `--db-path` (or `DB_PATH`) moves only the accounts' database file; its `spaces` folder (`<name>.spaces` for a file not named `lyren.db`), `backups`, `desktop.json` and the `logs` folder are then next to it. A database file with another name than `lyren.db` gets files named after it, for example `work.db.desktop.json` and `logs\work.db.log` for `work.db`, so two databases in one folder can run at the same time. Don't point a Node or Docker Lyren Plan at the same folder while the app runs.

- **A folder the app creates** is made private: only your Windows account (and SYSTEM and the administrators, as for `%LOCALAPPDATA%`) can open it, also when its path is longer than 259 characters. This matters outside your user profile: on its own, a new folder takes over the permissions of the folder above it, and the root of a drive such as `D:\` lets every account on the PC read what is created below it.
- **An existing folder** keeps its permissions. If other Windows accounts can open it, Lyren Plan warns about it (in a message box, and in the log file) with an `icacls` command that makes it private; run it once in Command Prompt (in PowerShell if the warning says so, for a path with a `%`).
- A drive formatted as FAT32 or exFAT (many USB sticks) has no permissions at all, so anyone who can use the PC can read the data on it. When the app cannot make a new folder private, it says so.

The data folder holds `lyren.db` (the accounts and the list of spaces), `spaces\` (one database per space) and `backups\` (automatic snapshots). Backups work as in the Node version: **Administration → Overview → Download backup**, or the `backup` command below; both write a backup set, one `.tar` file with the accounts and every space. To restore one, run the `restore` command below (`lyren-plan-0.1.0-win-x64.exe restore "<file>"`), then quit Lyren Plan (**Quit Lyren Plan** in the icon's menu, or the `stop` command) and start it again: the start moves the current data to `backups\before-restore-<time>\` and puts the backup in its place. The command also takes one space's snapshot from `backups\spaces\<id>\`, which undoes an import of that space.

**Administration → Overview → Data folder and commands** shows the data folder and these commands with your program's name (and with `--data-dir` or `--db-path` when you started the app with one; for PowerShell when a path contains a `%`, see [Command line](#command-line)), how to stop Lyren Plan the way it runs, plus a Windows Task Scheduler entry for a daily backup. The sign-in page shows the `reset-password` command.

### Address and port

The app listens on `127.0.0.1`, so only this computer can connect and Windows does not ask about the firewall. The port is **43770**. The port is part of the address that the browser ties its stored settings, bookmarks and an installed app to, so the app keeps its address once it has one:

- On the **first start**, if another program already uses port 43770, the app takes the next free port up to 43779, says so (in a message box and the log file) and remembers it. (A program listening on all of the PC's addresses counts too, although Windows would let Lyren Plan share its port.)
- On a **later start**, if another program has taken the remembered port, the app runs on the next free port for this time only. A message box warns that bookmarks and the installed app for the usual address now reach that other program, so don't sign in there. The next start with the port free again is back at the usual address.
- To choose a port yourself, start the app with `--port 8090`. A port chosen this way is used as is or not at all.

`127.0.0.1` is shared by every account on the PC, and browsers send the sign-in cookie to any port on it. On a PC that other people also use, start Lyren Plan before you open its bookmark or installed app, and sign in only at the address its icon shows when you point at it.

### Phones and other computers

Start the app with `--lan`, for example from a shortcut whose **Target** ends in ` --lan`. It then accepts connections from your network: **Copy address for other devices** in the icon's menu copies the address for them, such as `http://192.168.1.20:43770/` (the log file lists it too). The first time, Windows asks whether to allow Lyren Plan through the firewall: allow it on **private networks** only. Then open that address on your phone while it is on the same Wi-Fi.

- Everybody on that network can reach the sign-in page, and the connection is plain HTTP. Use `--lan` only on a network you trust; for anything else see [Reverse proxy and HTTPS](#reverse-proxy-and-https).
- Browsers only offer to install the app, and only keep its offline mode, over HTTPS or on the computer itself. On a phone it works as a normal website.
- The address contains the computer's IP address, which your router may change from time to time.
- To change the firewall answer later: **Windows Security → Firewall & network protection → Allow an app through firewall**.

### Updating

Download a backup first (**Administration → Overview → Download backup**). Quit Lyren Plan and replace the exe with the new one, or keep both and start the new one. The data stays where it is. On its first start the new version migrates the data, after writing a `before-upgrade` snapshot to `backups\`, exactly like the Node version; the first version with spaces turns the single `lyren.db` of 1.x into the accounts (`lyren.db`) and your space (`spaces\<id>.db`), see [Upgrading](#upgrading). An older exe refuses to open data that a newer one has migrated. After a `--lan` start, Windows asks about the firewall again for the new file.

### Uninstalling

Quit Lyren Plan and delete the exe. To remove your data as well, delete the folder `%LOCALAPPDATA%\Lyren Plan` (download a backup first if you might want it again). An installed browser app is removed from the browser's app list, and a firewall permission under **Allow an app through firewall**.

### Command line

The exe has the same commands as `node dist/server.mjs`. Run them in Command Prompt or PowerShell in the exe's folder (PowerShell needs `.\` in front of the name). The examples use the file name of version 0.1.0; type the name of yours (the Tab key completes it), or rename the file first. A name with spaces, such as `Lyren Plan.exe`, needs quotes: `"Lyren Plan.exe" help` (in PowerShell `& ".\Lyren Plan.exe" help`). `help` prints the commands with the program's actual name.

```bat
lyren-plan-0.1.0-win-x64.exe help
lyren-plan-0.1.0-win-x64.exe backup "%USERPROFILE%\Documents\lyren-2026-10-14.tar"
lyren-plan-0.1.0-win-x64.exe restore "%USERPROFILE%\Documents\lyren-2026-10-14.tar"
lyren-plan-0.1.0-win-x64.exe reset-password you@example.com
lyren-plan-0.1.0-win-x64.exe spaces
lyren-plan-0.1.0-win-x64.exe stop
```

- `backup <file>` writes a backup set (`.tar`). It is safe while the app runs and uses the app's data folder (or `--data-dir`, or `--db-path`). It refuses to overwrite a file.
- `restore <file>` takes a backup set, one space's snapshot (`backups\spaces\<id>\pre-import-<time>.db`, to undo an import) or a backup of an earlier version (`.db`) and prepares the restore; quit Lyren Plan and start it again to complete it. Until then nothing changes, and the other commands refuse to run; delete the `.restore-pending` folder in the data folder to cancel it (next to the database with `--db-path`, as `.<name>.restore-pending` for a database not named `lyren.db`).
- `promote-admin <email-or-username>` makes an account an instance admin, `policy [open|invite_only|closed]` shows or sets who can create accounts, and `spaces` lists the spaces with their owners and sizes.
- `stop` asks the Lyren Plan that runs with that data folder (or `--data-dir`, or `--db-path`) to quit, as **Quit Lyren Plan** would, and waits until it has closed the database. It ends with exit code 0 when Lyren Plan has stopped, and with 1 and an explanation when none runs there or it could not be stopped. It proves that it may do so with the secret in `desktop.json`, which only your Windows account can read, so other accounts and other programs can't stop your Lyren Plan this way. A copy of an older version, from before the `stop` command, says so; close its window instead. The `stop` command that Lyren Plan itself suggests (in the log file, and when you start it a second time) includes the `--data-dir` or `--db-path` it was started with. It also works from a shortcut (a message box then says whether it stopped), and in the Linux version.
- The commands open `lyren.db` in the default data folder. If you start the app with `--data-dir` or `--db-path`, or with `DATA_DIR` or `DB_PATH` set, give the commands the same option, for example `lyren-plan-0.1.0-win-x64.exe reset-password you@example.com --data-dir D:\Lyren`: a Command Prompt opened later doesn't know the variables the app was started with. Administration → Overview shows the commands with the option your app needs.
- `reset-password <email-or-username>` takes the account's email address (or the username of an account from before email addresses). Without anything piped in it prints a new random password; you can change it afterwards under **Account settings → Security**. To choose the password, pipe it in:
  - Command Prompt: `echo my new password| lyren-plan-0.1.0-win-x64.exe reset-password you@example.com`. Don't put a space before `|`, or it becomes part of the password, and put `^` before `& | < > ^`. For letters outside ASCII (ä, é, ß), run `chcp 65001` first: otherwise Command Prompt passes them in its old code page, and the command refuses the password ("not UTF-8 text") and changes nothing.
  - PowerShell 7: `'my new password' | .\lyren-plan-0.1.0-win-x64.exe reset-password you@example.com`. Windows PowerShell 5.1 turns letters outside ASCII into `?`, which can't be detected, so the command only warns when the new password contains a `?`.
  - The line break at the end, CRLF on Windows, is removed.
- `reset-password` also clears any lock-out from too many failed sign-ins.
- **A `%` in a path.** Command Prompt replaces `%NAME%` with the value of that environment variable if one exists, even inside quotes, where it can't be escaped: a data folder `D:\R&D 100%PATH%` would reach the program with your `PATH` in it. If the data folder, the database or the program's name contains a `%`, run the commands in PowerShell, with the path in single quotes: `& '.\lyren-plan-0.1.0-win-x64.exe' stop --data-dir 'D:\R&D 100%PATH%'`. In single quotes, type each `'` twice, and each typographic quotation mark `‘ ’ ‚ ‛` too (as in `Dana’s`): Windows PowerShell ends the string at any of them. A path that ends in a backslash and has a space in it, such as the root of a network share `\\nas\Lyren 100%\`, needs that backslash twice (`'\\nas\Lyren 100%\\'`): Windows PowerShell 5.1 would otherwise hand the program a stray `"` instead. Lyren Plan writes its own commands that way (the `stop` command in the log file and for a second start, Administration → Overview, the sign-in page), so the easiest is to copy the command from there.
- **Scheduled tasks.** For a daily backup, create a task in Windows Task Scheduler with `powershell.exe` as the program and the arguments that **Administration → Overview → Data folder and commands** shows, for example `-NoProfile -Command "& 'C:\Users\you\Apps\lyren-plan-0.1.0-win-x64.exe' backup ($env:USERPROFILE + '\Documents\Lyren Plan backups\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.tar')"`: each run writes a new file named after the day (the `backup` command never overwrites a file, and Task Scheduler can't put the date into the exe's arguments itself). The task's **Last Run Result** is 0 when the backup succeeded and 1 when it failed. If the exe itself is the task's program (then Task Scheduler starts it), or the task runs "whether user is logged on or not" (then it runs in session 0, without a desktop), a command shows no message box: what it prints goes to the log file next to the database (`logs\lyren-plan.log`, or `logs\<name>.log` for a database file named otherwise, such as `logs\work.db.log`; only if that folder exists), and it ends with its exit code at once. `reset-password` started that way refuses to make up a random password nobody would see; pipe the new password to it instead. A command that another program starts without a window (a launcher, a script's `Start-Process`) shows its message box as from a shortcut and ends with its exit code at once; the box stays until someone clicks **OK**. One exception: PowerShell's `Start-Process -Wait` waits for every process the command started, so it returns only once the box is closed. In a script, run the exe with `& '<path to the exe>' …` instead (what it prints appears in the script's console, the exit code is in `$LASTEXITCODE`), or use `Start-Process -PassThru` and then `.WaitForExit()` on the result.

Options, also for a shortcut's **Target**:

| Option | Same as | Effect |
|---|---|---|
| `--console` | | Run in a console window, without the icon (see [Starting and stopping](#starting-and-stopping)). |
| `--no-browser` | `OPEN_BROWSER=false` | Don't open the browser. |
| `--lan` | `HOST=0.0.0.0` | Accept connections from other devices, see above. |
| `--port <n>` | `PORT=<n>` | Use exactly this port. |
| `--data-dir <folder>` | `DATA_DIR=<folder>` | Use another data folder. |
| `--db-path <file>` | `DB_PATH=<file>` | Use this database file instead of `lyren.db` in the data folder. |

The other variables of the [Configuration](#configuration) table work too, for example `set SNAPSHOT_KEEP=20` in Command Prompt before starting the exe there. Only the defaults differ: the app uses `127.0.0.1`, port 43770, `%LOCALAPPDATA%\Lyren Plan` and its built-in web client, and an empty `HOST`, `PORT`, `DATA_DIR` or `DB_PATH` counts as not set.

### Building the app

```sh
npm ci
npm run package:win      # dist/lyren-plan-<version>-win-x64.exe and a .sha256 file next to it
```

The script runs `npm run build`, bundles the server into one CommonJS file for Node's [single executable applications](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html), embeds `dist/web` (without source maps), and injects all of it into the official `node.exe` of **the Node.js version that runs the script**. Use the Node.js version in `.nvmrc` (24.19.0, whose files are pinned, see below). It removes node.exe's Authenticode signature (the injection would invalidate it anyway), sets the Lyren Plan icon and version information, signs the exe if you [set that up](#signing-the-app), and prints the output path, size and SHA-256. The build stops if the exe would contain the path of your checkout or home folder (stack traces show only `lyren-plan.cjs`). It takes about 15 seconds. It is not part of `npm run check`.

It has been run on Linux (WSL) and natively on Windows 11 (Command Prompt, Node 24.19.0); it has not been tried on macOS. At the end it runs `<exe> help` as a self-test when the exe can run on the build machine, and then writes the `.sha256` file.

**Building on a PC with Smart App Control.** [Smart App Control](#getting-it) also checks the programs a build on Windows starts. npm installs unsigned native programs for the build and the tests (esbuild, Rollup, Tailwind CSS's oxide, Lightning CSS). On our test PC, with Smart App Control on, all of them ran, but it may block one of them on another PC or on another day, and then the build or the tests fail. Building in WSL, on Linux or on macOS avoids that; the resulting exe works the same, and Smart App Control only judges it when it is started on Windows. If Windows does not let the new exe start for the self-test, the script asks Windows for the reason. When it is Smart App Control or another policy, the script explains that, keeps the exe, writes its `.sha256` and succeeds: the build itself is complete. With `npm run package:win -- --require-self-test` that case exits with code 3 instead. Any other reason, such as a damaged exe ("not a valid application"), fails the build without a `.sha256` file.

How the Node.js binary is checked:

- For the pinned Node.js versions (24.19.0), `scripts/lib/node-hashes.mjs` holds the SHA-256 of each release file, copied from the release's `SHASUMS256.txt` after checking its signature against the Node.js release keys. The download is checked against these values only.
- For any other version, the expected SHA-256 comes from `SHASUMS256.txt` downloaded from `https://nodejs.org/dist` (never from a mirror), or from a file you give with `LYREN_NODE_SHASUMS=/path/to/SHASUMS256.txt`.
- The binary is downloaded once and kept in `.cache/node/` (ignored by git). Every build, offline ones included, checks the cached copy again and downloads it anew if it doesn't match.
- `LYREN_NODE_MIRROR=https://example.org/node/dist` downloads from a mirror of nodejs.org/dist. The mirror only transports the file: it must use `https://` (plain `http://` only with `LYREN_NODE_ALLOW_HTTP=1`), and the file is checked as above. For a version that isn't pinned, nodejs.org (or `LYREN_NODE_SHASUMS`) must still provide the checksums.
- Building without network access: `LYREN_NODE_BINARY=/path/to/node.exe npm run package:win` uses that file. It is checked like a download when its SHA-256 is known (a pinned version, `LYREN_NODE_SHASUMS`, or checksums cached by an earlier build); otherwise the script warns that it could not check it.
- `LYREN_NODE_PINNED_ONLY=1` (set by the [release workflow](#releases)) allows only the pinned versions: with any other Node.js the script stops before it builds anything, and it refuses a `LYREN_NODE_BINARY` it can't check against a pinned value (a Linux binary, whose pinned SHA-256 is that of its `.tar.gz`).
- `node scripts/package.mjs --target win-x64 --no-build` packages the existing `dist/`. `--target win-arm64` builds for Windows on ARM.
- `npm run package:linux` builds the same app for Linux x64 as `dist/lyren-plan-<version>-linux-x64` (about 123 MiB). It keeps its data in `~/.local/share/lyren-plan` (or `$XDG_DATA_HOME/lyren-plan`) and opens the browser with `xdg-open` when there is a display. It runs the code of the Windows app, which makes it handy for testing on Linux, with two differences: it runs in its terminal (Ctrl+C or `stop` stops it) and has no icon in a notification area; and on a first start it opens the setup page without the setup code filled in, because on Linux every local user can read the command line of `xdg-open` and of the browser it starts. Copy the code from the terminal.

### Signing the app

A signature from a code-signing certificate that Windows trusts is the dependable way to make the exe start on PCs where Smart App Control blocks it. SmartScreen then shows your name as the publisher instead of "Unknown publisher", although it may still warn about a new program until the program or the certificate has built up a reputation. A self-signed certificate does not help: Windows does not trust it. The options:

- **Microsoft Artifact Signing** (formerly Trusted Signing): an Azure service with a monthly fee. Microsoft verifies your identity, keeps the certificate for you and signs through `signtool` on Windows (with its Artifact Signing client tools) or in GitHub Actions and Azure Pipelines. At the time of writing, its publicly trusted certificates are offered only to organisations in a list of countries and to individual developers in the USA and Canada; check the current conditions.
- **An OV or EV code-signing certificate** from a certificate authority, paid per year, issued after the CA has verified you or your company, which can take days. Since June 2023 the private key of such a certificate must be kept in hardware, on a USB token or in a (cloud) HSM, not in a `.pfx` file, so you sign through the token's driver or the CA's signing service.
- Open-source projects may qualify for free signing programs (SignPath Foundation's, for example), which set conditions for the project and its builds.

To sign a build, set `LYREN_SIGN_CMD` to the command that signs one file, with `{file}` where the exe goes, and build as usual. The script runs it as the last change to the exe (after the icon, the version information and the PE checksum) and checks that it only added a signature: the certificate table is there and everything before it, the app included, is unchanged. Then it runs the self-test on the signed exe and writes the `.sha256` file, which therefore matches the signed file. If signing fails, so does the build: the unsigned exe is put back in `dist/` (also when the signing tool changed it before failing) and no `.sha256` file is written. Linux targets ignore the variable.

The command runs without a shell. It is split at spaces; `"..."` or `'...'` keep a path with spaces together, and backslashes stay as they are. Variables, `&&`, pipes and redirections are not interpreted: put such things in a script and run the script. On Windows, write a PowerShell script and run it as `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Tools\sign.ps1 {file}`; the script gets the exe's path as its first argument, unchanged. (A `.cmd` file run as `cmd.exe /d /c sign.cmd {file}` works only while the path of your checkout has none of `& | < > ^ % , ; =`, because cmd.exe reads the path again; the script refuses that form otherwise.) You can also give the words as a JSON array, for example `["C:\\Tools\\sign.exe", "--in", "{file}"]` (JSON doubles each backslash). A tool that writes the signed copy to a separate file gets `{out}` for it; the script then moves that file over the exe. The script's own messages name only the program, never the rest of the value, which may hold a password.

Examples, in Command Prompt on Windows (adjust the paths and names):

```bat
:: Artifact Signing. metadata.json names your Artifact Signing account and certificate profile.
set LYREN_SIGN_CMD="C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib "C:\Tools\ArtifactSigning\bin\x64\Azure.CodeSigning.Dlib.dll" /dmdf "C:\Tools\ArtifactSigning\metadata.json" {file}
npm run package:win

:: An OV/EV certificate on a token whose driver makes it available to Windows; /n picks it by its name.
:: (signtool by name: run this in a Developer Command Prompt, or give its full path as above.)
set LYREN_SIGN_CMD=signtool sign /fd SHA256 /tr http://timestamp.your-ca.example /td SHA256 /n "Your Name or Company" {file}
npm run package:win
```

When building in WSL, on Linux or on macOS, [osslsigncode](https://github.com/mtrojnar/osslsigncode) signs Windows programs. It writes the signed copy to a new file, hence `{out}`. Shown with a key in a file; for a certificate on a token, use osslsigncode's PKCS#11 options instead of `-pkcs12` and `-readpass` (see its documentation):

```sh
LYREN_SIGN_CMD='osslsigncode sign -pkcs12 /secure/sign.pfx -readpass /secure/sign.pass -n "Lyren Plan" -h sha256 -ts http://timestamp.your-ca.example -in {file} -out {out}' npm run package:win
```

---

## Docker

> Note: the authors have not run the Docker files in this repository; Docker was not available in the environment where the app was built and tested. The files follow the same build as `npm run build` and are described here as written. Please report any problems.

The `Dockerfile` has two stages. The first builds on `node:24-alpine`. The runtime image contains only Node and `dist/`, runs as the non-root `node` user (uid 1000), stores data in the volume `/data`, listens on port 8080 and has a health check on `/api/health`.

**docker compose** (uses `docker-compose.yml`):

```sh
docker compose up -d --build
docker compose logs lyren          # shows the one-time setup code
```

Then open <http://localhost:8080>. Data goes to the named volume `lyren-data`, and the container is called `lyren-plan`.

**Plain docker:**

```sh
docker build -t lyren-plan .
docker run -d --name lyren-plan --restart unless-stopped \
  -p 8080:8080 -v lyren-data:/data lyren-plan
docker logs lyren-plan             # setup code
```

**Bind mount instead of a named volume.** The container runs as uid 1000, so the host directory must be writable by it:

```sh
mkdir data && sudo chown 1000:1000 data
# docker-compose.yml:  volumes: - ./data:/data
```

**Behind a reverse proxy.** In `docker-compose.yml`, publish the port on localhost only and trust the proxy:

```yaml
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      TRUST_PROXY: "true"
```

Set other variables from the [Configuration](#configuration) table the same way, under `environment:`. `docker-compose.yml` has commented examples for `PUBLIC_URL` and mail. Keep secrets such as `SMTP_PASS` out of the compose file: put them in a file of their own that is not committed (`env_file: lyren-secrets.env`, with lines like `SMTP_PASS=...`, readable only by you; `.gitignore` and `.dockerignore` leave out `*.env` files, so neither `git add` nor the image's build picks it up).

The maintenance commands run inside the container, as the user it runs as, for example `docker exec lyren-plan node dist/server.mjs spaces` (see [Data, backups and restore](#data-backups-and-restore) and [Forgotten password](#forgotten-password)).

---

## Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Cleptomania/lyren-plan)

Lyren Plan also runs on Cloudflare, within the Workers Free plan to start with, as long as the runbook's CPU checks pass (whether Free's 10 ms of CPU per request applies to Durable Objects is not settled, and larger spaces need more for some requests): a Worker serves the API, Durable Objects with SQLite hold the accounts and each space, and Workers Static Assets serve the web app. Nothing in this repository belongs to one deployment, so anyone can deploy their own copy, in one of three ways:

- **The button above**: Cloudflare copies this repository into your GitHub or GitLab account and builds and deploys it there. It asks for a setup code (`SETUP_TOKEN`); afterwards set `PUBLIC_URL` and the rest in the Worker's settings.
- **The GitHub workflow** `.github/workflows/deploy-cloudflare.yml`, run by hand in your fork, with your Cloudflare token as a secret of the fork's `cloudflare` environment (with required reviewers; never a repository secret) and your settings as repository variables, whose values the run's log shows. It checks and builds in one job with no secret, and deploys from a second one; a dry run first changes nothing.
- **From your computer**: `npx wrangler login`, then `npm run deploy:cf`.

**[docs/cloudflare.md](docs/cloudflare.md)** is the runbook: the steps of a first deployment for each way (the setup code, the password hash's cost, a custom domain and the rate-limiting rule a public instance needs, mail), the configuration reference with Cloudflare's defaults, what the Free plan holds and what it costs, upgrades and rollbacks, backups by space archive, moving to a server of your own, and what to check once deployed. In short, on Cloudflare:

- There is no command line and no backup download: owners download their spaces' archives, and the recovery token (`RECOVERY_TOKEN`) helps when no administrator can sign in ([Locked out](docs/cloudflare.md#locked-out)).
- The defaults fit the Free plan: passwords of at least 12 characters, sessions of at most 90 days, 5 spaces per account, 20 members per space, imports of up to 4 MiB.
- Mail goes through an SMTP provider (whether the Free plan allows the connection is only known once deployed), Resend, or Cloudflare's Email Service on Workers Paid.
- `npm run dev:cf` runs it all locally with Wrangler, and `npm run check:cf` bundles the Worker as a deploy would, offline.

---

## Configuration

All configuration is through environment variables. `node dist/server.mjs help` prints the same list. The [Windows app](#windows-app) reads the same variables but has its own defaults for `HOST`, `PORT`, `DATA_DIR` and `WEB_DIR`. On Cloudflare they are the Worker's variables and secrets, with defaults for the Free plan where noted: see [docs/cloudflare.md](docs/cloudflare.md#configuration). `SETUP_TOKEN`, `RECOVERY_TOKEN`, `SMTP_PASS` and `RESEND_API_KEY` are secrets: keep them out of files others can read (the [Ubuntu guide](docs/ubuntu-server.md#14-settings) uses a root-only `EnvironmentFile=`, Docker an `env_file`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on (1-65535). |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to accept local connections only, for example behind a reverse proxy on the same host. |
| `DATA_DIR` | `./data` (relative to the working directory); `/data` in Docker | Data directory, created if missing. It holds `lyren.db` (the accounts), `spaces/` (one database per space) and the `backups/` folder of automatic snapshots. |
| `DB_PATH` | `<DATA_DIR>/lyren.db` | Location of the accounts' database file. The spaces are in `spaces/` next to it (`<file name>.spaces/` for a file not named `lyren.db`), and snapshots, temporary backup files and a staged restore in that folder too. |
| `WEB_DIR` | `web/` next to `server.mjs` (i.e. `dist/web`) | Built web client to serve. An empty value serves the API only (`npm run dev` does this). If the folder has no `index.html`, the server logs a warning and pages show a "web client is missing" notice. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` (right-most entry) and `X-Forwarded-Proto` from a reverse proxy. Turn it on **only** when every request goes through your proxy. |
| `COOKIE_SECURE` | `auto` | `auto`: the session cookie gets the `Secure` flag when the request is HTTPS, either directly or through `X-Forwarded-Proto` with `TRUST_PROXY`. `true` or `false` forces it either way. |
| `SESSION_TTL_DAYS` | `30` | Session lifetime in days (max 400). It is sliding: each session is extended at most once an hour while you use it. |
| `SETUP_TOKEN` | random | First-run setup code. If unset, a random 12-character code is generated at each start and printed. Not used once the first account exists. |
| `BODY_LIMIT` | `2097152` (2 MiB) | Maximum request body size for API requests. |
| `IMPORT_BODY_LIMIT` | `52428800` (50 MiB) | Maximum size of an import's upload, and of the archive once unpacked (`POST /api/s/<space>/data/import/…`). |
| `IMPORT_MAX_JSON_VALUES` | `1000000` | Objects, arrays and list items an import may hold, counted before it is parsed: parsing memory grows with them, not with bytes, by up to about 90 bytes each. The default fits a server with 512 MB of memory and holds an archive of about 25,000 tasks; for larger archives raise it by about 1,000,000 for every 128 MB of heap the server can spare (Node gives its heap about a quarter of the memory, at most 4 GB; `NODE_OPTIONS=--max-old-space-size=<MB>` sets it). |
| `IMPORT_MAX_ROW_WRITES`, `IMPORT_DAILY_ROW_WRITES` | `0` (no limit) | Estimated database rows one import may write, and all imports of a UTC day together (for hosts that bill rows written). |
| `SPACES_OPEN_MAX` | `32` | Space databases kept open at once; the least recently used one is closed after its requests. |
| `ALLOW_ADMIN_BACKUP_DOWNLOAD` | `true` | Instance admins can download a backup set in **Administration → Overview**. `false` turns the download off, for servers whose operator backs up with the `backup` command. |
| `SNAPSHOT_KEEP` | `10` | Automatic snapshots of each kind kept per folder of `backups/` (`pre-import-*` and the `*-before-upgrade-*` kinds, counted separately). After writing a new one, the server deletes the older ones of that kind. `0` keeps all. Only files named exactly like those snapshots are ever deleted, so your own backups in `backups/` are never touched. |
| `LOG_REQUESTS` | `false` | Log every request to stdout: method, path with its query string (search words too), status and time; without colour codes unless stdout is a terminal. |
| `LYREN_DB_STRICT` | `false` (on in the tests) | Development: refuse SQL that a Cloudflare Durable Object would refuse or run differently. |
| `OPEN_BROWSER` | `true` | Windows app only: open the browser at the app on start (`--no-browser` sets it to false). Like every boolean below, any value other than `1`, `true`, `yes` or `on` means false. |

Boolean variables accept `1`, `true`, `yes` or `on`, in any case. Any other value means false. Numbers must be whole numbers within range: at least 1, except `SNAPSHOT_KEEP` and the limits below where `0` means no limit. An invalid value stops the server at startup with an error that names the variable.

### Accounts and invitations

| Variable | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | | The address people open, for example `https://plan.example.com`. Links in mail and copied invitation links use it, and passkeys need it: they work only when it is an `https` address (or `http://localhost`) with a host name, not an IP address. |
| `WEBAUTHN_RP_ID` | the host of `PUBLIC_URL` | The domain passkeys belong to: that host, or a parent domain of it such as `example.com` for `https://plan.example.com` (then passkeys keep working under any host of that domain). Passkeys registered for one domain do not work for another, so choose it before people add passkeys. |
| `INSTANCE_NAME` | `Lyren Plan` | The instance's name in the app and in mail. |
| `SIGNUP_POLICY` | `invite_only` | Who can create an account: `invite_only` (with an invitation), `closed` (only with an administrator's invitation) or `open` (anyone, after confirming the address; needs mail, or `MAIL_LOG_BODIES` for development). Read once, when the accounts' database is created; after that an admin changes it in **Administration → Settings** (or `policy` on the command line). |
| `PASSWORD_MIN_LENGTH` | `8` | Shortest new password (8-64). Also read once; then **Administration → Settings**. |
| `PASSWORD_KDF` | `scrypt` | How new passwords are hashed: `scrypt` or `pbkdf2` (100,000 iterations). Stored hashes keep working either way. |
| `PASSWORD_SCRYPT_P` | `5` | scrypt's parallelization (N = 16384, r = 8), 1-8: about 70 ms per hash at 5. A hash made with other parameters is made again at its next sign-in. |
| `SESSION_MAX_DAYS` | `0` | Days after which a session ends however much it is used; `0` means never (only `SESSION_TTL_DAYS` of inactivity ends it). |
| `REAUTH_MINUTES` | `10` | How long a password or passkey confirmation lasts for sensitive actions, such as changing the email address or administration. |
| `INVITATION_TTL_DAYS` | `7` | How long an invitation works. |
| `SPACE_DELETE_GRACE_DAYS` | `7` | How long a deleted space can be restored (from **Spaces**, by its owner, or by an admin); `0` removes it at once. |
| `MAX_SPACES_PER_USER` | `0` | Spaces one account may own, deleted ones included until they are removed. `0` means no limit. |
| `SPACES_CREATED_PER_DAY` | `0` | Spaces one account may create a day. `0` means no limit. |
| `INVITATIONS_PER_DAY` | `20` | Invitations one account can send a day. An account younger than a day can send 5 (or this many, if lower), unless it is an instance admin. `0` means no limit. |
| `MAX_OPEN_INVITATIONS_PER_SPACE` | `50` | Open invitations per space, and for the instance's own invitations. `0` means no limit. |
| `MAX_MEMBERS_PER_SPACE` | `0` | Members per space, open invitations included. `0` means no limit. |
| `SPACE_MAX_BYTES` | `0` | Size of a space's database above which it takes no new content (reading and deleting still work). `0` means no limit. |
| `RECOVERY_TOKEN` | | Break-glass recovery when no administrator can sign in: at least 32 characters. Leave it unset; see [Locked out](#locked-out). |

`SPACE_DAILY_ROW_WRITES` and `AUTH_CACHE_SECONDS` exist for Cloudflare only ([docs/cloudflare.md](docs/cloudflare.md#configuration)): a Node server does not count billed rows, and checks every request's session at once.

### Mail

Lyren Plan sends no mail until you configure it (`MAIL_TRANSPORT=log`, also in the Windows app): each message is then a line in the log that names the kind of message and the recipient's domain, nothing more. To send mail, set `MAIL_TRANSPORT`, `MAIL_FROM` and `PUBLIC_URL` (the address in the links), then use **Administration → Overview** to send yourself a test message.

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_TRANSPORT` | `log` | `log`, `smtp` or `resend` (on Cloudflare also `cloudflare`, Cloudflare Email Service on Workers Paid: [docs/cloudflare.md](docs/cloudflare.md#cloudflare-email-service)). |
| `MAIL_FROM` | | The sender address, for example `plan@example.com`. Required for every transport but `log`. |
| `MAIL_FROM_NAME` | `INSTANCE_NAME` | The sender name. |
| `MAIL_REPLY_TO` | | An address for replies. |
| `MAIL_DAILY_CAP` | `200` | Messages per day (UTC). Mail that anonymous visitors cause (sign-up, forgotten passwords, notices of failed sign-ins) can use at most 40% of them, so invitations and verifications always have room, and one address gets at most 5 a day apart from security notices. |
| `SMTP_HOST` | | Your mail provider's submission server, for example `smtp.example.com`. |
| `SMTP_SECURITY` | `tls` | `tls` (TLS from the start, port 465) or `starttls` (port 587; the server must offer STARTTLS). The server's certificate is always checked against `SMTP_HOST`. `none` sends without TLS and is only accepted for a mail server on this machine (`localhost`, `127.0.0.1`, `[::1]`), without a user name, such as a local Postfix relay or a test mail catcher. |
| `SMTP_PORT` | `465`, `587` with `starttls`, `25` with `none` | |
| `SMTP_USER`, `SMTP_PASS` | | The account at your mail provider; set both or neither. Sent only over TLS. |
| `SMTP_EHLO_NAME` | the host of `PUBLIC_URL` | The name the server introduces itself with. |
| `RESEND_API_KEY` | | With `MAIL_TRANSPORT=resend` (resend.com; its free plan sends 100 messages a day, so set `MAIL_DAILY_CAP=90`). |
| `MAIL_LOG_BODIES` | `false` | Development only: with `log`, print whole messages, sign-in links included, so that sign-up, forgotten passwords, verification and email changes work from the links in the log. Warned about unless `PUBLIC_URL` is on this machine. |

The password and the API key are never written to the log or shown in the app. A message that cannot be sent is logged and listed in the account's security events.

The mail server's certificate is always checked. One issued by a private certificate authority (a company relay, for example) is trusted with `NODE_EXTRA_CA_CERTS=<the authority's PEM file>` in the server's environment; this works for `dist/server.mjs`, Docker (mount the file into the container) and the Linux single binary.

---

## Reverse proxy and HTTPS

Lyren Plan speaks plain HTTP and does not handle TLS itself. To reach it from outside your LAN, put it behind a TLS-terminating reverse proxy, or use a VPN. With a proxy:

1. Bind the app to localhost (`HOST=127.0.0.1`, or `127.0.0.1:8080:8080` in Docker) so clients cannot bypass the proxy.
2. Set `TRUST_PROXY=true`. This has three effects:
   - Session cookies become `Secure` when the proxy sends `X-Forwarded-Proto: https`. If your proxy does not send that header, set `COOKIE_SECURE=true`.
   - The login rate limiter and the "signed-in devices" list see real client IPs instead of the proxy's address.
   - The app uses the **right-most** `X-Forwarded-For` entry. That is correct for exactly one proxy hop. With a chain (for example a CDN in front of nginx), the IP seen is that of the hop next to your proxy.
3. Serve it at the root of its own hostname (for example `https://plan.example.com/`). A sub-path such as `/lyren/` is not supported.
4. Set `PUBLIC_URL=https://plan.example.com`, the address people open. Links in mail and copied invitation and reset links use it, and **passkeys need it**: they work only when the page is opened at that https address. Choose the final host name before people add passkeys, since passkeys do not move to another one (or set `WEBAUTHN_RP_ID` to your domain, see [Accounts and invitations](#accounts-and-invitations)).

The app sets its own Content-Security-Policy and other security headers. It leaves HSTS to the proxy.

**Caddy** (gets certificates automatically and sets `X-Forwarded-For` and `X-Forwarded-Proto`):

```caddy
plan.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name plan.example.com;
    ssl_certificate     /etc/letsencrypt/live/plan.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/plan.example.com/privkey.pem;

    # nginx rejects bodies over 1 MB by default; imports can be up to 50 MB.
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

(Also add a port-80 server that redirects to HTTPS.)

Installing the PWA and the offline app shell (a service worker) only work over HTTPS or on `http://localhost`. Over plain HTTP on a LAN address the app works normally, but it cannot be installed and does not open offline.

---

## Data, backups and restore

### Where the data lives

Everything is stored in `DATA_DIR` (`./data` by default, `/data` in Docker):

| Path | What it is |
|---|---|
| `lyren.db` | The directory database: the accounts, their sign-in sessions, the spaces and who is a member of which. |
| `spaces/<id>.db` | One database per space: its projects, tasks, comments, work logs, activity, tags, statuses, boards and settings. |
| `lyren.db-wal`, `lyren.db-shm`, `spaces/<id>.db-wal`, … | SQLite write-ahead log files. They are part of the live databases, so never copy the `.db` files alone while the server runs. |
| `backups/spaces/<id>/pre-import-<timestamp>.db` | Snapshot of a space written automatically before every import into it. The newest `SNAPSHOT_KEEP` (default 10) are kept. |
| `backups/directory-v<N>-before-upgrade-<timestamp>.db`, `backups/spaces/<id>/space-v<N>-before-upgrade-<timestamp>.db` | Snapshots written automatically before a new version migrates a database. The newest `SNAPSHOT_KEEP` of each are kept. |
| `backups/lyren-v1-before-upgrade-<timestamp>.db` | The 1.x database as it was before the first start of the version with spaces upgraded it (see [Upgrading](#upgrading)). |
| `backups/before-restore-<timestamp>/` | What a restore replaced (see [Restore a backup](#restore-a-backup)). Never deleted automatically. |
| `.backup-<random>/`, `.backup-<random>.tar` | Temporary files of a backup. They are deleted when the backup is written (a download: as soon as it starts streaming); ones left behind by a crash are deleted at the next start. |
| `.restore-<random>.in`, `.restore-<random>.partial/` | Temporary files of `restore`: the copy of standard input of `restore -`, and the folder a restore is prepared in. Deleted when the command ends; ones left behind by a crash are deleted at the next start. |
| `.restore-pending/` | A restore that waits for the next start (`.<name>.restore-pending/` for a database file not named `lyren.db`). Delete it to cancel the restore, unless a start was interrupted while it applied it (see [Restore a backup](#restore-a-backup)). |
| `backups/orphaned-<timestamp>/` | Space files of an earlier upgrade from 1.x that was rolled back, moved aside by the next upgrade (see [Upgrading](#upgrading)). Never deleted automatically. |
| `desktop.json` | Desktop app only (Windows and Linux): the remembered port, the running copy's identity and, from a first start until the next one, the setup code. Next to the database; for a database with another name than `lyren.db`, `<name>.desktop.json`. |
| `logs/lyren-plan.log`, `logs/lyren-plan.1.log` | Windows app only, when it shows its icon in the notification area: what it reports, see [Starting and stopping](#starting-and-stopping). Next to the database; for a database with another name, `logs/<name>.log`. |

**Snapshot retention.** After writing an automatic snapshot, the server keeps the newest `SNAPSHOT_KEEP` (default 10) of that kind in that folder and deletes older ones; pre-import and pre-upgrade snapshots are counted separately, and the log says `[lyren] Deleted N old … snapshots`. Only files whose whole name matches those patterns are deleted, so files from the `backup` command, cron backups in `backups/`, `before-restore-*` folders and renamed copies are never touched. To keep a snapshot for good, copy it elsewhere or rename it. `SNAPSHOT_KEEP=0` keeps them all.

### Ways to back up

| Method | What you get | Notes |
|---|---|---|
| **Administration → Overview → Download backup** (instance admins) | `lyren-backup-YYYY-MM-DD.tar`, a backup set | Sign-in sessions and tokens are left out. `ALLOW_ADMIN_BACKUP_DOWNLOAD=false` turns the download off. |
| **`backup` command** | A backup set written to the path you give | Safe while the server is running. Sign-in sessions and tokens are left out. |
| **a space’s Settings → Data → Download space archive** (owners) | `lyren-space-<name>-YYYY-MM-DD.json.gz`, the space’s archive: every project, milestone, epic, task, comment, work log, activity entry, tag, status, board and setting of a space, and the names (and addresses) of the people its rows name | Gzip-compressed JSON. Does not include accounts, passwords or sessions. Use it to move a space between instances (an import maps its people to accounts there) or to keep a readable archive. |

On Cloudflare there are neither backup sets nor the `backup` command: owners download their spaces' archives ([docs/cloudflare.md](docs/cloudflare.md#backups-and-moving-to-a-server-of-your-own)).

A **backup set** is one uncompressed `.tar` file: `lyren-backup.json` (what it holds), `directory.db` (the accounts and spaces) and `spaces/<id>.db` for every space, each a consistent snapshot. `tar -tf <file>` lists it.

The `backup` command must use the **same `DATA_DIR`/`DB_PATH` as the server** (and the same working directory when they are relative, as the default `./data` is). Run it as the user that owns the data directory, into a folder that user can write. If no database exists at that location it stops with an error (it never creates an empty one). It refuses to overwrite an existing file, so use a unique name such as a date stamp. A name ending in `.db` still works (old cron jobs) and gets a note; the file is a backup set all the same. With the paths of the [Ubuntu guide](docs/ubuntu-server.md):

```sh
sudo install -d -o lyren -g lyren -m 700 /var/backups/lyren-plan   # once
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node /opt/lyren-plan/current/server.mjs backup /var/backups/lyren-plan/lyren-$(date +%F).tar
```

Nightly: the Ubuntu guide sets up a systemd timer that runs the `backup` command at 03:00 and deletes backups older than 30 days ([Backups](docs/ubuntu-server.md#9-backups)); `sudo systemctl start lyren-plan-backup` then also makes one by hand. With Docker, from the host's crontab (`%` must be escaped in crontab); it writes into the data volume, so copy the file elsewhere afterwards:

```cron
0 3 * * * docker exec lyren-plan node dist/server.mjs backup /data/backups/lyren-$(date +\%F).tar
```

To copy a backup out of the container: `docker cp lyren-plan:/data/backups/lyren-2026-10-13.tar .`. Keep copies on another machine. Backups contain the password hashes (scrypt), so store them privately.

### Restore a backup

The `restore` command takes a backup set (`.tar`), one space's database (`.db`, such as a pre-import snapshot) or a backup made by an earlier version (`.db`). It checks the file and prepares the restore in `DATA_DIR/.restore-pending/`; the server completes it when it starts the next time, after moving what it replaces to `backups/before-restore-<timestamp>/` (for a backup set: `lyren.db` and `spaces/`; for one space: that space's file). Nothing changes before that restart, and the other maintenance commands refuse to run meanwhile, the nightly backup included; delete `.restore-pending` to cancel. If a start is interrupted while it applies the restore (a power loss), the commands say `A restore was interrupted while it was being applied: start Lyren Plan to finish it. Do not delete …`: part of the current data has already moved out, so keep the folder and start the server, which finishes the restore.

1. Optional: back up the current state first with the `backup` command.
2. Run `restore` with the server's `DATA_DIR`, as the user that owns it. It works while the server runs.
3. Restart the server.
4. Sign in with the password that was valid when the backup was taken. Backup sets contain no sign-in sessions, so every device signs in again. A restored space keeps its members as they are now.

A backup from an older version is migrated on start (after a before-upgrade snapshot). A backup made by a newer version is refused by `restore` before anything changes. Node install, with the paths of the [Ubuntu guide](docs/ubuntu-server.md#10-restore-a-backup):

```sh
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node /opt/lyren-plan/current/server.mjs restore /var/backups/lyren-plan/lyren-2026-10-13.tar
sudo systemctl restart lyren-plan
# A file the service user cannot read (in your home folder, say; restore says "… cannot be read as
# this user"): through standard input, after sudo -v, so that the two sudo do not both ask for a password
sudo -v
sudo cat ~/lyren-backup-2026-10-13.tar | sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node /opt/lyren-plan/current/server.mjs restore -
```

Docker, with the file on the host read through standard input (or a path inside `/data`):

```sh
docker exec -i lyren-plan node dist/server.mjs restore - < lyren-backup-2026-10-13.tar
docker restart lyren-plan
```

**Without the command** (for example on a machine without Lyren Plan's new version): stop the server; move `lyren.db*` and `spaces/` out of the data directory; extract the set **as the user that runs the server** (a `tar -x` by root creates files the server cannot open); move `directory.db` to `lyren.db` and the `spaces` folder into place; start the server. The Ubuntu guide has the commands.

To **undo an import** over a space, restore that space's pre-import snapshot. The import's result names the file and the command to copy (`restore "backups/spaces/<id>/pre-import-<timestamp>.db"`); `restore` also finds that path relative to the data directory, so `restore backups/spaces/<id>/pre-import-<timestamp>.db` works from any folder. Only the newest `SNAPSHOT_KEEP` (default 10) pre-import snapshots of a space are kept, so copy one elsewhere if you may need it after many more imports. The command refuses the snapshot of a space that has been deleted for good.

### Import

An archive (the `.json.gz` file of **Download space archive**, or a `.json` export of Lyren Plan 1.x) can be imported
**into a new space** (**Spaces → Import a space…**; you own it; this is how a space moves to another instance) or
**over an existing space** (**Settings → Data → Replace this space**, its owners), which replaces **all** of that
space’s projects, milestones, epics, tasks, comments, work logs, activity, tags, statuses, boards and settings; its
members and your other spaces are kept. Replacing asks you to type `REPLACE` to confirm, and offers to download the
current data first (on Cloudflare, where no copy is kept on the server, Replace waits until you have). An import
into a new space that you leave unfinished waits on the Spaces page, to continue or discard.

- The file is fully validated first, including references between records. If anything is wrong, the import is rejected with a list of the problems and nothing changes.
- The people the archive names are mapped before anything is written: each to an account you can already see (yourself, and the members of your spaces; an instance admin, every account), suggested by matching email addresses, or kept as a “former member” by name only. Afterwards the import offers to invite the people it attributed entries to who are not members yet. Rows attributed to someone other than you are labelled “Imported by …”; that person can disown them (“Not yours?”, or **Members → These entries aren’t mine…**), and admins can reassign a former member’s rows to a member (**Members → Former members → Reassign…**). A file exported before archives had people attributes everything to you.
- An instance may limit how many database rows one import, or all imports of a day, may write (`IMPORT_MAX_ROW_WRITES`, `IMPORT_DAILY_ROW_WRITES`; on Cloudflare 50,000 and 60,000): the import says so before anything is sent, and offers to leave the activity history out when that makes it fit.
- Before replacing anything, the server writes `DATA_DIR/backups/spaces/<id>/pre-import-<timestamp>.db` (older pre-import snapshots of that space beyond `SNAPSHOT_KEEP` are then deleted); the import’s result names it with the `restore` command that undoes the import (see above).
- The data is replaced in one transaction, keeping the original ids.
- Your account, password and sign-in sessions are left unchanged.

---

## Upgrading

Back up first (see above). Then:

```sh
# Node install from a release archive (the layout of docs/ubuntu-server.md): extract the new
# version next to the old one, then switch while the server is stopped
sudo tar -xzf lyren-plan-1.1.0-node.tar.gz -C /opt/lyren-plan --no-same-owner
sudo systemctl stop lyren-plan
sudo ln -sfn lyren-plan-1.1.0 /opt/lyren-plan/current
sudo systemctl start lyren-plan

# The same layout with archives built on the server (docs/ubuntu-server.md, section 18): in the checkout,
# build the new version's archive, then run the four commands above with dist/lyren-plan-1.1.0-node.tar.gz
git fetch --tags
git checkout v1.1.0
npm ci --ignore-scripts
npm run package:node

# A checkout that you start yourself with npm start (Quick start): stop the server, then
git pull
npm ci
npm run build
npm start

# Docker compose
git pull
docker compose build --pull
docker compose up -d
```

Database migrations run automatically at startup. Before an existing database is migrated, a snapshot is written to `backups/` next to it (`directory-v<old>-before-upgrade-<timestamp>.db`, and `backups/spaces/<id>/space-v<old>-before-upgrade-<timestamp>.db` for a space; the newest `SNAPSHOT_KEEP` of each are kept). An older build refuses to start on data migrated by a newer one.

**From 1.x.** The first start of the version with spaces (the server or the desktop app, not a maintenance command) upgrades the single `lyren.db` of 1.x: your data becomes the space "<your display name>'s space" in `spaces/<id>.db`, with the same ids, task references and links, and `lyren.db` holds the accounts. The old file is saved as `backups/lyren-v1-before-upgrade-<timestamp>.db`, and the log says `Upgraded the database for multi-user spaces: …`. Signed-in browsers stay signed in, and your username keeps working at the sign-in form. Reload any Lyren Plan tab that was open during the upgrade: until then it runs the old app, whose pages say `Lyren Plan has been updated. Reload the page to continue.` If a 1.x server still has the file open, the upgrade stops with `Lyren Plan or another program still has … open` and changes nothing: stop the 1.x server and start the new version again (systemd and Docker's restart policy retry by themselves). A 1.x server started while the upgrade runs stops with `database disk image is malformed`; keep it stopped. Until that first start, `backup` writes a 1.x-style backup and the other maintenance commands refuse to run.

**Rolling back to 1.x.** 1.x refuses the upgraded data (`Database schema version 100 is newer than this build supports (1). Upgrade the app.`, followed by a stack trace, which is expected). Stop the server, install the old build, move `lyren.db*` and `spaces/` into a folder under `backups/`, copy `backups/lyren-v1-before-upgrade-<timestamp>.db` to `lyren.db` as the user that runs the server, and start it; 1.x has no `restore` command. Everything changed since the upgrade is lost. A later upgrade starts again from that file, and moves the earlier upgrade's space file, if you left it in `spaces/`, to `backups/orphaned-<timestamp>/`. The Ubuntu guide's [Upgrade and roll back](docs/ubuntu-server.md#12-upgrade-and-roll-back) has the download, its check and the roll-back step by step.

Browsers pick up the new web app on their next page load. For an installed PWA, close and reopen it.

The Windows app is updated by replacing the exe; see [Updating](#updating). On Cloudflare, deploy the new version as you deployed the first; see [Upgrades and rollbacks](docs/cloudflare.md#upgrades-and-rollbacks).

---

## Forgotten password

`reset-password` sets a new password, signs the account out on every device and clears any lock-out from failed sign-ins. It takes the account's email address, or the username of an account from before email addresses. It can run while the server is up. Use the same `DATA_DIR` as the server, and run it as the service user. With the paths of the [Ubuntu guide](docs/ubuntu-server.md#11-forgotten-password):

```sh
# Generate and print a random password:
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node /opt/lyren-plan/current/server.mjs reset-password you@example.com

# Or choose one. Piping it in on stdin keeps it out of your shell history; sudo -v first, so that
# sudo does not ask for your own password while the pipe runs:
sudo -v
IFS= read -rs PW && printf '%s\n' "$PW" | sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node /opt/lyren-plan/current/server.mjs reset-password you@example.com; unset PW
```

With Docker:

```sh
docker exec -it lyren-plan node dist/server.mjs reset-password you@example.com                 # random password
IFS= read -rs PW && printf '%s\n' "$PW" | docker exec -i lyren-plan node dist/server.mjs reset-password you@example.com; unset PW
```

- The password must be 8 to 256 characters (the instance's minimum, 8 unless changed), the same rule as the sign-in form. Anything else is refused and nothing changes.
- **Forgot the address?** Run the command with any name and it lists up to 20 accounts: `No account with the email address or username "x". Accounts: you@example.com, …`.
- **No admin can sign in?** `promote-admin <email-or-username>` makes an account an instance admin.
- **Windows app:** run `lyren-plan-0.1.0-win-x64.exe reset-password you@example.com` (the name of your copy) in the exe's folder, with `--data-dir` or `--db-path` if you start the app with one; see [Command line](#command-line). The sign-in page and **Administration → Overview** show the command. Run without a window (from a shortcut or with Win+R), it shows the new password in a message box, whose text Ctrl+C copies.

### Locked out

When no administrator can sign in and the commands above are out of reach, the recovery token gets a password reset link through the web app:

1. Set `RECOVERY_TOKEN` to a random value of at least 32 characters (for example from `openssl rand -base64 33`) in the server's environment, and restart the server. It is a secret: with systemd, put it in a root-only environment file as the [Ubuntu guide](docs/ubuntu-server.md#14-settings) shows.
2. Open `/recover` on the instance (for example `https://plan.example.com/recover`) and enter the token and the account's email address or username. You get a reset link that works once, for 24 hours. When no active administrator is left, the account becomes one.
3. Choose a new password with the link, and sign in.
4. Remove `RECOVERY_TOKEN` and restart the server. **Administration → Overview** warns while it is set.

Whoever knows the token can get a reset link for any account while it is set. The account is told at its next sign-in and in its security events, and every admin's overview lists each use. On Cloudflare the token is a Worker secret: see [docs/cloudflare.md](docs/cloudflare.md#locked-out).

---

## Security notes

- **Accounts and spaces.** First-run setup creates the first account, an instance administrator. Every account sees only the spaces it is a member of, with the rights of its role there (see [Spaces, members and roles](#spaces-members-and-roles)); the server checks the role on every request, whatever the web app shows. Each space is a database of its own. People join by invitation: by mail, or, when the server sends no mail, by a link the inviter passes on. Sign-up without an invitation is off unless an admin opens it (`policy open`, which needs mail and verifies the address first). Members of a space see each other's names and email addresses, and a space's archive holds the names and addresses of the people its entries name; deleting an account removes its address from every space.
- **What instance administrators can do.** Being an administrator gives no membership in any space, so the app shows administrators no space content of their own accord. But it is not a wall:
  - An administrator can create a password reset link for an account **without a verified email address** (on an instance without mail, that is every account), use it, sign in as that person and read their spaces. The person is told at their next sign-in, and every administrator sees it. For an account with a verified address on an instance with mail, the reset link goes to the person by mail: the administrator never holds it.
  - Administrators cannot create reset links for other administrators, nor for an account that was an administrator in the last 30 days (or has not signed in since): that takes the command line or the recovery token.
  - On a server of your own, an administrator can download a backup set, which holds every space and every password hash. Each download is recorded and shown to every administrator; `ALLOW_ADMIN_BACKUP_DOWNLOAD=false` turns it off.
  - Every administrative action is recorded with who did it and shown to every administrator; each one asks for the password (or a passkey) again when it was last entered more than 10 minutes ago (`REAUTH_MINUTES`); nobody can demote, disable or delete their own account there, and the last active administrator cannot be removed.
  - Whoever runs the server (or holds the Cloudflare account) can read everything, as with any self-hosted app. Use an instance whose operator you trust.
- **First-run protection.** Until the first account exists, setup requires the code from the server log (or `SETUP_TOKEN`). The code is compared in constant time. Once setup is done, the setup endpoint refuses further accounts, and the last account can never be deleted, so a running instance never offers setup again.
- **Passwords** are hashed with scrypt (N=16384, r=8, p=5 on a server of your own, p=1 on Cloudflare; or PBKDF2-SHA256 with 100,000 iterations with `PASSWORD_KDF=pbkdf2`), with a random salt, and must be at least 8 characters (12 on Cloudflare; `PASSWORD_MIN_LENGTH`). A hash made with older parameters is made again at its next sign-in. A wrong password takes as long to refuse as an unknown address, so the answer tells nobody whether an account exists; sign-up, "forgot password" and email changes give the same answer for every address too.
- **Passkeys** (with `PUBLIC_URL` set to an https address) are bound to that address's domain and need the device to verify you (a fingerprint, a face or a PIN). An account can drop its password once it has a passkey that works here and a way back in if the passkeys are lost.
- **Sessions.**
  - A random 256-bit token is stored in an `HttpOnly`, `SameSite=Lax` cookie: `__Host-lyren_session` under HTTPS (where it is also `Secure`, and no other site can set it), `lyren_session` over plain HTTP. The database stores only a SHA-256 hash of it. A new one is made at every sign-in.
  - Sessions end after `SESSION_TTL_DAYS` of inactivity, and after `SESSION_MAX_DAYS` whatever happens (none on your own server, 90 days on Cloudflare). Expired sessions are purged hourly.
  - Account settings → Security lists your devices (browser, IP, last active) and the account's security events, and lets you sign out any device. Changing or resetting your password signs out every other device; disabling an account signs it out everywhere. On Cloudflare a sign-out, or a device signed out from that list, can keep working against a space for up to 30 seconds (`AUTH_CACHE_SECONDS`); password changes and resets, disabled accounts, removals from a space and demotions reach the spaces at once.
  - Sensitive actions (changing the email address or password, passkeys, deleting the account or a space, inviting admins, downloading or replacing a space, every administrative change) ask for the password or a passkey again when it was last entered more than `REAUTH_MINUTES` ago.
- **Links in mail** (invitations, sign-up, password resets, address confirmations) carry a random token in the part after `#`, which never reaches a server, a log or a mail scanner; each works once, for a limited time, and the server stores only its hash. A confirmation of a new address works only signed in to the account that asked for it. Mail never has user-chosen text in its subject, and names that look like links or addresses are left out of its body.
- **CSRF.** Every state-changing API request must carry the header `X-Lyren-Request: 1`. Browsers cannot add that header to cross-site requests without a CORS preflight, and the server never approves one. The `SameSite=Lax` cookie adds a second layer.
- **Rate limiting.** The counters are kept in the database, so a restart does not reset them, and `reset-password` clears an account's lock-out.
  - Failed sign-ins, setup codes and password confirmations are counted per client address (an IPv4 address, or an IPv6 /64) and per network (/24, or /48): 10 failures within 15 minutes block that address, and 50 that network, until the window ends (HTTP 429).
  - Per account, whatever address the attempts come from: after 20 failed sign-ins within 15 minutes, further attempts must wait, 0.25 s at first and doubling up to 10 s (429 with `Retry-After`), and 100 a day stop password sign-ins from unknown browsers for the rest of the day, with a notice by mail to the account's verified address. Instance-wide, 100 failed sign-ins within 15 minutes stop password sign-ins from unknown browsers. A browser that has signed in to the account before (it keeps a device cookie, `__Host-lyren_device` under HTTPS) is exempt from these, so a stranger who knows your address cannot lock you out of your own devices; passkey sign-ins are exempt too.
  - Mail (sign-up, resets, invitations) is limited per address, per sender and per day, and invitations, space creation and imports per account. Behind a proxy, set `TRUST_PROXY` so that limits apply per real client rather than to the proxy.
- **Headers.**
  - Content-Security-Policy: `default-src 'self'`, with no external scripts, styles, fonts, images or connections, and `frame-ancestors 'none'`.
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and same-origin COOP/CORP.
  - API responses are `Cache-Control: no-store`. HSTS is left to your proxy (on Cloudflare every HTTPS answer carries it).
- **No third-party requests.**
  - The server makes no outbound calls except to the mail server or service you configure, and the web app loads nothing from other origins.
  - Markdown never renders raw HTML. Links open in a new tab with `noopener noreferrer`. Remote images are shown as links instead of being loaded.
- **Imports** are checked in full before anything is written (size, unpacked size, the number of values before they are parsed, every row, every reference), and then written in one transaction. Entries an import attributes to someone other than the importer say "Imported by …", and that person can disown them.
- **Unauthenticated endpoints** are limited to `GET /api/health` (returns `{ ok, version }`), `GET /api/auth/status` (whether setup is pending, the version, and what the instance offers: mail, passkeys, the sign-up policy), setup, sign-in with a password or a passkey, sign-out, sign-up (when open), forgotten passwords, the pages a link opens (inspecting and using the link), and `/api/auth/recover` (only while `RECOVERY_TOKEN` is set). The static web app itself contains no data.
- **Request size limits:** 2 MiB for normal requests, 50 MiB for imports (4 MiB on Cloudflare; configurable), and 64 KiB for the endpoints that need no session. Requests without the `X-Lyren-Request` header, and requests that need a session but have none, are refused before their body is read, so nobody can make the server buffer an upload without signing in first.

---

## Development

```sh
nvm install && npm ci
npm run dev          # API on :8080 (auto-restarts) + Vite on :5173 (hot reload); open http://localhost:5173
```

`npm run dev` runs the API with `tsx watch` and `WEB_DIR` empty, and the Vite dev server, which proxies `/api` to the API. The proxy follows the API's own `PORT` and `HOST` (default `127.0.0.1:8080`), so `PORT=9000 npm run dev` moves both. To proxy to an API elsewhere, set `LYREN_API_URL`, e.g. `LYREN_API_URL=http://192.168.1.20:8080 npm run dev:web`. Vite prints the target when it starts (see `web/devProxy.ts`). Vite listens on all interfaces, so a phone on the same network can open `http://<your-ip>:5173`.

Development data goes to `./data` in the repository, which git ignores. The setup code appears in the API's output; use `SETUP_TOKEN=dev npm run dev` to make it predictable. The service worker is only registered in production builds.

On Windows (Command Prompt or PowerShell, Node 24), `npm run dev`, `npm test`, `npm run typecheck`, `npm run build` and `npm run package:win` work natively too; the few tests that only make sense on Linux (file modes, signals, `xdg-open`) are skipped there. The first `npm run dev` may make Windows ask whether to let Node.js through the firewall, because Vite, and the API with the default `HOST`, listen on all interfaces: allow it on private networks to open the app from a phone; without that, this PC can still use it. Smart App Control may block the native build tools that npm installs; see [Building the app](#building-the-app).

| Script | What it does |
|---|---|
| `npm run dev` | API and web dev servers together (Ctrl+C stops both) |
| `npm run dev:server` / `npm run dev:web` | Just one of the two (`dev:web` proxies to `PORT`/`HOST` or `LYREN_API_URL`) |
| `npm run build` | `vite build` → `dist/web`, and esbuild bundles the server and its dependencies → `dist/server.mjs` |
| `npm start` | `node dist/server.mjs` |
| `npm run typecheck` | `tsc` for the server, web and Cloudflare Worker projects (strict, `noUncheckedIndexedAccess`) |
| `npm test` | Vitest, once, both projects, offline: `node` (shared logic, API tests against in-memory SQLite, unit tests for web logic and the scripts) and `workers` (the Cloudflare Worker and its Durable Objects in workerd, Cloudflare's runtime) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run check` | typecheck + test + build |
| `npm run dev:cf` | The Cloudflare Worker with Wrangler on `http://localhost:8787`, offline (see [docs/cloudflare.md](docs/cloudflare.md#local-development)) |
| `npm run check:cf` | `wrangler deploy --dry-run`: bundles the Worker as a deploy would, offline, into `dist/worker`, and prints its size |
| `npm run deploy:cf` | `wrangler deploy` to your Cloudflare account (after `npx wrangler login`) |
| `npm run package:win` | The single-file Windows app → `dist/lyren-plan-<version>-win-x64.exe` (see [Building the app](#building-the-app)) |
| `npm run package:linux` | The same single-file app for Linux x64 → `dist/lyren-plan-<version>-linux-x64` |
| `npm run package:node` | The archive for Node.js installs → `dist/lyren-plan-<version>-node.tar.gz` and its `.sha256` (see [Releases](#releases); `-- --no-build` packs the existing `dist/`) |

Run a single test file with `npx vitest run server/test/tasks.test.ts`, and one project with `npx vitest run --project node` or `--project workers`. Run the server source directly with `npx tsx --tsconfig tsconfig.server.json server/src/index.ts [serve|backup|restore|reset-password|promote-admin|policy|spaces|help]`, and the Windows app's entry with `WEB_DIR=dist/web npx tsx --tsconfig tsconfig.server.json server/src/sea.ts --no-browser` (it uses the app's defaults: data in `~/.local/share/lyren-plan`, port 43770).

### Releases

The GitHub Actions workflow `.github/workflows/release.yml` builds the single-file apps and the archive for Node.js installs, and publishes them as a GitHub release. (The other workflow, `deploy-cloudflare.yml`, deploys to Cloudflare by hand: see [docs/cloudflare.md](docs/cloudflare.md#4-deploy).) To make a release:

```sh
npm version 0.2.0 --no-git-tag-version   # sets the version in package.json and package-lock.json
git commit -am "Release 0.2.0"
git push
git tag v0.2.0                           # "v" + the version in package.json
git push origin v0.2.0
```

Pushing the tag starts the workflow, which has five jobs:

1. **Build and test** (Ubuntu 24.04). Stops at once if the tag is not `v` + the version in `package.json`. Then `npm ci`, `npm run check`, and the packaging of `lyren-plan-<version>-node.tar.gz`, `lyren-plan-<version>-win-x64.exe` and `lyren-plan-<version>-linux-x64` with a `.sha256` file each, on the Node.js version in `.nvmrc`. The archive for Node.js installs (`scripts/pack-node.mjs`, `npm run package:node`) holds the folder `lyren-plan-<version>/` with `server.mjs` and `web/` from `dist/`, without source maps (only debugging uses them, and they are three quarters of `dist/`). Its entries belong to root (0/0), with modes 0755 and 0644, in a fixed order and with the commit's time (`SOURCE_DATE_EPOCH`), so the same build gives the same archive; the script refuses a `dist/` whose `server.mjs` is not the version in `package.json`. That version must be one whose binaries are pinned in `scripts/lib/node-hashes.mjs` (the workflow sets `LYREN_NODE_PINNED_ONLY=1`, see [Building the app](#building-the-app); a test checks that `.nvmrc` is pinned). To move to a newer Node.js, change `.nvmrc` and add that version's hashes. After packaging the Windows app it also runs the one test in `scripts/test/manifest.test.mjs` that needs the official `node.exe`, which `npm run check` skips because only packaging downloads that file.
2. **Tests on the oldest Node.js** (Ubuntu 24.04): `npm ci` and the server's tests (`npx vitest run --project node`) on Node.js 22.13.0, the oldest version `package.json` allows (a test keeps the two the same). Its `node:sqlite` differs from Node 24's (it opens no `file:` URIs, for one), and these tests upgrade the 1.x fixture and apply staged restores, so that code runs on it in every run, with or without a previous release.
3. **Smoke test on Windows** (Windows Server 2025). `scripts/ci/smoke-windows.ps1` checks the exe against its `.sha256` file, runs `help`, starts the app with `--no-browser`, a new data folder and its own port, waits until `/api/health` answers, stops it with `stop` and checks that it has ended and its port is closed. Then the same upgrade check as on Linux, with the previous release's exe (`-PreviousExe`, which the workflow downloads; skipped with a notice without one). It runs once in PowerShell 7 and once in Windows PowerShell 5.1; the second run ends the previous release as a crash would (`-CrashPrevious`), so the upgrade starts from the `-wal` and `-shm` files it leaves.
4. **Smoke test of the Node.js archive**, twice: on Node.js 22.13.0, the oldest version `package.json` allows (Ubuntu 24.04; a test keeps the two the same), and on Ubuntu's own `nodejs` package, installed with apt (Ubuntu 26.04, as in the [Ubuntu guide](docs/ubuntu-server.md)). `scripts/ci/smoke-node.sh` checks the archive against its `.sha256` file and its entries (all below `lyren-plan-<version>/`, owned by root, no source maps), extracts it, runs `help`, starts `server.mjs` with nothing but `PATH`, a new `DATA_DIR`, `HOST=127.0.0.1` and its own `PORT`, checks `/api/health`, the web app at `/` and a `backup` (a backup set whose `tar -tf` lists `lyren-backup.json` and `directory.db`), and stops it with SIGTERM: exit code 0, port closed, database closed. Then `restore` stages that backup set and the next start applies it (the restore line in its log, the replaced data in `backups/before-restore-<stamp>/`). Then the upgrade check: the previous release's archive (`gh release download` of the newest release that has one; skipped with a notice when there is none or no token) sets up an account and some data, and the new build must upgrade that 1.x database (the log line, `spaces/<id>.db`, a sign-in with the old password), which the previous release then refuses. `SMOKE_PREVIOUS_RELEASE=<file>` runs that check with a local archive instead.
5. **Publish the release.** Creates the release `Lyren Plan <version>` for the tag, marked as a pre-release when the version has a `-` (such as `0.2.0-beta.1`). It holds the two binaries, the archive, their `.sha256` files and `SHA256SUMS` (all three values; `sha256sum -c --ignore-missing SHA256SUMS` checks the files downloaded next to it). The notes begin with what to download (the archive with a link to the Ubuntu guide), the SHA-256 values and a warning that the exe is not code-signed, followed by GitHub's generated list of changes since the previous release (`scripts/ci/publish-release.sh`).

- **A dry run first.** On GitHub, **Actions → Release → Run workflow** runs the build, the tests and both smoke tests on the branch you choose and publishes nothing. The run keeps the binaries and the archive (about 76 MB) for 3 days (under **Artifacts** on the run's page; in a private repository they count against the Actions storage of your plan), and its summary shows the release notes as they would be published.
- **The smoke test by hand**, on Windows, for example on a build of your own:
  ```bat
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\smoke-windows.ps1 -Exe dist\lyren-plan-0.1.0-win-x64.exe -WorkDir "%TEMP%\lyren-smoke-1" -Port 43871
  ```
  It needs all three options and refuses any other argument (put a path with spaces in double quotes), a `-WorkDir` that is not new or empty, and the ports 43770 to 43779 where a real Lyren Plan may run, so it never uses your own data or stops your own Lyren Plan. It leaves its files in `-WorkDir`: take a new folder for every run.
- **The archive's smoke test by hand**, on Linux (it needs bash, tar, sha256sum, curl and grep; `--node` picks the Node.js, by default `node` on `PATH`):
  ```sh
  npm run package:node
  bash scripts/ci/smoke-node.sh --node /usr/bin/node dist/lyren-plan-0.1.0-node.tar.gz /tmp/lyren-smoke-1 43881
  ```
  The same rules: a new or empty work folder for every run, and a free port that is not 8080 or 43770 to 43779.
- **If a job fails**, fix the cause and use **Re-run failed jobs** on the run's page within 7 days (3 for a dry run), while the run's binaries are kept. Publishing never changes a release that is already published: a draft left by a cancelled run is deleted and the release created again; a published release with exactly these files counts as done; one with other files (for example after **Re-run all jobs**, which builds new binaries) stops the job with an error. To replace a published release, delete it on GitHub, keep the tag, and run the job again; or release a new version. If the repository has immutable releases turned on, only a new version works: GitHub never lets the tag of a deleted immutable release be used again. If the build itself was wrong, fix it and release a new version: a tag that has been published should not be moved.
- **Not signed.** The workflow does not sign the exe, so Windows may warn about it or block it (see [Getting it](#getting-it)). [Signing the app](#signing-the-app) describes how to sign a build yourself.
- **Permissions.** The workflow's token can only read the repository, except in the publishing job, which asks for write access (`contents: write`) to create the release. That works whatever **Settings → Actions → General → Workflow permissions** says, because that setting is only the default for workflows that don't ask. Should publishing still fail with "Resource not accessible by integration" (HTTP 403), select **Read and write permissions** there, and for a repository owned by an organisation check the organisation's Actions settings too.
- **Supply chain.** Both workflows use only GitHub's own actions (`checkout`, `setup-node`, `upload-artifact`, `download-artifact`), each pinned to the commit of a release (the version is in a comment next to it), and no caches. The Cloudflare workflow runs the build and the tests in a job without any secret, and deploys from another job, which runs nothing but Wrangler next to the Cloudflare token. The Ubuntu 26.04 smoke test installs `nodejs` from Ubuntu's archive with apt. (`.github/actionlint.yaml` only tells actionlint 1.7.12, which predates it, that `ubuntu-26.04` is a GitHub runner.) Text that others can choose, such as the tag name, reaches the scripts as environment variables only.

### Project layout

```
shared/src/            Shared contract: zod input schemas, DTO types, constants, date and duration helpers, email
                       addresses, roles, the space archive's schema, and the reference task filter/sort and board
                       grouping logic used by server and web
server/src/
  index.ts             Entry point of the Node build and Docker; cli.ts has the commands (serve, backup,
                       restore, reset-password, promote-admin, policy, spaces, help); startupErrors.ts
                       explains start-up failures
  sea.ts               Entry point of the single-file app (Node single executable application)
  desktop/             The single-file app: defaults, options, embedded web client, one server per data
                       folder and the stop command, port fallback, data folder permissions on Windows,
                       opening the browser, console banner; on Windows how it shows itself (mode.ts),
                       the notification-area icon (tray.ts, scripts.ts, powershell.ts), message boxes,
                       the log file and relaunches
  config.ts            Environment variables of the Node build (core/config.ts has the ones both runtimes share)
  core/                Runtime-neutral basics: the database interface and its SQL checks, migrations, ids,
                       cookies, the shared configuration
  gateway/             The one public entry: canonical paths, CSRF, body limits, routing to the directory or
                       a space (shared with the Cloudflare Worker)
  directory/           Accounts, sessions, passwords, passkeys, rate limits, spaces and members, invitations,
                       mail policy, administration, recovery: the accounts' database and its API
  space/               One space's app: the gate (roles, re-auth, conditional reads, budgets), its host
                       (authorization, the users mirror), the space archive's export and import
  routes/              One Hono router per area of a space (projects, tasks, boards, timeline, data, ...)
  services/            Domain logic: task queries in SQL, ranks, activity, stats, task mutations
  db/                  The space database's seeds and sample data, snapshot retention
  http/                Error responses, request validation, security headers, static file server for the web app
  mail/                Mail transports (log, our SMTP client, Resend, Cloudflare), the message builder, templates
  passkeys/            WebAuthn: options, verification, ceremonies, stored credentials
  runtime/node/        The Node runtime: SQLite through node:sqlite, the stack a process serves, space files,
                       the 1.x upgrade, backup sets and restore
  runtime/cloudflare/  The Cloudflare runtime: the Worker, the directory and space Durable Objects, their SQLite
server/test/           API and service tests (vitest, in-memory SQLite)
server/test-workers/   Tests of the Cloudflare runtime in workerd (vitest's workers project): end to end
                       through the Worker, the Durable Objects, the rows-read budget
web/
  index.html           App entry point
  public/              Service worker, web manifest, icons, theme bootstrap script, _headers (Cloudflare)
  vite.config.ts       Vite config (build to dist/web; dev proxy target from devProxy.ts)
  src/app/             Root component, router, auth gates, the space context and layouts, React Query client
  src/api/             Fetch client and every React Query hook: the web-to-API contract
  src/components/ui/   Design-system primitives: buttons, dialogs, sheets, menus, pickers, toasts
  src/components/layout/  App shell: sidebar and space switcher, bottom bar, page headers
  src/components/domain/  Task cards and rows, status/priority/tag display, pickers, task actions menu
  src/features/        Pages by area: dashboard, projects, tasks, boards, timeline, search, spaces, settings,
                       account, admin, import, invitations, auth
  src/lib/             Theme, formatting, hooks, overlay stack, global events, passkeys, per-space storage
scripts/               Dev runner, server bundler (esbuild), icon generator, package.mjs (the single-file app),
                       pack-node.mjs (the archive for Node.js installs); their helpers in scripts/lib, their
                       tests in scripts/test; ci/ has the release workflow's smoke tests (Windows exe,
                       Node.js archive) and publishing script, and the Cloudflare deploy scripts; cf/ the web
                       build Wrangler runs
.github/workflows/     release.yml: builds, tests and publishes releases (see Releases); deploy-cloudflare.yml:
                       deploys to Cloudflare by hand
wrangler.jsonc         The Cloudflare Worker's configuration (nothing of one deployment in it); .dev.vars.example
docs/ubuntu-server.md  Installing on Ubuntu Server 26.04 as a systemd service, on Ubuntu's Node.js
docs/cloudflare.md     Deploying to Cloudflare: runbook, configuration, costs
docs/design/           The design of spaces, accounts and the Cloudflare runtime
Dockerfile, docker-compose.yml
SPEC.md                Engineering spec: the binding contract for the codebase
```

### Architecture

- **One gateway, a directory and one app per space.**
  - On Node, one process: a [Hono](https://hono.dev) gateway on `@hono/node-server` serves the JSON API under `/api` and the built single-page app, with an SPA fallback. It sends `/api/s/<space>/…` to that space's app and everything else (accounts, spaces, members, invitations, administration) to the directory app.
  - On Cloudflare, the same apps: the Worker is the gateway, one Durable Object holds the directory and one per space holds that space, and Workers Static Assets serve the web app (see [docs/cloudflare.md](docs/cloudflare.md)).
  - Static files are gzip-compressed in memory, and hashed assets are cached as immutable (on Node).
- **Storage.**
  - SQLite: on Node via the built-in `node:sqlite`, in WAL mode with foreign keys on, one file for the directory and one per space; on Cloudflare, each Durable Object's own SQLite database. The same SQL runs on both, and the tests check it against the stricter rules of Durable Objects.
  - Migrations are tracked in a `_meta` table of each database, and each says which older versions can still read the result.
  - Every change runs in one transaction together with its activity entry.
  - Task order is a fractional index per space, so reordering a task updates only that task.
  - Reads of a space answer `304 Not Modified` when nothing in it changed since the browser's copy (an `ETag` per space and request), so refetches cost almost nothing.
- **Shared contract.**
  - `shared/src` holds the zod input schemas, used by the server for validation and by the web forms.
  - It also holds the reference filter, sort and board-grouping functions.
  - The server builds equivalent SQL, and a randomized test checks that SQL and JavaScript agree.
  - The web client uses the same functions to apply edits optimistically, so cards move the moment you drop them.
- **Web.**
  - React 19 with React Router 7 and TanStack Query 5, Tailwind CSS 4, and dnd-kit for drag and drop.
  - Every page of a space is under `/s/<space>/…`. Projects, milestones, epics, statuses, tags, boards, people and the space's settings arrive in one `/api/s/<space>/bootstrap` payload.
  - Routes and heavy dialogs are lazy-loaded.
- **Build.**
  - Vite builds the web app.
  - esbuild bundles the server and its npm dependencies into the single file `dist/server.mjs`, so production needs no `node_modules`. Wrangler bundles the Cloudflare Worker from the same sources.
  - `npm run package:win` turns the same server and `dist/web` into one executable: a Node.js single executable application whose web client is served from memory with the same caching rules as from disk.

### API

The web app uses only the JSON API, so you can script it too. The full endpoint list is in [SPEC.md §7](SPEC.md#7-api-reference) (and the design's §7 for accounts, spaces and administration), and the input and output types are in `shared/src/schemas.ts` and `shared/src/types.ts`. Sign in to get the session cookie, and send `X-Lyren-Request: 1` with every request that changes data. A space's endpoints are under `/api/s/<space id>/`; `GET /api/spaces` lists your spaces with their ids (the id is also in the app's address, `/s/<space id>/…`):

```sh
curl -c jar -H 'Content-Type: application/json' -H 'X-Lyren-Request: 1' \
  -d '{"identifier":"you@example.com","password":"..."}' http://localhost:8080/api/auth/login
curl -b jar http://localhost:8080/api/spaces
curl -b jar -H 'Content-Type: application/json' -H 'X-Lyren-Request: 1' \
  -d '{"projectId":1,"title":"Write the README","priority":3,"dueDate":"2026-10-20"}' http://localhost:8080/api/s/<space id>/tasks
curl -b jar -H 'Content-Type: application/json' -H 'X-Lyren-Request: 1' \
  -d '{"filter":{"due":["overdue"]},"sort":{"field":"dueDate","dir":"asc"}}' http://localhost:8080/api/s/<space id>/tasks/query
```

Over HTTPS the session cookie is `__Host-lyren_session`, which curl keeps in its jar like any other.

Read [SPEC.md](SPEC.md) before changing code. It defines the domain rules, API, board semantics, web conventions and ownership.

---

## License

MIT, as declared in `package.json`.
