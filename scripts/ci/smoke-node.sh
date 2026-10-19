#!/usr/bin/env bash
# Smoke test of the release download for Node.js installs, lyren-plan-<version>-node.tar.gz: the
# smoke-node job of .github/workflows/release.yml, and by hand on Linux.
#
#   scripts/ci/smoke-node.sh [--node <node>] <archive> <work-dir> <port>
#
#   <archive>   dist/lyren-plan-<version>-node.tar.gz, with its .sha256 file next to it
#   <work-dir>  a new or empty folder; the script leaves its files there (take a new one every run)
#   <port>      a free port from 1024 up for the test server; not 8080 or 43770-43779, where a real
#               Lyren Plan may run, so the test never meets your own server
#   --node      the Node.js to test (default: node on PATH), e.g. /usr/bin/node for Ubuntu's nodejs
#
# Checks, in this order: the archive against its .sha256 file; every entry is below
# lyren-plan-<version>/ and owned by root (0/0), with server.mjs and web/index.html and no source
# maps; it extracts with `tar --no-same-owner` (as docs/ubuntu-server.md does); `help` names the
# version; the server, started with only PATH, DATA_DIR (in <work-dir>), HOST=127.0.0.1 and PORT from
# another working folder, answers /api/health with that version, serves the web app at / and its
# script, and logs a setup code; `backup` writes a backup set while it runs (`tar -tf` lists
# lyren-backup.json and directory.db); SIGTERM stops it with exit code 0, the port is closed and the
# WAL file is gone (the database was closed cleanly). `restore` then stages that backup set, and the
# next start applies it (the restore line in its log, the data it replaced in
# backups/before-restore-<stamp>/, no staging folder left).
#
# Then the upgrade check (docs/design/multi-user-and-cloudflare.md §9.9): the previous release's
# archive sets up an account (by username, as 1.x does), a project and a task in a new data folder and
# is stopped; this build must upgrade that 1.x database at its first start (the upgrade line in its
# log, spaces/<id>.db, the before-upgrade snapshot, a sign-in with the old username and password, the
# project and the task in the space), and the previous release must then refuse the upgraded data
# without changing it. The previous release is SMOKE_PREVIOUS_RELEASE (a lyren-plan-<v>-node.tar.gz on
# this machine, with or without its .sha256 file next to it), else downloaded with
# `gh release download` (GH_TOKEN and GH_REPO; the newest published release other than this version
# that has a Node.js archive, or SMOKE_PREVIOUS_TAG); without one, or without gh or a token, the check is
# skipped with a notice.
#
# A server is killed if anything fails. Needs bash, tar, sha256sum, curl, grep, sed and timeout
# (and gh for the download).

set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}
notice() {
  echo "::notice::$*"
}
usage() {
  echo "Usage: $0 [--node <node>] <archive> <work-dir> <port>" >&2
  exit 2
}

node=node
if [[ ${1:-} == --node ]]; then
  [[ $# -ge 2 ]] || usage
  node=$2
  shift 2
fi
[[ $# -eq 3 ]] || usage
archive=$1
work=$2
port=$3

name=$(basename "$archive")
[[ $name =~ ^lyren-plan-([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)-node\.tar\.gz$ ]] || fail "$name is not named lyren-plan-<version>-node.tar.gz"
version=${BASH_REMATCH[1]}
top=lyren-plan-$version
[[ -f $archive ]] || fail "No file $archive"
if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  fail "The port must be a number from 1024 to 65535 (got $port)"
fi
((port != 8080 && (port < 43770 || port > 43779))) || fail "Port $port is where a real Lyren Plan may run; choose another"
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
! port_open "$port" || fail "Port $port is already in use"
if [[ -e $work ]]; then
  [[ -d $work && -z $(ls -A "$work") ]] || fail "$work is not a new or empty folder"
fi
previous=${SMOKE_PREVIOUS_RELEASE:-}
if [[ -n $previous ]]; then
  [[ -f $previous && $(basename "$previous") =~ ^lyren-plan-.+-node\.tar\.gz$ ]] ||
    fail "SMOKE_PREVIOUS_RELEASE=$previous is not a lyren-plan-<version>-node.tar.gz file"
  previous=$(cd "$(dirname "$previous")" && pwd)/$(basename "$previous")
fi
node=$(command -v "$node") || fail "No Node.js at $node"
mkdir -p "$work"
work=$(cd "$work" && pwd)
archive=$(cd "$(dirname "$archive")" && pwd)/$name

echo "Smoke test of $name on Node.js $("$node" --version) ($node)"

# 1. The archive: checksum, then its entries.
(cd "$(dirname "$archive")" && sha256sum -c "$name.sha256") || fail "$name does not match $name.sha256"
listing=$(tar -tvzf "$archive" --numeric-owner) || fail "tar can't list $name"
names=$(tar -tzf "$archive")
bad_owner=$(awk '$2 != "0/0"' <<< "$listing")
[[ -z $bad_owner ]] || fail "Entries not owned by root (0/0):"$'\n'"$bad_owner"
outside=$(grep -v -E "^$top/" <<< "$names" || true)
[[ -z $outside ]] || fail "Entries outside $top/:"$'\n'"$outside"
dots=$(grep -E '(^|/)\.\.?(/|$)' <<< "$names" || true)
[[ -z $dots ]] || fail "Entries with . or .. in their path:"$'\n'"$dots"
maps=$(grep -E '\.map$' <<< "$names" || true)
[[ -z $maps ]] || fail "Source maps in the archive:"$'\n'"$maps"
for f in "$top/server.mjs" "$top/web/index.html"; do
  grep -qxF "$f" <<< "$names" || fail "The archive has no $f"
done
echo "OK archive: $(wc -l <<< "$names") entries below $top/, all 0/0, no source maps"

mkdir "$work/app" "$work/cwd"
tar -xzf "$archive" -C "$work/app" --no-same-owner || fail "tar can't extract $name"
app=$work/app/$top
data=$work/data
log=$work/server.log
base=http://127.0.0.1:$port

# Everything the app gets from the environment is set here; nothing comes from the caller's.
run_env=(env -i "PATH=/usr/bin:/bin" "DATA_DIR=$data" HOST=127.0.0.1 "PORT=$port")

# stderr apart: Node.js 22 prints an ExperimentalWarning for node:sqlite there.
help=$(cd "$work/cwd" && "${run_env[@]}" "$node" "$app/server.mjs" help 2> "$work/help.err") || fail "help failed: $(cat "$work/help.err")"
[[ $(head -n 1 <<< "$help") == "Lyren Plan $version" ]] || fail "help printed: $(head -n 1 <<< "$help")"
echo "OK help: Lyren Plan $version"

# The server that runs (pid) and its log, for the cleanup and the failure report.
pid=
current_log=
cleanup() {
  local rc=$?
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [[ $rc -ne 0 && -n $current_log && -f $current_log ]]; then
    echo "--- server log ($current_log) ---" >&2
    cat "$current_log" >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

# start_server <server.mjs> <log> <env...>: start it from another working folder, wait for /api/health.
start_server() {
  local server=$1
  current_log=$2
  shift 2
  (cd "$work/cwd" && exec "$@" "$node" "$server") > "$current_log" 2>&1 &
  pid=$!
  health=
  for _ in $(seq 1 150); do
    kill -0 "$pid" 2>/dev/null || fail "The server exited during start-up"
    if health=$(curl -fsS --max-time 2 "$base/api/health" 2>/dev/null); then return 0; fi
    sleep 0.2
  done
  fail "No answer from $base/api/health within 30 s"
}

# stop_server: SIGTERM, as systemctl stop sends; it must end within 15 s with exit code 0.
stop_server() {
  kill -TERM "$pid"
  for _ in $(seq 1 75); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  ! kill -0 "$pid" 2>/dev/null || fail "The server is still running 15 s after SIGTERM"
  local rc=0
  wait "$pid" || rc=$?
  pid=
  [[ $rc -eq 0 ]] || fail "The server ended with exit code $rc after SIGTERM"
  grep -qF 'Received SIGTERM, shutting down...' "$current_log" || fail "The log does not show the shutdown"
  ! port_open "$port" || fail "Port $port is still open after the server ended"
}

# api <method> <path> <cookie jar> [<json body>]: the body of a 2xx answer, else fail.
api() {
  local method=$1 path=$2 jar=$3 body=${4:-}
  local args=(-sS --max-time 10 -X "$method" -b "$jar" -c "$jar" -H 'X-Lyren-Request: 1' -o "$work/answer" -w '%{http_code}')
  [[ -z $body ]] || args+=(-H 'Content-Type: application/json' --data "$body")
  local status
  status=$(curl "${args[@]}" "$base$path") || fail "$method $path: no answer"
  [[ $status == 2?? ]] || fail "$method $path answered $status: $(cat "$work/answer")"
  cat "$work/answer"
}

# 2. The server.
start_server "$app/server.mjs" "$log" "${run_env[@]}"
[[ $health == *'"ok":true'* && $health == *"\"version\":\"$version\""* ]] || fail "/api/health answered $health"
echo "OK /api/health: $health"

headers=$(curl -fsS --max-time 5 -D - -o "$work/index.html" "$base/") || fail "GET / failed"
grep -qiE '^content-type: text/html' <<< "$headers" || fail "/ is not text/html:"$'\n'"$headers"
grep -qF '<title>Lyren Plan</title>' "$work/index.html" || fail "/ is not the Lyren Plan web app"
script=$(grep -oE 'src="/assets/[^"]+\.js"' "$work/index.html" | head -n 1 | cut -d '"' -f 2)
[[ -n $script ]] || fail "index.html names no /assets/*.js script"
type=$(curl -fsS --max-time 5 -o /dev/null -w '%{content_type}' "$base$script") || fail "GET $script failed"
[[ $type == *javascript* ]] || fail "$script is served as $type"
echo "OK /: the web app, and $script ($type)"

grep -qE '^  Setup code: [0-9a-f]{12}$' "$log" || fail "The log shows no setup code"
echo "OK first run: the log shows the setup code"

backup_out=$(cd "$work/cwd" && "${run_env[@]}" "$node" "$app/server.mjs" backup "$work/backup.tar" 2>&1) || fail "backup failed: $backup_out"
[[ -s $work/backup.tar ]] || fail "backup wrote no file: $backup_out"
entries=$(tar -tf "$work/backup.tar") || fail "tar can't list backup.tar"
for f in lyren-backup.json directory.db; do
  grep -qxF "$f" <<< "$entries" || fail "backup.tar has no $f:"$'\n'"$entries"
done
echo "OK backup while running: $(grep -F 'Backup written' <<< "$backup_out"), tar -tf lists $(tr '\n' ' ' <<< "$entries")"

# 3. Stop with SIGTERM, as systemctl stop does.
stop_server
[[ ! -e $data/lyren.db-wal ]] || fail "lyren.db-wal is left: the database was not closed cleanly"
echo "OK SIGTERM: exit code 0, port closed, database closed"

# 4. The restore (design §9.6): staged while the server is stopped, applied by the next start, whose
# exclusive lock on lyren.db proves that nothing else has it open (§3.8: the same lock as the upgrade's).
staged=$(cd "$work/cwd" && "${run_env[@]}" "$node" "$app/server.mjs" restore "$work/backup.tar" 2> "$work/restore.err") ||
  fail "restore failed: $(cat "$work/restore.err")"
grep -qF 'Staged the restore of the backup set made ' <<< "$staged" || fail "restore printed: $staged"
[[ -f $data/.restore-pending/READY ]] || fail "restore staged nothing in $data/.restore-pending"
start_server "$app/server.mjs" "$work/restore.log" "${run_env[@]}"
restored=$(grep -F 'Restored the backup set made ' "$work/restore.log") || fail "The log shows no restore line"
[[ $restored == *' The data it replaced was moved to backups/before-restore-'*'/.' ]] || fail "The restore line names no before-restore folder: $restored"
[[ ! -e $data/.restore-pending ]] || fail "$data/.restore-pending is left after the restore"
compgen -G "$data/backups/before-restore-*/lyren.db" > /dev/null || fail "No lyren.db in $data/backups/before-restore-*/"
stop_server
echo "OK restore: $(head -n 1 <<< "$staged") The next start: $restored"

# 5. The upgrade check.
if [[ -z $previous ]]; then
  if [[ -z ${GH_TOKEN:-} ]] || ! command -v gh > /dev/null; then
    notice "Upgrade check skipped: no previous release (SMOKE_PREVIOUS_RELEASE is unset, and gh or GH_TOKEN is missing)"
  else
    tag=${SMOKE_PREVIOUS_TAG:-}
    if [[ -z $tag ]]; then
      tags=$(gh release list --exclude-drafts --exclude-pre-releases --limit 50 --json tagName \
        --jq ".[].tagName | select(. != \"v$version\")") || fail "gh release list failed"
      # The newest one that has a Node.js archive (the earliest releases have none).
      while IFS= read -r candidate; do
        [[ -n $candidate ]] || continue
        assets=$(gh release view "$candidate" --json assets --jq '.assets[].name') || fail "gh release view $candidate failed"
        if grep -qE '^lyren-plan-.+-node\.tar\.gz$' <<< "$assets"; then
          tag=$candidate
          break
        fi
      done <<< "$tags"
    fi
    if [[ -z $tag ]]; then
      notice "Upgrade check skipped: no published release before v$version has a lyren-plan-<version>-node.tar.gz"
    else
      mkdir "$work/previous"
      gh release download "$tag" --dir "$work/previous" --pattern 'lyren-plan-*-node.tar.gz' --pattern 'lyren-plan-*-node.tar.gz.sha256' ||
        fail "gh release download $tag failed"
      previous=$(find "$work/previous" -maxdepth 1 -name 'lyren-plan-*-node.tar.gz' | head -n 1)
      [[ -n $previous ]] || fail "The release $tag has no lyren-plan-<version>-node.tar.gz"
      (cd "$work/previous" && sha256sum -c "$(basename "$previous").sha256") || fail "$(basename "$previous") of $tag does not match its .sha256 file"
      echo "OK downloaded $(basename "$previous") of the release $tag"
    fi
  fi
fi
if [[ -z $previous ]]; then
  echo "Smoke test passed: Lyren Plan $version on Node.js $("$node" --version) (without the upgrade check)"
  exit 0
fi

if [[ -f $previous.sha256 && ! -d $work/previous ]]; then
  (cd "$(dirname "$previous")" && sha256sum -c "$(basename "$previous").sha256") || fail "$previous does not match its .sha256 file"
fi
mkdir -p "$work/previous/app"
tar -xzf "$previous" -C "$work/previous/app" --no-same-owner || fail "tar can't extract $previous"
prev_server=$(find "$work/previous/app" -mindepth 2 -maxdepth 2 -name server.mjs | head -n 1)
[[ -n $prev_server ]] || fail "$(basename "$previous") holds no <folder>/server.mjs"
prev_version=$(cd "$work/cwd" && env -i PATH=/usr/bin:/bin "$node" "$prev_server" help 2> /dev/null | head -n 1) || fail "help of the previous release failed"
echo "Upgrade check from $prev_version ($(basename "$previous"))"
updata=$work/upgrade-data
user=smoke-owner
password='smoke password 1'
prev_env=(env -i "PATH=/usr/bin:/bin" "DATA_DIR=$updata" HOST=127.0.0.1 "PORT=$port" SETUP_TOKEN=smoke-setup-code)
start_server "$prev_server" "$work/previous.log" "${prev_env[@]}"
jar=$work/previous.cookies
setup_status=$(curl -sS --max-time 10 -b "$jar" -c "$jar" -H 'X-Lyren-Request: 1' -H 'Content-Type: application/json' -o "$work/answer" -w '%{http_code}' \
  --data "{\"username\":\"$user\",\"displayName\":\"Smoke Owner\",\"password\":\"$password\",\"setupCode\":\"smoke-setup-code\",\"createSampleData\":false}" \
  "$base/api/auth/setup") || fail "POST /api/auth/setup: no answer"
if [[ $setup_status == 400 ]] && grep -q email "$work/answer"; then
  stop_server
  notice "Upgrade check skipped: $prev_version is already a release with spaces (its setup asks for an email address), so there is no 1.x database to upgrade"
  echo "Smoke test passed: Lyren Plan $version on Node.js $("$node" --version) (without the upgrade check)"
  exit 0
fi
[[ $setup_status == 201 ]] || fail "POST /api/auth/setup of $prev_version answered $setup_status: $(cat "$work/answer")"
project=$(api POST /api/projects "$jar" '{"name":"Upgrade check","key":"UPG"}')
project_id=$(grep -oE '"id":[0-9]+' <<< "$project" | head -n 1 | cut -d : -f 2)
[[ -n $project_id ]] || fail "POST /api/projects answered $project"
api POST /api/tasks "$jar" "{\"projectId\":$project_id,\"title\":\"Carried over\"}" > /dev/null
stop_server
[[ -f $updata/lyren.db && ! -e $updata/spaces ]] || fail "$prev_version did not leave a 1.x database (lyren.db alone) in $updata"
echo "OK $prev_version: an account ($user), the project UPG and the task UPG-1 in a 1.x database"

start_server "$app/server.mjs" "$work/upgrade.log" env -i "PATH=/usr/bin:/bin" "DATA_DIR=$updata" HOST=127.0.0.1 "PORT=$port"
line=$(grep -F 'Upgraded the database for multi-user spaces: your data is now in the space "Smoke Owner'"'"'s space" (spaces/' "$work/upgrade.log") ||
  fail "The log shows no upgrade line"
space=$(sed -E 's/.*\(spaces\/([0-9a-z]{16})\.db\)\..*/\1/' <<< "$line")
[[ $space =~ ^[0-9a-z]{16}$ ]] || fail "No space id in the upgrade line: $line"
[[ $line == *' The old database was saved as backups/lyren-v1-before-upgrade-'*'.db.' ]] || fail "The upgrade line names no snapshot: $line"
[[ -f $updata/spaces/$space.db ]] || fail "No $updata/spaces/$space.db"
compgen -G "$updata/backups/lyren-v1-before-upgrade-*.db" > /dev/null || fail "No before-upgrade snapshot in $updata/backups"
echo "OK upgrade: $line"
jar=$work/upgraded.cookies
api POST /api/auth/login "$jar" "{\"identifier\":\"$user\",\"password\":\"$password\"}" > /dev/null
projects=$(api GET "/api/s/$space/projects" "$jar")
[[ $projects == *'"key":"UPG"'* ]] || fail "The space has no project UPG: $projects"
task=$(api GET "/api/s/$space/tasks/ref/UPG-1" "$jar")
[[ $task == *'"title":"Carried over"'* ]] || fail "UPG-1 is not the task of $prev_version: $task"
stop_server
echo "OK sign-in with the old username and password; the project UPG and the task UPG-1 are in the space"

before=$(cd "$updata" && sha256sum lyren.db "spaces/$space.db")
set +e
refused=$(cd "$work/cwd" && timeout 30 "${prev_env[@]}" "$node" "$prev_server" 2>&1)
rc=$?
set -e
[[ $rc -ne 0 && $rc -ne 124 ]] || fail "$prev_version did not refuse the upgraded data (exit code $rc):"$'\n'"$refused"
grep -qF 'is newer than this build supports' <<< "$refused" || fail "$prev_version refused the upgraded data with another message:"$'\n'"$refused"
! port_open "$port" || fail "Port $port is open after $prev_version refused the data"
[[ $(cd "$updata" && sha256sum lyren.db "spaces/$space.db") == "$before" ]] || fail "$prev_version changed the upgraded data"
echo "OK $prev_version refuses the upgraded data (exit code $rc, files unchanged): $(grep -F 'is newer than this build supports' <<< "$refused" | head -n 1)"

echo "Smoke test passed: Lyren Plan $version on Node.js $("$node" --version), with the upgrade from $prev_version"
