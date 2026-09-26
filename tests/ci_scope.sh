#!/usr/bin/env bash
# Exercise event + whole-PR diff -> scope through the public CLI in an isolated repo.
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
  [[ "$actual" == "$expected" ]] || { printf 'Scope mismatch for %s\nExpected:\n%s\nActual:\n%s\n' "$*" "$expected" "$actual" >&2; exit 1; }
}
check_path() {
  local path=$1
  shift
  git checkout -q --detach "$base"
  mkdir -p "$(dirname "$path")"
  printf 'synthetic\n' > "$path"
  git add -- "$path"
  git commit -qm fixture
  assert_scope "$@" pull_request dev "$base" HEAD
}
for path in README.md docs/testing.md docs/specs/004-web-production-deployment.md .github/pull_request_template.md; do
  check_path "$path" false false false
done
for path in backend/src/main.rs web/src/App.tsx tests/browser.sh tests/browser.mjs tests/text-cases.json tests/dev_script.sh .github/workflows/pr-policy.yml unknown.md; do
  check_path "$path" true false false
done
for path in deploy/caddy-dev.routes deploy/Caddyfile.host deploy/filehop-caddy.service tests/caddy_ingress.mjs; do
  check_path "$path" true false true
done
for path in backend/Cargo.lock backend/tests/initialization.rs backend/tests/support/mod.rs web/package.json web/vite.config.ts .dockerignore; do
  check_path "$path" true true false
done
for path in deploy/compose.host.yml scripts/ci-scope.sh .github/workflows/check.yml tests/persistence.mjs tests/compose_smoke.sh tests/new-fixture.mjs; do
  check_path "$path" true true true
done
# Multiple commits: a later docs change must not hide an earlier risky change.
printf 'docs\n' > README.md
git add README.md; git commit -qm docs
assert_scope true true true pull_request dev "$base" HEAD
# Rename away from a watched input and delete it: old paths still count.
check_path deploy/caddy-dev.routes true false true
before=$(git rev-parse HEAD)
git mv deploy/caddy-dev.routes README.md
git commit -qm rename
assert_scope true false true pull_request dev "$before" HEAD
git checkout -q --detach "$before"
git rm -q deploy/caddy-dev.routes; git commit -qm delete
assert_scope true false true pull_request dev "$before" HEAD
# Base-only changes are excluded by merge-base comparison.
git checkout -q --detach "$base"
printf 'docs\n' > README.md; git add README.md; git commit -qm head-docs
head=$(git rev-parse HEAD)
git checkout -q --detach "$base"
mkdir -p deploy; printf 'base-only\n' > deploy/compose.dev.yml
git add deploy; git commit -qm base-only
assert_scope false false false pull_request dev HEAD "$head"
assert_scope true false false pull_request dev "$base" "$base"
assert_scope true false false push ''
assert_scope true true true pull_request main
assert_scope true true true workflow_dispatch ''
if bash "$script" pull_request dev invalid HEAD >/dev/null 2>&1; then echo 'Invalid diff accepted' >&2; exit 1; fi
if bash "$script" unknown '' >/dev/null 2>&1; then echo 'Invalid event accepted' >&2; exit 1; fi
echo 'CI scope event, whole-PR diff, rename, deletion and fail-closed checks passed.'
