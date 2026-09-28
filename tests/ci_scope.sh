#!/usr/bin/env bash
# Verify the public event/diff -> scope CLI using an isolated synthetic repository.
set -euo pipefail
for tool in git mktemp realpath; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
script=$(realpath "$(dirname "$0")/../scripts/ci-scope.sh")
root=$(mktemp -d -t filehop-ci-scope-XXXXXXXX)
cleanup() {
  [[ "$root" == /tmp/filehop-ci-scope-* && -d "$root" && ! -L "$root" && "$(realpath "$root")" == "$root" ]] && rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$root"
git init -q
git config user.name 'Synthetic CI test'
git config user.email 'ci@example.invalid'
git commit -qm base --allow-empty
base=$(git rev-parse HEAD)
assert_scope() {
  local expected actual
  expected=$(printf 'application=%s\ncontainers=%s\ningress=%s' "$1" "$2" "$3")
  shift 3
  actual=$(bash "$script" "$@")
  [[ "$actual" == "$expected" ]] || { printf 'Scope mismatch: %s\nExpected:\n%s\nActual:\n%s\n' "$*" "$expected" "$actual" >&2; exit 1; }
}
check_path() {
  local path=$1
  shift
  git checkout -q --detach "$base"
  mkdir -p "$(dirname "$path")"
  printf 'synthetic\n' > "$path"
  git add -- "$path"; git commit -qm fixture
  assert_scope "$@" pull_request dev "$base" HEAD
}
for path in README.md docs/testing.md docs/specs/004-web-production-deployment.md .github/pull_request_template.md; do
  check_path "$path" false false false
done
# No special build-input routing: release/manual runs exercise those environments.
for path in backend/src/main.rs web/src/App.tsx deploy/compose.dev.yml deploy/compose.production.yml web/tests/production.test.ts tests/production_smoke.sh scripts/ci-scope.sh .github/workflows/check.yml unknown.md; do
  check_path "$path" true false false
done
printf 'docs\n' > README.md; git add README.md; git commit -qm docs
assert_scope true false false pull_request dev "$base" HEAD
# Rename and deletion must not become a documentation-only exemption.
check_path deploy/caddy-dev.routes true false false
before=$(git rev-parse HEAD)
git mv deploy/caddy-dev.routes README.md; git commit -qm rename
assert_scope true false false pull_request dev "$before" HEAD
git checkout -q --detach "$before"
git rm -q deploy/caddy-dev.routes; git commit -qm delete
assert_scope true false false pull_request dev "$before" HEAD
# Exclude base-only changes via merge-base.
git checkout -q --detach "$base"
printf 'docs\n' > README.md; git add README.md; git commit -qm head-docs
head=$(git rev-parse HEAD)
git checkout -q --detach "$base"
mkdir -p deploy; printf 'base-only\n' > deploy/compose.dev.yml
git add deploy; git commit -qm base-only
assert_scope false false false pull_request dev HEAD "$head"
assert_scope true false false pull_request dev "$base" "$base"
assert_scope true true true pull_request main
assert_scope true true true workflow_dispatch ''
if bash "$script" pull_request dev invalid HEAD >/dev/null 2>&1; then echo 'Invalid diff accepted' >&2; exit 1; fi
for event in push unknown; do
  if bash "$script" "$event" '' >/dev/null 2>&1; then echo 'Unsupported event accepted' >&2; exit 1; fi
done
echo 'CI scope event, whole-PR diff, rename, deletion and fail-closed checks passed.'
