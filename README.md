# Lyren Plan

Lyren Plan is a self-hosted project manager for one person. You track projects, which hold milestones, epics and tasks. Saved boards show your tasks the way you want. Every task has comments, a work log and a full change history. One Node.js process serves the web app and its JSON API, and all data lives in a single SQLite file. It needs no external database, no third-party services and no outbound network access, and the browser never loads anything from another origin. It works in desktop and mobile browsers and can be installed as a PWA. On Windows it also comes as a single program that needs nothing else installed: see [Windows app](#windows-app).

- [Features](#features)
- [Quick start](#quick-start)
- [Windows app](#windows-app)
- [Docker](#docker)
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
| Tasks in epics | A task belongs to a project and optionally to an epic; its milestone is the epic's milestone. A task has a title, a Markdown description, a status and a priority (none, low, medium, high, urgent). It also has tags, start and due dates, an estimate in points or hours (a setting), a manual order and an archive flag. Tasks can be duplicated or moved to another project, which gives them a new ref; a task moved back to a project it was in (for example with **Undo**) gets its old ref there again, so links to it keep working. A task opens in a side drawer or as a full page at `/tasks/WEB-42`. Task lists (a project's Tasks tab, and the epic and milestone pages) hide closed and archived tasks until you tick **Closed** or **Archived**; an empty list says when everything in it is closed or archived and offers to show it. **Select** mode, in task lists and on boards, changes the status, priority, due date, epic or tags of several tasks at once, archives or unarchives them, or deletes them. |
| Highly configurable boards | Boards are saved views of your tasks. Global boards live on the Boards page, and each project can have several boards on its Board tab. See [Boards](#boards) below. |
| Tag tasks | Tags are global and colored. You can rename, recolor, merge and delete them, and create new ones while tagging a task. |
| Comments | Comments are written in Markdown (GitHub-flavored), and you can edit or delete your own. Unsent drafts are kept per task. Closing the task while you edit a comment or a work-log entry saves the edit; only **Cancel** discards it (a changed comment asks first). |
| Log activity (work log) | Every task has a work log. Each entry has a date, the time spent (`1h 30m`, `90`, `1.5h` and `1:30` all work) and a note. The task shows its total against the estimate when the estimate is in hours. The **Work log** page reports logged time by range (this week, last week, this month, last 30 days or custom), with totals per project and per day. |
| Log activity (history) | Changes are recorded automatically, field by field: title, description, status, priority, epic, dates, estimate, tags, archive and moves between projects. Changes to projects, milestones and epics, comments and work logs are recorded too. You can read the history on each task, on each project's Activity tab, and on the global Activity page. |
| Self-hostable, no third parties | Runs as `npm ci && npm run build && npm start` or with Docker. The data is one SQLite file. There are no CDNs, web fonts, analytics or outbound calls, and the Content-Security-Policy blocks them. |
| Web browser and mobile browser | Every screen works from 360 px wide. Phones get a bottom navigation bar (its **More** sheet holds Activity, Work log, Settings, the theme and Sign out), a floating "+" button for new tasks, and full-screen sheets that the Back gesture closes. Board cards are dragged with a long press, and every card also has a menu that does the same moves without dragging. The app installs as a PWA and keeps its shell available offline. |

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

- **Dark mode.** Choose Light, Dark or System for each device, from the user menu, the phone's More sheet, Settings → Preferences or the command palette.
- **Settings.**
  - Account: display name, password, and your signed-in devices, which you can sign out.
  - Preferences: theme, first day of the week, estimate unit (points or hours), and home page (the dashboard or a default board).
  - Statuses: you can add, rename and reorder statuses. Each status belongs to one of five fixed categories: backlog, to do, in progress, done, cancelled. A new status is placed after the last status of its category. The defaults are Backlog, Todo, In Progress, In Review, Done and Cancelled.
  - Tags.
  - Data: JSON export and import, and a SQLite backup download.
- **First-run setup.** On first start, the server prints a setup code to its log. You enter it on the setup page to create the owner account, with or without sample data.

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

Open <http://localhost:8080>, or `http://<server-ip>:8080` from another device. Then enter the setup code, your name, a username and a password (at least 8 characters). **Create sample data** is ticked by default and adds two demo projects to explore; untick it to start empty.

The setup code is only needed until the account exists. The setup page asks for it so that nobody else can claim a freshly exposed instance. A new random code is generated on every start until setup is done. Set `SETUP_TOKEN` to choose your own.

`dist/` is self-contained, so you can copy it to another machine that has Node ≥ 22.13 and run `node dist/server.mjs` there without `node_modules`. Copy the whole folder: without `dist/web` (or with `WEB_DIR` pointing elsewhere) the server logs `Web client not found: no index.html in …` and the browser shows a page saying the web client is missing. The database goes to `./data` under the **current working directory** unless you set `DATA_DIR`.

### Running as a service (systemd)

Create a system user and its private data directory once (the service user cannot create `/var/lib/lyren-plan` itself):

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin lyren
sudo install -d -o lyren -g lyren -m 700 /var/lib/lyren-plan
```

```ini
# /etc/systemd/system/lyren-plan.service
[Unit]
Description=Lyren Plan
After=network.target

[Service]
User=lyren
WorkingDirectory=/opt/lyren-plan
Environment=DATA_DIR=/var/lib/lyren-plan
Environment=HOST=127.0.0.1
Environment=TRUST_PROXY=true
ExecStart=/usr/bin/node dist/server.mjs
Restart=on-failure
UMask=0077

[Install]
WantedBy=multi-user.target
```

Adjust the `node` path (`which node`) and the user; `/opt/lyren-plan` must be readable by that user. Leave out `HOST` and `TRUST_PROXY` if no reverse proxy is in front (see [Reverse proxy](#reverse-proxy-and-https)). The server shuts down cleanly on SIGTERM. Read the setup code with `journalctl -u lyren-plan`.

The server (and every CLI command) creates its files owner-only: `DATA_DIR` and `backups/` as 0700, the database, its WAL and every snapshot as 0600, whatever umask it was started with. A data directory created by an earlier build may still be readable by other accounts; tighten it once with `chmod -R go-rwx /var/lib/lyren-plan`. Because the data is private to the service user, run the maintenance commands below (backup, restore, reset-password) as that user, for example with `sudo -u lyren`.

### Start-up problems

Start-up problems are reported in a few plain lines instead of a stack trace:

| Message | Fix |
|---|---|
| `Invalid value for PORT: …` (exit code 2) | Correct the named environment variable (see [Configuration](#configuration)). |
| `Could not open the database …` with `must be writable by the user running the server` | Give the data directory to the service user, e.g. `sudo chown -R lyren: /var/lib/lyren-plan`, or for a Docker bind mount `sudo chown -R 1000:1000 ./data`. |
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

Double-click the exe. No window opens: Lyren Plan runs in the background and shows its icon in the **notification area**, at the right end of the taskbar near the clock. At the same time your default browser opens the app. On the first start that is the setup page with the setup code already filled in, so you only enter your name, a username and a password. (The code travels in the part of the address after `#`, which is never sent to the server, and the page removes it from the address bar straight away.)

- **Finding the icon.** Windows 11 first puts new icons under the **^** arrow next to the clock. To keep Lyren Plan's icon on the taskbar, turn it on under **Settings → Personalization → Taskbar → Other system tray icons**. Windows names icons there after the program that shows them; Lyren Plan's is shown by Windows PowerShell (see [How the icon works](#how-the-icon-works)), so the entry may be listed as **Windows PowerShell** rather than Lyren Plan. Pointing at the icon shows "Lyren Plan - " and the address. On Windows 10, click the **^** arrow and drag the icon onto the taskbar.
- **The icon's menu** (right-click): **Open Lyren Plan** (also a left click; until your account exists it opens the setup page with the code again), **Open data folder**, with `--lan` **Copy address for other devices**, and **Quit Lyren Plan**. Web pages of the app show a one-time note about the icon.
- **To stop Lyren Plan**, choose **Quit Lyren Plan** in that menu, or run `lyren-plan-0.1.0-win-x64.exe stop` (see [Command line](#command-line)). Either way the database is closed cleanly, and so it is when you sign out of Windows or shut down. Closing the browser does not stop Lyren Plan.
- **Starting it again while it runs** opens the browser at the running copy (at the setup page until your account exists). Two copies never use the same database.
- To **bookmark** it or **install it as an app** (in Edge: **⋯ → Apps → Install this site as an app**), use the address the browser opened. If you open the bookmark or the installed app while Lyren Plan is not running, the page says **"Can't reach Lyren Plan"**: start the exe, then click **Try again**.
- **If something goes wrong**, for example a data folder you cannot write to, a port that is taken or an unexpected error, a message box says what happened, with the same text the console window showed in earlier versions. So do warnings, such as a data folder that other Windows accounts can read, and an address the browser could not be opened at. If a running Lyren Plan takes longer than two seconds to answer a second start, a message box says that it is waiting (and that the browser opens once it answers, unless `--no-browser` or `OPEN_BROWSER` turned the browser off for that start; the box names which).
- **The log file.** Everything Lyren Plan reports (the address, warnings, errors, and with `LOG_REQUESTS=true` every request) goes to `logs\lyren-plan.log` in the data folder, each line with its time. With `--db-path` the `logs` folder is next to the database file, and a database file with another name than `lyren.db` gets a log named after it, such as `logs\work.db.log` (see [Data folder](#data-folder)). The setup code is left out (it reads `[not in the log]`), so you can attach the log to a bug report; starting Lyren Plan again opens the setup page with the code filled in. When the file reaches 1 MiB it becomes `lyren-plan.1.log`, replacing the previous one, and a new file starts.
- **Commands from a shortcut.** `backup`, `reset-password`, `stop` and `help` started without a window (from a shortcut, with Win+R, from another file manager or launcher, or with PowerShell's `Start-Process`) show what they print when they finish: in a message box (Ctrl+C copies its text, for example a new password), or, for the long `help`, in a console window that stays open until you press Enter. The command itself does not wait for you: it ends with its exit code as soon as the box (or the window) is up, and the box stays until you click **OK**. Only where nobody can be at the screen do they show nothing: started by Task Scheduler, a Windows service or WMI, or in session 0 (a task that runs "whether user is logged on or not"); see [Scheduled tasks](#command-line).
- **Start it with Windows:** press Win+R, enter `shell:startup`, and create a shortcut to the exe in the folder that opens. In the shortcut's properties, add ` --no-browser` at the end of **Target**.

**In Command Prompt or PowerShell.** Started there, for example `lyren-plan-0.1.0-win-x64.exe --port 8090`, Lyren Plan runs in that window as it always has: it prints the address and the setup code there, Ctrl+C (or closing the window) stops it, and if something prevents the start, the message stays until you press Enter. It shows the icon too, so **Quit Lyren Plan** works as well. The commands `backup`, `reset-password`, `stop` and `help` print in the window, and the prompt waits for them.

**The console window of earlier versions (`--console`).** Started with `--console`, for example from a shortcut whose **Target** ends in ` --console`, Lyren Plan runs in a console window of its own, without the icon: the window shows the address and the setup code, and closing it or pressing Ctrl+C stops Lyren Plan. Lyren Plan switches to such a window by itself, with the same setup code and without opening the browser twice, when it cannot show the icon: when Windows PowerShell is missing or does not start, or when an application-control policy (App Control for Business, AppLocker) only lets it run in ConstrainedLanguage mode. The log file says why. If no console window can be opened either, Lyren Plan stops and a message box (or, without PowerShell, the log file) says so. A message that cannot be shown in a message box appears in such a window, too.

#### How the icon works

A program needs a window of its own to show an icon in the notification area, and Lyren Plan is a console program: that is what makes Command Prompt wait for its commands. So it starts **Windows PowerShell 5.1**, which is part of every Windows 10 and 11 and signed by Microsoft, hidden, and lets it show the icon with a short, readable script that is built into the exe and handed to PowerShell on its input. Nothing is written to disk, no execution policy is changed and no code of its own needs to be trusted by Smart App Control. The script also avoids the words for which PowerShell records a script as suspicious in its event log (a warning that security software watches for). That PowerShell process is the `powershell.exe` you see under Lyren Plan in Task Manager (about 100 MB of memory) and the reason why Windows may list the icon as Windows PowerShell. It ends together with Lyren Plan: if you end Lyren Plan in Task Manager, the icon disappears within a second or two. If PowerShell stops on its own, Lyren Plan starts it again, up to three times. Message boxes are shown the same way. Those of the running app go away with it; the box with the result of a command (see [Commands from a shortcut](#starting-and-stopping)) stays after the command has ended, until you click **OK**, and its PowerShell then ends.

**Older Windows.** Windows 11 version 24H2 and later start the exe without a console window. Windows 10 and Windows 11 up to 23H2 ignore that setting and open a console window for a double-click; Lyren Plan then starts itself again without one at once, so the window only flashes briefly. (This was tested on Windows 11 25H2 only.)

### Data folder

In `%LOCALAPPDATA%\Lyren Plan`, that is `C:\Users\<you>\AppData\Local\Lyren Plan`, which only your Windows account can read. (Local rather than Roaming AppData, because a SQLite database must not be copied around by roaming profiles.) The folder holds the same files as `DATA_DIR` of the Node version, see [Where the data lives](#where-the-data-lives), plus `desktop.json`, which remembers the port and identifies the running copy, and the `logs` folder with the log file. Deleting, moving or replacing the exe leaves the folder alone.

To keep the data somewhere else, for example on another drive, start the app with `--data-dir D:\Lyren` (add it to a shortcut's **Target**) or set `DATA_DIR`. `--db-path` (or `DB_PATH`) moves only the database file; `desktop.json` and the `logs` folder are then next to it. A database file with another name than `lyren.db` gets files named after it, for example `work.db.desktop.json` and `logs\work.db.log` for `work.db`, so two databases in one folder can run at the same time. Don't point a Node or Docker Lyren Plan at the same folder while the app runs.

- **A folder the app creates** is made private: only your Windows account (and SYSTEM and the administrators, as for `%LOCALAPPDATA%`) can open it, also when its path is longer than 259 characters. This matters outside your user profile: on its own, a new folder takes over the permissions of the folder above it, and the root of a drive such as `D:\` lets every account on the PC read what is created below it.
- **An existing folder** keeps its permissions. If other Windows accounts can open it, Lyren Plan warns about it (in a message box, and in the log file) with an `icacls` command that makes it private; run it once in Command Prompt (in PowerShell if the warning says so, for a path with a `%`).
- A drive formatted as FAT32 or exFAT (many USB sticks) has no permissions at all, so anyone who can use the PC can read the data on it. When the app cannot make a new folder private, it says so.

Backups work as in the Node version: **Settings → Data → Download backup**, or the `backup` command below. To restore a backup, quit Lyren Plan (**Quit Lyren Plan** in the icon's menu, or the `stop` command), replace `lyren.db` in the data folder with the backup file, delete `lyren.db-wal` and `lyren.db-shm` if they exist, and start the app again. (With `--db-path`, replace that file instead, and delete its `-wal` and `-shm` files next to it.)

**Settings → Data → Data folder and commands** shows the data folder and these commands with your program's name (and with `--data-dir` or `--db-path` when you started the app with one; for PowerShell when a path contains a `%`, see [Command line](#command-line)), how to stop Lyren Plan the way it runs, plus a Windows Task Scheduler entry for a daily backup. The sign-in page shows the `reset-password` command.

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

Download a backup first (**Settings → Data → Download backup**). Quit Lyren Plan and replace the exe with the new one, or keep both and start the new one. The data stays where it is. On its first start the new version migrates the database, after writing a `before-upgrade` snapshot to `backups\`, exactly like the Node version. An older exe refuses to open a database that a newer one has migrated. After a `--lan` start, Windows asks about the firewall again for the new file.

### Uninstalling

Quit Lyren Plan and delete the exe. To remove your data as well, delete the folder `%LOCALAPPDATA%\Lyren Plan` (download a backup first if you might want it again). An installed browser app is removed from the browser's app list, and a firewall permission under **Allow an app through firewall**.

### Command line

The exe has the same commands as `node dist/server.mjs`. Run them in Command Prompt or PowerShell in the exe's folder (PowerShell needs `.\` in front of the name). The examples use the file name of version 0.1.0; type the name of yours (the Tab key completes it), or rename the file first. A name with spaces, such as `Lyren Plan.exe`, needs quotes: `"Lyren Plan.exe" help` (in PowerShell `& ".\Lyren Plan.exe" help`). `help` prints the commands with the program's actual name.

```bat
lyren-plan-0.1.0-win-x64.exe help
lyren-plan-0.1.0-win-x64.exe backup "%USERPROFILE%\Documents\lyren-2026-10-14.db"
lyren-plan-0.1.0-win-x64.exe reset-password owner
lyren-plan-0.1.0-win-x64.exe stop
```

- `backup <file>` is safe while the app runs and uses the app's data folder (or `--data-dir`, or `--db-path`). It refuses to overwrite a file.
- `stop` asks the Lyren Plan that runs with that data folder (or `--data-dir`, or `--db-path`) to quit, as **Quit Lyren Plan** would, and waits until it has closed the database. It ends with exit code 0 when Lyren Plan has stopped, and with 1 and an explanation when none runs there or it could not be stopped. It proves that it may do so with the secret in `desktop.json`, which only your Windows account can read, so other accounts and other programs can't stop your Lyren Plan this way. A copy of an older version, from before the `stop` command, says so; close its window instead. The `stop` command that Lyren Plan itself suggests (in the log file, and when you start it a second time) includes the `--data-dir` or `--db-path` it was started with. It also works from a shortcut (a message box then says whether it stopped), and in the Linux version.
- The commands open `lyren.db` in the default data folder. If you start the app with `--data-dir` or `--db-path`, or with `DATA_DIR` or `DB_PATH` set, give the commands the same option, for example `lyren-plan-0.1.0-win-x64.exe reset-password owner --data-dir D:\Lyren`: a Command Prompt opened later doesn't know the variables the app was started with. Settings → Data shows the commands with the option your app needs.
- `reset-password <user>` without anything piped in prints a new random password; you can change it afterwards under **Settings → Account**. To choose the password, pipe it in:
  - Command Prompt: `echo my new password| lyren-plan-0.1.0-win-x64.exe reset-password owner`. Don't put a space before `|`, or it becomes part of the password, and put `^` before `& | < > ^`. For letters outside ASCII (ä, é, ß), run `chcp 65001` first: otherwise Command Prompt passes them in its old code page, and the command refuses the password ("not UTF-8 text") and changes nothing.
  - PowerShell 7: `'my new password' | .\lyren-plan-0.1.0-win-x64.exe reset-password owner`. Windows PowerShell 5.1 turns letters outside ASCII into `?`, which can't be detected, so the command only warns when the new password contains a `?`.
  - The line break at the end, CRLF on Windows, is removed.
- If you were locked out by too many attempts, wait 15 minutes, or quit Lyren Plan and start it again. (`reset-password` alone doesn't lift the lock.)
- **A `%` in a path.** Command Prompt replaces `%NAME%` with the value of that environment variable if one exists, even inside quotes, where it can't be escaped: a data folder `D:\R&D 100%PATH%` would reach the program with your `PATH` in it. If the data folder, the database or the program's name contains a `%`, run the commands in PowerShell, with the path in single quotes: `& '.\lyren-plan-0.1.0-win-x64.exe' stop --data-dir 'D:\R&D 100%PATH%'`. In single quotes, type each `'` twice, and each typographic quotation mark `‘ ’ ‚ ‛` too (as in `Dana’s`): Windows PowerShell ends the string at any of them. A path that ends in a backslash and has a space in it, such as the root of a network share `\\nas\Lyren 100%\`, needs that backslash twice (`'\\nas\Lyren 100%\\'`): Windows PowerShell 5.1 would otherwise hand the program a stray `"` instead. Lyren Plan writes its own commands that way (the `stop` command in the log file and for a second start, Settings → Data, the sign-in page), so the easiest is to copy the command from there.
- **Scheduled tasks.** For a daily backup, create a task in Windows Task Scheduler with `powershell.exe` as the program and the arguments that **Settings → Data → Data folder and commands** shows, for example `-NoProfile -Command "& 'C:\Users\you\Apps\lyren-plan-0.1.0-win-x64.exe' backup ($env:USERPROFILE + '\Documents\Lyren Plan backups\lyren-' + (Get-Date -Format yyyy-MM-dd) + '.db')"`: each run writes a new file named after the day (the `backup` command never overwrites a file, and Task Scheduler can't put the date into the exe's arguments itself). The task's **Last Run Result** is 0 when the backup succeeded and 1 when it failed. If the exe itself is the task's program (then Task Scheduler starts it), or the task runs "whether user is logged on or not" (then it runs in session 0, without a desktop), a command shows no message box: what it prints goes to the log file next to the database (`logs\lyren-plan.log`, or `logs\<name>.log` for a database file named otherwise, such as `logs\work.db.log`; only if that folder exists), and it ends with its exit code at once. `reset-password` started that way refuses to make up a random password nobody would see; pipe the new password to it instead. A command that another program starts without a window (a launcher, a script's `Start-Process`) shows its message box as from a shortcut and ends with its exit code at once; the box stays until someone clicks **OK**. One exception: PowerShell's `Start-Process -Wait` waits for every process the command started, so it returns only once the box is closed. In a script, run the exe with `& '<path to the exe>' …` instead (what it prints appears in the script's console, the exit code is in `$LASTEXITCODE`), or use `Start-Process -PassThru` and then `.WaitForExit()` on the result.

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

Set other variables from the [Configuration](#configuration) table the same way, under `environment:`.

---

## Configuration

All configuration is through environment variables. `node dist/server.mjs help` prints the same list. The [Windows app](#windows-app) reads the same variables but has its own defaults for `HOST`, `PORT`, `DATA_DIR` and `WEB_DIR`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on (1-65535). |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to accept local connections only, for example behind a reverse proxy on the same host. |
| `DATA_DIR` | `./data` (relative to the working directory); `/data` in Docker | Data directory, created if missing. It holds the database and the `backups/` folder of automatic snapshots. |
| `DB_PATH` | `<DATA_DIR>/lyren.db` | Location of the database file. Pre-upgrade snapshots are written to a `backups/` folder next to this file. Pre-import snapshots and temporary backup files still go to `DATA_DIR`. |
| `WEB_DIR` | `web/` next to `server.mjs` (i.e. `dist/web`) | Built web client to serve. An empty value serves the API only (`npm run dev` does this). If the folder has no `index.html`, the server logs a warning and pages show a "web client is missing" notice. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` (right-most entry) and `X-Forwarded-Proto` from a reverse proxy. Turn it on **only** when every request goes through your proxy. |
| `COOKIE_SECURE` | `auto` | `auto`: the session cookie gets the `Secure` flag when the request is HTTPS, either directly or through `X-Forwarded-Proto` with `TRUST_PROXY`. `true` or `false` forces it either way. |
| `SESSION_TTL_DAYS` | `30` | Session lifetime in days (max 400). It is sliding: each session is extended at most once an hour while you use it. |
| `SETUP_TOKEN` | random | First-run setup code. If unset, a random 12-character code is generated at each start and printed. Not used once the account exists. |
| `BODY_LIMIT` | `2097152` (2 MiB) | Maximum request body size for API requests. |
| `IMPORT_BODY_LIMIT` | `52428800` (50 MiB) | Maximum size of a JSON import (`POST /api/data/import`). |
| `SNAPSHOT_KEEP` | `10` | Automatic snapshots of each kind kept in `backups/` (`pre-import-*` and `lyren-v*-before-upgrade-*`, counted separately). After writing a new one, the server deletes the older ones of that kind. `0` keeps all. Only files named exactly like those snapshots are ever deleted, so your own backups in `backups/` are never touched. |
| `LOG_REQUESTS` | `false` | Log every request to stdout. |
| `OPEN_BROWSER` | `true` | Windows app only: open the browser at the app on start (`--no-browser` sets it to false). Like every boolean below, any value other than `1`, `true`, `yes` or `on` means false. |

Boolean variables accept `1`, `true`, `yes` or `on`, in any case. Any other value means false. Numbers must be whole numbers within range: at least 1, except `SNAPSHOT_KEEP`, which may be 0. An invalid value stops the server at startup with an error that names the variable.

---

## Reverse proxy and HTTPS

Lyren Plan speaks plain HTTP and does not handle TLS itself. To reach it from outside your LAN, put it behind a TLS-terminating reverse proxy, or use a VPN. With a proxy:

1. Bind the app to localhost (`HOST=127.0.0.1`, or `127.0.0.1:8080:8080` in Docker) so clients cannot bypass the proxy.
2. Set `TRUST_PROXY=true`. This has three effects:
   - Session cookies become `Secure` when the proxy sends `X-Forwarded-Proto: https`. If your proxy does not send that header, set `COOKIE_SECURE=true`.
   - The login rate limiter and the "signed-in devices" list see real client IPs instead of the proxy's address.
   - The app uses the **right-most** `X-Forwarded-For` entry. That is correct for exactly one proxy hop. With a chain (for example a CDN in front of nginx), the IP seen is that of the hop next to your proxy.
3. Serve it at the root of its own hostname (for example `https://plan.example.com/`). A sub-path such as `/lyren/` is not supported.

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

    # nginx rejects bodies over 1 MB by default; JSON imports can be up to 50 MB.
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
| `lyren.db` | The SQLite database: all projects, tasks, settings, your account and sign-in sessions. |
| `lyren.db-wal`, `lyren.db-shm` | SQLite write-ahead log files. They are part of the live database, so never copy `lyren.db` alone while the server runs. |
| `backups/pre-import-<timestamp>.db` | Snapshot written automatically before every JSON import. The newest `SNAPSHOT_KEEP` (default 10) are kept. |
| `backups/lyren-v<N>-before-upgrade-<timestamp>.db` | Snapshot written automatically before a new version migrates the database schema, into `backups/` next to `DB_PATH`. The newest `SNAPSHOT_KEEP` (default 10) are kept. |
| `.backup-<random>.db` | Temporary copy behind a backup download. It is deleted as soon as the download starts streaming; one left behind by a crash is deleted at the next start. |
| `desktop.json` | Desktop app only (Windows and Linux): the remembered port, the running copy's identity and, from a first start until the next one, the setup code. Next to the database; for a database with another name than `lyren.db`, `<name>.desktop.json`. |
| `logs/lyren-plan.log`, `logs/lyren-plan.1.log` | Windows app only, when it shows its icon in the notification area: what it reports, see [Starting and stopping](#starting-and-stopping). Next to the database; for a database with another name, `logs/<name>.log`. |

**Snapshot retention.** After writing an automatic snapshot, the server keeps the newest `SNAPSHOT_KEEP` (default 10) of that kind and deletes older ones; pre-import and pre-upgrade snapshots are counted separately, and the log says `[lyren] Deleted N old … snapshots`. Only files whose whole name matches those two patterns are deleted, so files from the `backup` command, cron backups in `backups/` and renamed copies are never touched. To keep a snapshot for good, copy it elsewhere or rename it. `SNAPSHOT_KEEP=0` keeps them all.

### Ways to back up

| Method | What you get | Notes |
|---|---|---|
| **Settings → Data → Download backup** | `lyren-backup-YYYY-MM-DD.db`, a consistent copy of the SQLite database | Sign-in sessions are removed from the copy. |
| **`backup` command** | A consistent copy written to the path you give | Safe while the server is running. Sign-in sessions are removed from the copy. |
| **Settings → Data → Export JSON** | `lyren-export-YYYY-MM-DD.json` with every project, milestone, epic, task, comment, work log, activity entry, tag, status, board and setting | Does not include your account or sessions. Use it to move data between instances or to keep a readable archive. |

The `backup` command must run with the **same `DATA_DIR`/`DB_PATH` and working directory as the server**. Run it as the user that owns the data directory, into a folder that user can write. If no database exists at that location it stops with an error (it never creates an empty one). It refuses to overwrite an existing file, so use a unique name such as a date stamp:

```sh
sudo install -d -o lyren -g lyren -m 700 /var/backups/lyren-plan   # once
cd /opt/lyren-plan
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node dist/server.mjs backup /var/backups/lyren-plan/lyren-$(date +%F).db
```

Nightly from cron, in the service user's crontab (`sudo crontab -u lyren -e`; `%` must be escaped in crontab):

```cron
# Node install
0 3 * * * cd /opt/lyren-plan && DATA_DIR=/var/lib/lyren-plan /usr/bin/node dist/server.mjs backup /var/backups/lyren-plan/lyren-$(date +\%F).db
# Docker: writes into the data volume; copy it elsewhere afterwards
0 3 * * * docker exec lyren-plan node dist/server.mjs backup /data/backups/lyren-$(date +\%F).db
```

To copy a backup out of the container: `docker cp lyren-plan:/data/backups/lyren-2026-10-13.db .`. Keep copies on another machine. Backups contain your password hash (scrypt), so store them privately.

### Restore a SQLite backup

1. Optional: back up the current state first with the `backup` command.
2. Stop the server.
3. Replace `lyren.db` in the data directory with the backup file. The restored file must be writable by the user that runs the server.
4. Delete `lyren.db-wal` and `lyren.db-shm` if they exist.
5. Start the server. If the backup comes from an older version, it is migrated on start (and a before-upgrade snapshot is written first). An older build refuses to open a backup made by a newer version.
6. Sign in with the password that was valid when the backup was taken. Backups from the `backup` command and from the in-app download contain no sign-in sessions. The automatic pre-import and pre-upgrade snapshots do, so after restoring one of those use **Settings → Account → Sign out all other devices** if that matters to you.

Node install (the copy and delete run as the service user, so the file keeps its owner; the backup file must be readable by that user, e.g. in `/tmp`):

```sh
sudo systemctl stop lyren-plan
sudo -u lyren cp /tmp/lyren-backup-2026-10-13.db /var/lib/lyren-plan/lyren.db
sudo -u lyren rm -f /var/lib/lyren-plan/lyren.db-wal /var/lib/lyren-plan/lyren.db-shm
sudo systemctl start lyren-plan
```

Docker compose. This runs a one-off container with the service's volume as the `node` user (untested, see the [Docker note](#docker)):

```sh
docker compose stop lyren
docker compose run --rm --no-deps -v "$PWD/lyren-backup-2026-10-13.db:/restore.db:ro" \
  --entrypoint sh lyren -c 'cp /restore.db /data/lyren.db && rm -f /data/lyren.db-wal /data/lyren.db-shm'
docker compose start lyren
```

To undo a JSON import, restore its `backups/pre-import-<timestamp>.db` snapshot the same way. The success notice after an import names that file. Only the newest `SNAPSHOT_KEEP` (default 10) pre-import snapshots are kept, so copy one elsewhere if you may need it after many more imports.

### JSON import

**Settings → Data → Import** replaces **all** projects, milestones, epics, tasks, comments, work logs, activity, tags, statuses, boards and settings with the contents of an export file. You must type `REPLACE` to confirm.

- The file is fully validated first, including references between records. If anything is wrong, the import is rejected with a list of the problems and nothing changes.
- Before replacing anything, the server writes `DATA_DIR/backups/pre-import-<timestamp>.db` (older pre-import snapshots beyond `SNAPSHOT_KEEP` are then deleted).
- The data is replaced in one transaction, keeping the original ids. Comments, work logs and activity are attributed to the importing account.
- Your account, password and sign-in sessions are left unchanged.

---

## Upgrading

Back up first (see above). Then:

```sh
# Node install
cd /opt/lyren-plan
git pull
npm ci
npm run build
sudo systemctl restart lyren-plan

# Docker compose
git pull
docker compose build --pull
docker compose up -d
```

Database migrations run automatically at startup. Before an existing database is migrated, a snapshot `backups/lyren-v<old>-before-upgrade-<timestamp>.db` is written next to the database (the newest `SNAPSHOT_KEEP` of these are kept). An older build refuses to start on a database migrated by a newer one, with the message `Database schema version X is newer than this build supports (Y)`. To roll back, run the old build against the before-upgrade snapshot.

Browsers pick up the new web app on their next page load. For an installed PWA, close and reopen it.

The Windows app is updated by replacing the exe; see [Updating](#updating).

---

## Forgotten password

`reset-password` sets a new password and signs the account out on every device. It can run while the server is up. Use the same `DATA_DIR` as the server, and run it as the service user.

```sh
cd /opt/lyren-plan

# Generate and print a random password:
sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node dist/server.mjs reset-password owner

# Or choose one. Piping it in on stdin keeps it out of your shell history:
read -rs PW && printf '%s\n' "$PW" | sudo -u lyren env DATA_DIR=/var/lib/lyren-plan node dist/server.mjs reset-password owner; unset PW
```

With Docker:

```sh
docker exec -it lyren-plan node dist/server.mjs reset-password owner                 # random password
read -rs PW && printf '%s\n' "$PW" | docker exec -i lyren-plan node dist/server.mjs reset-password owner; unset PW
```

- The password must be 8 to 256 characters, the same rule as the sign-in form. Anything else is refused and nothing changes.
- **Forgot the username?** Run the command with any name and it lists the existing ones: `No user named "x". Existing users: owner`.
- **Locked out after too many attempts?** Wait 15 minutes or restart the server.
- **Windows app:** run `lyren-plan-0.1.0-win-x64.exe reset-password owner` (the name of your copy) in the exe's folder, with `--data-dir` or `--db-path` if you start the app with one; see [Command line](#command-line). The sign-in page and **Settings → Data** show the command. Run without a window (from a shortcut or with Win+R), it shows the new password in a message box, whose text Ctrl+C copies. A lock-out after too many attempts ends after 15 minutes, or when you quit Lyren Plan and start it again.

---

## Security notes

- **One account.** First-run setup creates a single owner account. There is no sign-up, invitation or user management, and every signed-in session sees all data. Multi-user use is not implemented.
- **First-run protection.** Until the account exists, setup requires the code from the server log (or `SETUP_TOKEN`). The code is compared in constant time. Once setup is done, the setup endpoint refuses further accounts.
- **Passwords** are hashed with scrypt (N=16384, r=8, p=1, random salt) and must be at least 8 characters.
- **Sessions.**
  - A random 256-bit token is stored in an `HttpOnly`, `SameSite=Lax` cookie (`lyren_session`). The cookie is also `Secure` under HTTPS, as described for `COOKIE_SECURE`.
  - The database stores only a SHA-256 hash of the token.
  - Sessions expire after `SESSION_TTL_DAYS` of inactivity, and expired sessions are purged hourly.
  - Settings → Account lists your devices (browser, IP, last active) and lets you sign out any of them. Changing your password signs out every other device.
- **CSRF.** Every state-changing API request must carry the header `X-Lyren-Request: 1`. Browsers cannot add that header to cross-site requests without a CORS preflight, and the server never approves one. The `SameSite=Lax` cookie adds a second layer.
- **Rate limiting.**
  - Failed login, setup-code and password-change attempts are counted per client network: an IPv4 address, or an IPv6 /64 (one IPv6 subscriber usually controls a whole /64). 10 failures within 15 minutes block further attempts from that network until the window ends (HTTP 429).
  - On top of that, sign-in is slowed down account-wide, whatever address the attempts come from. After 20 failed sign-ins within 15 minutes, attempts are spaced out: 0.25 s apart at first, doubling with each further failure, up to 10 s. When too many attempts are already waiting, the server answers 429 at once. Rotating addresses therefore cannot buy unlimited guesses, while you can still sign in from a new address (it may take a few seconds during an attack).
  - The counters live in memory and reset on restart. Behind a proxy, set `TRUST_PROXY` so that limits apply per real client rather than to the proxy.
- **Headers.**
  - Content-Security-Policy: `default-src 'self'`, with no external scripts, styles, fonts, images or connections, and `frame-ancestors 'none'`.
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, and same-origin COOP/CORP.
  - API responses are `Cache-Control: no-store`. HSTS is left to your proxy.
- **No third-party requests.**
  - The server makes no outbound calls, and the web app loads nothing from other origins.
  - Markdown never renders raw HTML. Links open in a new tab with `noopener noreferrer`. Remote images are shown as links instead of being loaded.
- **Unauthenticated endpoints** are limited to `GET /api/health` (returns `{ ok, version }`), `GET /api/auth/status` (whether setup is pending, plus the version), login, logout and setup. The static web app itself contains no data.
- **Request size limits:** 2 MiB for normal requests and 50 MiB for imports (configurable), and 64 KiB for the sign-in endpoints. Requests without the `X-Lyren-Request` header or without a session are refused before their body is read, so nobody can make the server buffer an upload without signing in first.

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
| `npm run typecheck` | `tsc` for the server and web projects (strict, `noUncheckedIndexedAccess`) |
| `npm test` | Vitest, once: shared logic, API tests against in-memory SQLite, and unit tests for web logic |
| `npm run test:watch` | Vitest in watch mode |
| `npm run check` | typecheck + test + build |
| `npm run package:win` | The single-file Windows app → `dist/lyren-plan-<version>-win-x64.exe` (see [Building the app](#building-the-app)) |
| `npm run package:linux` | The same single-file app for Linux x64 → `dist/lyren-plan-<version>-linux-x64` |

Run a single test file with `npx vitest run server/test/tasks.test.ts`. Run the server source directly with `npx tsx --tsconfig tsconfig.server.json server/src/index.ts [serve|backup|reset-password|help]`, and the Windows app's entry with `WEB_DIR=dist/web npx tsx --tsconfig tsconfig.server.json server/src/sea.ts --no-browser` (it uses the app's defaults: data in `~/.local/share/lyren-plan`, port 43770).

### Releases

The GitHub Actions workflow `.github/workflows/release.yml` builds the single-file apps and publishes them as a GitHub release. To make a release:

```sh
npm version 0.2.0 --no-git-tag-version   # sets the version in package.json and package-lock.json
git commit -am "Release 0.2.0"
git push
git tag v0.2.0                           # "v" + the version in package.json
git push origin v0.2.0
```

Pushing the tag starts the workflow, which has three jobs:

1. **Build and test** (Ubuntu 24.04). Stops at once if the tag is not `v` + the version in `package.json`. Then `npm ci`, `npm run check`, and the packaging of `lyren-plan-<version>-win-x64.exe` and `lyren-plan-<version>-linux-x64` with a `.sha256` file each, on the Node.js version in `.nvmrc`. That version must be one whose binaries are pinned in `scripts/lib/node-hashes.mjs` (the workflow sets `LYREN_NODE_PINNED_ONLY=1`, see [Building the app](#building-the-app); a test checks that `.nvmrc` is pinned). To move to a newer Node.js, change `.nvmrc` and add that version's hashes. After packaging the Windows app it also runs the one test in `scripts/test/manifest.test.mjs` that needs the official `node.exe`, which `npm run check` skips because only packaging downloads that file.
2. **Smoke test on Windows** (Windows Server 2025). `scripts/ci/smoke-windows.ps1` checks the exe against its `.sha256` file, runs `help`, starts the app with `--no-browser`, a new data folder and its own port, waits until `/api/health` answers, stops it with `stop` and checks that it has ended and its port is closed. It runs once in PowerShell 7 and once in Windows PowerShell 5.1.
3. **Publish the release.** Creates the release `Lyren Plan <version>` for the tag, marked as a pre-release when the version has a `-` (such as `0.2.0-beta.1`). It holds both binaries, their `.sha256` files and `SHA256SUMS` (both values; `sha256sum -c --ignore-missing SHA256SUMS` checks the files downloaded next to it). The notes begin with what to download, the SHA-256 values and a warning that the exe is not code-signed, followed by GitHub's generated list of changes since the previous release (`scripts/ci/publish-release.sh`).

- **A dry run first.** On GitHub, **Actions → Release → Run workflow** runs the build and the Windows smoke test on the branch you choose and publishes nothing. The run keeps the binaries (about 75 MB) for 3 days (under **Artifacts** on the run's page; in a private repository they count against the Actions storage of your plan), and its summary shows the release notes as they would be published.
- **The smoke test by hand**, on Windows, for example on a build of your own:
  ```bat
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\smoke-windows.ps1 -Exe dist\lyren-plan-0.1.0-win-x64.exe -WorkDir "%TEMP%\lyren-smoke-1" -Port 43871
  ```
  It needs all three options and refuses any other argument (put a path with spaces in double quotes), a `-WorkDir` that is not new or empty, and the ports 43770 to 43779 where a real Lyren Plan may run, so it never uses your own data or stops your own Lyren Plan. It leaves its files in `-WorkDir`: take a new folder for every run.
- **If a job fails**, fix the cause and use **Re-run failed jobs** on the run's page within 7 days (3 for a dry run), while the run's binaries are kept. Publishing never changes a release that is already published: a draft left by a cancelled run is deleted and the release created again; a published release with exactly these files counts as done; one with other files (for example after **Re-run all jobs**, which builds new binaries) stops the job with an error. To replace a published release, delete it on GitHub, keep the tag, and run the job again; or release a new version. If the repository has immutable releases turned on, only a new version works: GitHub never lets the tag of a deleted immutable release be used again. If the build itself was wrong, fix it and release a new version: a tag that has been published should not be moved.
- **Not signed.** The workflow does not sign the exe, so Windows may warn about it or block it (see [Getting it](#getting-it)). [Signing the app](#signing-the-app) describes how to sign a build yourself.
- **Permissions.** The workflow's token can only read the repository, except in the publishing job, which asks for write access (`contents: write`) to create the release. That works whatever **Settings → Actions → General → Workflow permissions** says, because that setting is only the default for workflows that don't ask. Should publishing still fail with "Resource not accessible by integration" (HTTP 403), select **Read and write permissions** there, and for a repository owned by an organisation check the organisation's Actions settings too.
- **Supply chain.** The workflow uses only GitHub's own actions (`checkout`, `setup-node`, `upload-artifact`, `download-artifact`), each pinned to the commit of a release (the version is in a comment next to it), and no caches. Text that others can choose, such as the tag name, reaches the scripts as environment variables only.

### Project layout

```
shared/src/            Shared contract: zod input schemas, DTO types, constants, date and duration helpers,
                       and the reference task filter/sort and board grouping logic used by server and web
server/src/
  index.ts             Entry point of the Node build and Docker; cli.ts has the commands (serve, backup,
                       reset-password, help); startupErrors.ts explains start-up failures
  sea.ts               Entry point of the single-file app (Node single executable application)
  desktop/             The single-file app: defaults, options, embedded web client, one server per data
                       folder and the stop command, port fallback, data folder permissions on Windows,
                       opening the browser, console banner; on Windows how it shows itself (mode.ts),
                       the notification-area icon (tray.ts, scripts.ts, powershell.ts), message boxes,
                       the log file and relaunches
  config.ts            Environment variables
  app.ts               Middleware (security headers, body limits, CSRF, sessions, auth) and route mounting
  auth/                Setup, login, sessions, scrypt passwords, rate limiting
  db/                  node:sqlite wrapper, schema and migrations, snapshot retention, first-run defaults and sample data
  http/                Error responses, request validation, static file server for the web app
  routes/              One Hono router per API area (projects, tasks, boards, timeline, data, ...)
  services/            Domain logic: task queries in SQL, ranks, activity, stats, task mutations
server/test/           API and service tests (vitest, in-memory SQLite)
web/
  index.html           App entry point
  public/              Service worker, web manifest, icons, theme bootstrap script
  vite.config.ts       Vite config (build to dist/web; dev proxy target from devProxy.ts)
  src/app/             Root component, router, auth gates, React Query client
  src/api/             Fetch client and every React Query hook: the web-to-API contract
  src/components/ui/   Design-system primitives: buttons, dialogs, sheets, menus, pickers, toasts
  src/components/layout/  App shell: sidebar, bottom bar, page headers
  src/components/domain/  Task cards and rows, status/priority/tag display, pickers, task actions menu
  src/features/        Pages by area: dashboard, projects, tasks, boards, timeline, search, settings, auth
  src/lib/             Theme, formatting, hooks, overlay stack, global events
scripts/               Dev runner, server bundler (esbuild), icon generator, package.mjs (the single-file app;
                       its helpers in scripts/lib, their tests in scripts/test); ci/ has the release
                       workflow's Windows smoke test and publishing script
.github/workflows/     release.yml: builds, tests and publishes releases (see Releases)
Dockerfile, docker-compose.yml
SPEC.md                Engineering spec: the binding contract for the codebase
```

### Architecture

- **One process.**
  - A [Hono](https://hono.dev) app on `@hono/node-server` serves the JSON API under `/api` and the built single-page app, with an SPA fallback.
  - Static files are gzip-compressed in memory, and hashed assets are cached as immutable.
- **Storage.**
  - SQLite via Node's built-in `node:sqlite`, in WAL mode with foreign keys on.
  - Migrations are tracked with `PRAGMA user_version`.
  - Every change runs in one transaction together with its activity entry.
  - Task order is a global fractional index, so reordering a task updates only that task.
- **Shared contract.**
  - `shared/src` holds the zod input schemas, used by the server for validation and by the web forms.
  - It also holds the reference filter, sort and board-grouping functions.
  - The server builds equivalent SQL, and a randomized test checks that SQL and JavaScript agree.
  - The web client uses the same functions to apply edits optimistically, so cards move the moment you drop them.
- **Web.**
  - React 19 with React Router 7 and TanStack Query 5, Tailwind CSS 4, and dnd-kit for drag and drop.
  - Projects, milestones, epics, statuses, tags, boards and settings arrive in one `/api/bootstrap` payload.
  - Routes and heavy dialogs are lazy-loaded.
- **Build.**
  - Vite builds the web app.
  - esbuild bundles the server and its npm dependencies into the single file `dist/server.mjs`, so production needs no `node_modules`.
  - `npm run package:win` turns the same server and `dist/web` into one executable: a Node.js single executable application whose web client is served from memory with the same caching rules as from disk.

### API

The web app uses only the JSON API, so you can script it too. The full endpoint list is in [SPEC.md §7](SPEC.md#7-api-reference), and the input and output types are in `shared/src/schemas.ts` and `shared/src/types.ts`. Sign in to get the session cookie, and send `X-Lyren-Request: 1` with every request that changes data:

```sh
curl -c jar -H 'Content-Type: application/json' -H 'X-Lyren-Request: 1' \
  -d '{"username":"owner","password":"..."}' http://localhost:8080/api/auth/login
curl -b jar -H 'Content-Type: application/json' -H 'X-Lyren-Request: 1' \
  -d '{"projectId":1,"title":"Write the README","priority":3,"dueDate":"2026-10-20"}' http://localhost:8080/api/tasks
curl -b jar -H 'Content-Type: application/json' -H 'X-Lyren-Request: 1' \
  -d '{"filter":{"due":["overdue"]},"sort":{"field":"dueDate","dir":"asc"}}' http://localhost:8080/api/tasks/query
```

Read [SPEC.md](SPEC.md) before changing code. It defines the domain rules, API, board semantics, web conventions and ownership.

---

## License

MIT, as declared in `package.json`.
