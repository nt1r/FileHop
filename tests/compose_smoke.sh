#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker cargo node curl mktemp timeout; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
root=$(mktemp -d -t filehop-compose-XXXXXXXX)
project="filehop-test-${root##*-}"
project=${project,,}
compose=(docker compose -p "$project" -f "$root/compose.yml")
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  if ! "${compose[@]}" down; then
    echo "Container cleanup failed; preserving $root for manual inspection" >&2
    return 1
  fi
  [[ "$root" == /tmp/filehop-compose-* ]] && rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 755 "$root"
mkdir "$root/database" "$root/files"
printf 'services:\n  backend:\n    image: filehop-issue6-backend\n    user: "%s:%s"\n    network_mode: none\n    volumes:\n      - "%s/database:/data/database"\n      - "%s/files:/data/files"\n' "$(id -u)" "$(id -g)" "$root" "$root" >"$root/compose.yml"
"${compose[@]}" up -d
"${compose[@]}" exec -T backend filehop --help
"${compose[@]}" up -d --force-recreate
[[ -z "$(find "$root/database" "$root/files" -mindepth 1 -print -quit)" ]]
export FILEHOP_FIXTURE_COMMAND=docker
FILEHOP_FIXTURE_ARGS=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' compose -p "$project" -f "$root/compose.yml" exec -it backend filehop init --username Admin --confirm-paths)
export FILEHOP_FIXTURE_ARGS
cargo test --manifest-path backend/Cargo.toml --locked --test initialization initialize_external_fixture -- --ignored --exact
"${compose[@]}" up -d --force-recreate
"${compose[@]}" stop
# Verify persisted data with the public HTTP interface after container recreation.
cargo build --manifest-path backend/Cargo.toml --locked
for iteration in 1 2; do
  backend/target/debug/backend --database-dir "$root/database" --files-dir "$root/files" serve --listen 127.0.0.1:0 >"$root/server.log" 2>"$root/server.err" &
  pid=$!
  timeout 15 bash -c 'until grep -q "^listening=" "$1"; do kill -0 "$2" || exit 1; sleep 0.05; done' _ "$root/server.log" "$pid"
  address=$(grep '^listening=' "$root/server.log"); address=${address#listening=}
  response=$(curl --fail --silent --show-error --max-time 5 "http://$address/api/status")
  [[ "$response" == '{"state":"initialized"}' ]]
  kill -TERM "$pid"; wait "$pid"; pid=
done
echo 'Compose initialization, recreation and backend restarts passed.'
