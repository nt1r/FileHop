#!/usr/bin/env bash
# Manage an existing fixed development deployment; never provision or update it.
set -euo pipefail
usage() {
  echo 'Usage: bash scripts/dev.sh <absolute-deployment-directory> <host|container> <check|status|start|stop>' >&2
  exit 2
}
[[ $# == 3 ]] || usage
root=$1
mode=$2
action=$3
[[ "$root" == /* ]] || usage
case "$mode" in host|container) ;; *) usage ;; esac
case "$action" in check|status|start|stop) ;; *) usage ;; esac
for tool in docker realpath dirname; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
fail() { echo "$1" >&2; exit 1; }
[[ -d "$root" ]] || fail 'Deployment directory is missing'
root=$(realpath -e -- "$root")
[[ "$root" != / ]] || fail 'Filesystem root is not a deployment directory'
# Linked worktrees have a .git file. Reject ancestor worktrees as well.
parent=$root
while [[ "$parent" != / ]]; do
  [[ ! -f "$parent/.git" ]] || fail 'Use a fixed deployment directory, not a linked worktree'
  parent=$(dirname -- "$parent")
done
require_path() {
  local relative=$1 kind=$2 resolved
  if [[ "$kind" == file ]]; then
    [[ -f "$root/$relative" && -r "$root/$relative" ]] || fail "Missing or unreadable file: $relative"
  else
    [[ -d "$root/$relative" ]] || fail "Missing directory: $relative"
  fi
  resolved=$(realpath -e -- "$root/$relative")
  [[ "$resolved" == "$root/"* ]] || fail "Path escapes deployment directory: $relative"
}
for path in .env deploy/compose.dev.yml web/index.html web/vite.config.ts web/src/main.tsx; do
  require_path "$path" file
done
for path in data-dev/database data-dev/files; do
  require_path "$path" directory
done
# Prevent a typo or symlink from mounting the same directory for both stores.
database=$(realpath -e -- "$root/data-dev/database")
files=$(realpath -e -- "$root/data-dev/files")
[[ "$database" != "$files" && "$database/" != "$files/"* && "$files/" != "$database/"* ]] || fail 'Database and file directories must be separate'
# Never inherit ambient Compose overrides that can redirect the target stack.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
compose=(docker compose --project-name filehop-dev --project-directory "$root/deploy" --env-file "$root/.env" -f "$root/deploy/compose.dev.yml")
if [[ "$mode" == host ]]; then
  require_path deploy/compose.host.yml file
  compose+=(-f "$root/deploy/compose.host.yml")
fi
"${compose[@]}" config --quiet
case "$action" in
  check) ;;
  status) "${compose[@]}" ps ;;
  start) "${compose[@]}" up -d --no-build --pull never ;;
  stop) "${compose[@]}" stop ;;
esac
