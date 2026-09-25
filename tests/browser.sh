#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in cargo pnpm node mktemp; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
root=$(mktemp -d -t filehop-browser-XXXXXXXX)
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  [[ "$root" == /tmp/filehop-browser-* ]] && rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$root/database" "$root/files"
cargo build --manifest-path backend/Cargo.toml --locked
FILEHOP_MAX_FILE_BYTES=1024 backend/target/debug/backend --database-dir "$root/database" --files-dir "$root/files" serve --listen 127.0.0.1:0 >"$root/backend.log" 2>"$root/backend.err" &
pid=$!
export TEST_DATABASE="$root/database" TEST_FILES="$root/files" TEST_BACKEND_LOG="$root/backend.log"
node tests/browser.mjs
