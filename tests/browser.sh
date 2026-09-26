#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in cargo pnpm node mktemp; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
# 每个浏览器文件使用独立实例，避免分页样本与其他流程共同触发每小时上传准入上限。
# 可传入单个 spec 路径复验；默认遍历现有 spec，不改变各测试的真实后端边界。
specs=("$@")
if (( ${#specs[@]} == 0 )); then specs=(web/tests/*.spec.ts); fi
cargo build --manifest-path backend/Cargo.toml --locked
for spec in "${specs[@]}"; do (
  [[ -f "$spec" && "$spec" == web/tests/*.spec.ts ]] || { echo "Expected web/tests/<name>.spec.ts" >&2; exit 1; }
  export TEST_SPEC="$(basename "$spec")"
  root=$(mktemp -d -t filehop-browser-XXXXXXXX)
  pid=
  cleanup() {
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
    [[ "$root" == /tmp/filehop-browser-* && -d "$root" && ! -L "$root" ]] && rm -rf -- "$root"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir "$root/database" "$root/files"
  FILEHOP_MAX_FILE_BYTES=1024 backend/target/debug/backend --database-dir "$root/database" --files-dir "$root/files" serve --listen 127.0.0.1:0 >"$root/backend.log" 2>"$root/backend.err" &
  pid=$!
  export TEST_DATABASE="$root/database" TEST_FILES="$root/files" TEST_BACKEND_LOG="$root/backend.log"
  node tests/browser.mjs
); done
