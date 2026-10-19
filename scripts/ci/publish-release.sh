#!/usr/bin/env bash
# Publishes the GitHub Release of a version: the release job of .github/workflows/release.yml.
#
#   scripts/ci/publish-release.sh [--dry-run] <tag> <version> <folder>
#
# <folder> holds what the build job made: lyren-plan-<version>-win-x64.exe,
# lyren-plan-<version>-linux-x64 and lyren-plan-<version>-node.tar.gz (for Node.js installs, see
# docs/ubuntu-server.md), each with its .sha256 file. The script checks the three against their
# .sha256 files, writes SHA256SUMS (three lines, for `sha256sum -c`) and the header of the release
# notes, and creates the release "Lyren Plan <version>" for <tag> (a prerelease when the version has
# a "-") with the seven files, GitHub's generated notes following the header. It needs gh (GH_TOKEN
# with contents: write, GH_REPO=<owner>/<repo>), jq and sha256sum, as on GitHub's Ubuntu runners.
# --dry-run stops before anything is asked of GitHub and shows the notes in the job summary.
#
# Running it again for the same tag never changes a published release:
#   - No release for the tag: create it. gh uploads the files to a draft and publishes the draft
#     once all of them are there, so a published release always has every file.
#   - A draft for the tag that this workflow made (author github-actions[bot]), left by a run that
#     was cancelled or timed out during the upload: delete it, then create the release. A draft
#     made by anybody else: stop, and leave it alone.
#   - A published release with exactly these files (names and SHA-256): nothing to do. That is a
#     re-run of this job after a failure that came after publishing.
#   - A published release with other files: stop. Every build differs (the app records when it was
#     built), so this is a new build after the release was published, e.g. "Re-run all jobs". To
#     publish it anyway, delete the release on GitHub (not the tag) and run the job again; better,
#     release a new version. With immutable releases turned on for the repository, only a new
#     version works: GitHub never lets a deleted immutable release's tag be used again.

set -euo pipefail

fail() {
  echo "::error::$*"
  exit 1
}

dry_run=false
if [[ ${1:-} == --dry-run ]]; then
  dry_run=true
  shift
fi
if [[ $# -ne 3 ]]; then
  echo "Usage: $0 [--dry-run] <tag> <version> <folder>" >&2
  exit 2
fi
tag=$1
version=$2
dir=$3
root=$(cd "$(dirname "$0")/../.." && pwd)
node_version=$(tr -d '[:space:]' < "$root/.nvmrc")

[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || fail "Not a release version: $version"
[[ $tag == "v$version" ]] || fail "The tag $tag is not v$version"
prerelease=false
[[ $version != *-* ]] || prerelease=true
repo=${GH_REPO:-${GITHUB_REPOSITORY:-}}
if [[ -z $repo ]]; then
  $dry_run || fail 'GH_REPO is not set'
  repo=OWNER/REPO
fi
readme="${GITHUB_SERVER_URL:-https://github.com}/$repo/blob/$tag/README.md"
guide="${GITHUB_SERVER_URL:-https://github.com}/$repo/blob/$tag/docs/ubuntu-server.md"

cd "$dir"
win=lyren-plan-$version-win-x64.exe
linux=lyren-plan-$version-linux-x64
node=lyren-plan-$version-node.tar.gz
declare -A sum
for f in "$win" "$linux" "$node"; do
  [[ -f $f && -f $f.sha256 ]] || fail "$dir has no $f or no $f.sha256"
  read -r expected named < "$f.sha256" || true
  [[ $named == "$f" || $named == "*$f" ]] || fail "$f.sha256 is not for $f"
  sum[$f]=$(sha256sum "$f" | cut -d ' ' -f 1)
  [[ ${sum[$f]} == "$expected" ]] || fail "SHA-256 mismatch: $f.sha256 says $expected, the file has ${sum[$f]}"
  echo "OK $f ${sum[$f]}"
done
printf '%s  %s\n' "${sum[$win]}" "$win" "${sum[$linux]}" "$linux" "${sum[$node]}" "$node" > SHA256SUMS
assets=("$win" "$win.sha256" "$linux" "$linux.sha256" "$node" "$node.sha256" SHA256SUMS)

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
cat > "$notes" <<EOF
**Windows:** download \`$win\`. It is the whole app in one program: nothing to install, no Node.js needed. See [Windows app]($readme#windows-app) for starting, stopping and updating.

**Linux server with Node.js:** \`$node\` holds the server and the web app for Node.js 22.13 or newer, such as Ubuntu's own \`nodejs\` package: extract it and run \`node lyren-plan-$version/server.mjs\`, with no npm and no build. [Ubuntu Server]($guide) describes installing it as a systemd service.

**Linux (x64):** \`$linux\` is the same single-file app as on Windows, for Linux (\`chmod +x\` it after downloading). To run Lyren Plan with Docker instead, see the [README]($readme).

| File | SHA-256 |
|---|---|
| \`$win\` | \`${sum[$win]}\` |
| \`$node\` | \`${sum[$node]}\` |
| \`$linux\` | \`${sum[$linux]}\` |

Check a download before you use it: in PowerShell, \`Get-FileHash .\\$win\` must show the value above. On Linux, download the file's \`.sha256\` file next to it and run \`sha256sum -c\` on that, e.g. \`sha256sum -c $node.sha256\`. \`SHA256SUMS\` holds all three values: \`sha256sum -c --ignore-missing SHA256SUMS\` checks the files you downloaded.

The Windows exe is **not code-signed**. Microsoft Defender SmartScreen may show "Windows protected your PC": if you trust this download, choose **More info**, then **Run anyway**. Smart App Control (Windows 11) may block it without that choice. See [Getting it]($readme#getting-it).

The single-file apps contain Node.js $node_version.
EOF

if $dry_run; then
  {
    echo "## Release notes of $tag (dry run, nothing published)"
    echo
    echo "Title: Lyren Plan $version. Prerelease: $prerelease. Files: ${assets[*]}."
    echo
    cat "$notes"
    echo
    echo "_GitHub's generated notes (changes since the previous release) follow here._"
  } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
  exit 0
fi

# Every release of the repository whose tag is $tag (drafts included: the token can see them).
releases=$(gh api --paginate "repos/$repo/releases?per_page=100" | jq -s --arg tag "$tag" '[.[][] | select(.tag_name == $tag)]')

published=$(jq '[.[] | select(.draft | not)]' <<< "$releases")
count=$(jq length <<< "$published")
if [[ $count -gt 0 ]]; then
  ours=$(for f in "${assets[@]}"; do sha256sum "$f"; done)
  ours=$(awk '{ print $2 " sha256:" $1 }' <<< "$ours" | sort)
  theirs=$(jq -r '.[0].assets[] | "\(.name) \(.digest)"' <<< "$published")
  theirs=$(sort <<< "$theirs")
  if [[ $ours == "$theirs" ]]; then
    echo "The release $tag is already published with these files. Nothing to do."
    exit 0
  fi
  echo "Published files:"
  echo "$theirs"
  echo "Files of this run:"
  echo "$ours"
  fail "The release $tag is already published, with other files than this run built, and was left unchanged. To publish this build instead, delete the release on GitHub (not the tag) and run this job again (not possible with immutable releases, whose tags can't be used again), or release a new version."
fi

drafts=$(jq -r '.[] | select(.draft) | "\(.id) \(.author.login)"' <<< "$releases")
while read -r id author; do
  [[ -z $id || $author == "github-actions[bot]" ]] || fail "A draft release for $tag made by $author exists. Publish or delete it on GitHub, then run this job again."
done <<< "$drafts"
while read -r id author; do
  [[ -n $id ]] || continue
  echo "Deleting draft release $id, left by an earlier run"
  gh api --method DELETE "repos/$repo/releases/$id"
done <<< "$drafts"

args=(release create "$tag" --verify-tag --title "Lyren Plan $version" --notes-file "$notes" --generate-notes)
if $prerelease; then args+=(--prerelease); fi
gh "${args[@]}" "${assets[@]}"
