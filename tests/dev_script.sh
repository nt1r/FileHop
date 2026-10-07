#!/usr/bin/env bash
# CLI contract tests: fake Docker records invocations, never touches a daemon.
set -euo pipefail
for tool in mktemp realpath dirname mkdir cp grep chmod rm mv ln bash rsync diff cmp git flock jq; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
temporary_base=$(realpath -e -- "${TMPDIR:-/tmp}")
root=$(mktemp -d "$temporary_base/filehop-dev-script-XXXXXXXX")
cleanup() {
  [[ "$(dirname -- "$root")" == "$temporary_base" && "${root##*/}" == filehop-dev-script-* && -d "$root" && ! -L "$root" ]] || return 1
  rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
runtime="$root/fixed deployment"
mkdir -p "$runtime/deploy" "$runtime/web/src" "$runtime/data-dev/database" "$runtime/data-dev/files" "$root/bin"
cp "$repo/deploy/compose.dev.yml" "$repo/deploy/compose.host.yml" "$runtime/deploy/"
cp "$repo/.env.example" "$runtime/.env"
cp "$repo/web/index.html" "$repo/web/vite.config.ts" "$runtime/web/"
cp "$repo/web/src/main.tsx" "$runtime/web/src/"
# Matching fixed build inputs permit UI-only sync, not a backend/dependency upgrade.
mkdir -p "$runtime/backend"
cp -a "$repo/backend/src" "$repo/backend/migrations" "$runtime/backend/"
cp "$repo/backend/Cargo.toml" "$repo/backend/Cargo.lock" "$runtime/backend/"
cp "$repo/deploy/backend.Dockerfile" "$repo/deploy/web.Dockerfile" "$runtime/deploy/"
cp "$repo/web/package.json" "$repo/web/pnpm-lock.yaml" "$runtime/web/"
export CALLS="$root/calls"
cat > "$root/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -eu
printf 'CALL\n' >> "$CALLS"
printf '<%s>\n' "$@" >> "$CALLS"
if [[ "${FAIL_CONFIG:-0}" == 1 && " $* " == *' config '* ]]; then exit 1; fi
if [[ "$1" == build && "${FAIL_BUILD:-0}" == 1 ]]; then echo 'Synthetic build failure' >&2; exit 1; fi
if [[ "$1" == run && "${FAIL_MIGRATE:-0}" == 1 ]]; then echo 'Synthetic checksum mismatch' >&2; exit 1; fi
if [[ " $* " == *' config --format json '* ]]; then printf '{}\n'; fi
if [[ "$1" == ps ]]; then
  [[ " $* " == *' --all '* ]] || exit 1
  if [[ "${EXISTING:-0}" == 1 ]]; then printf 'synthetic-container\n'; fi
  if [[ "${FAIL_PS:-0}" == 1 ]]; then echo 'Synthetic enumeration failure' >&2; exit 42; fi
fi
if [[ "$1" == inspect ]]; then
  [[ "${FAIL_INSPECT:-0}" != 1 ]] || exit 1
  printf '%s\n' "$IDENTITY"
fi
STUB
chmod +x "$root/bin/docker"
export PATH="$root/bin:$PATH"
run() { bash "$repo/scripts/dev.sh" "$runtime" "$@"; }
reject() {
  : > "$CALLS"
  if run "$@" > "$root/output" 2>&1; then echo 'Expected rejection' >&2; exit 1; fi
  [[ ! -s "$CALLS" ]] || { echo 'Rejected input reached Docker' >&2; exit 1; }
}
: > "$CALLS"
run host check
grep -Fq "<$runtime/deploy/compose.host.yml>" "$CALLS"
: > "$CALLS"
run container start
grep -Fxq '<--no-build>' "$CALLS"
grep -Fxq '<never>' "$CALLS"
if grep -Fq 'compose.host.yml' "$CALLS"; then echo 'Container mode used host overlay' >&2; exit 1; fi
for action in status stop; do
  : > "$CALLS"
  run host "$action"
  if [[ "$action" == status ]]; then
    grep -Fxq '<ps>' "$CALLS"
  else
    grep -Fxq '<stop>' "$CALLS"
  fi
done
reject host init
reject unknown start
for path in .env web/src/main.tsx data-dev/database; do
  mv "$runtime/$path" "$root/saved"
  reject host start
  mv "$root/saved" "$runtime/$path"
done
printf 'gitdir: synthetic\n' > "$runtime/.git"
reject host start
rm "$runtime/.git"
printf 'gitdir: synthetic\n' > "$root/.git"
reject host start
rm "$root/.git"
mv "$runtime/data-dev/files" "$root/saved"
ln -s "$root/saved" "$runtime/data-dev/files"
reject host start
rm "$runtime/data-dev/files"
ln -s database "$runtime/data-dev/files"
reject host start
rm "$runtime/data-dev/files"
mv "$root/saved" "$runtime/data-dev/files"
: > "$CALLS"
if FAIL_CONFIG=1 run host start > "$root/output" 2>&1; then exit 1; fi
[[ $(grep -c '^CALL$' "$CALLS") == 1 ]]
# Existing project: foreign ownership must never reach a lifecycle command.
export EXISTING=1
export IDENTITY
valid_identity=$(printf '%s\n' "$runtime/deploy" "$runtime/deploy/compose.dev.yml,$runtime/deploy/compose.host.yml" backend "bind|$runtime/data-dev/database|/data/database|true" "bind|$runtime/data-dev/files|/data/files|true")
for fault in directory config mount missing service inspect; do
  IDENTITY=$valid_identity
  case "$fault" in
    directory) IDENTITY=${IDENTITY/"$runtime/deploy"/"$root/foreign/deploy"} ;;
    config) IDENTITY=${IDENTITY/compose.host.yml/other.yml} ;;
    mount) IDENTITY=${IDENTITY/"$runtime/data-dev/database"/"$root/foreign/database"} ;;
    missing) IDENTITY=$(printf '%s\n' "$runtime/deploy" "$runtime/deploy/compose.dev.yml,$runtime/deploy/compose.host.yml" backend) ;;
    service) IDENTITY=${IDENTITY/backend/unknown} ;;
    inspect) export FAIL_INSPECT=1 ;;
  esac
  for action in status start stop sync deploy; do
    : > "$CALLS"
    if run host "$action" > "$root/output" 2>&1; then echo "Ownership check accepted $fault/$action" >&2; exit 1; fi
    if grep -Eq '^<(up|restart|stop)>$' "$CALLS"; then echo 'Rejected ownership reached lifecycle command' >&2; exit 1; fi
  done
  unset FAIL_INSPECT
done
IDENTITY=$valid_identity
for action in status start stop; do run host "$action"; done
# Web mounts must match the same deployment, including read-only source binds.
IDENTITY=$(printf '%s\n' "$runtime/deploy" "$runtime/deploy/compose.dev.yml,$runtime/deploy/compose.host.yml" web "bind|$runtime/web/src|/app/src|false" "bind|$runtime/web/index.html|/app/index.html|false" "bind|$runtime/web/vite.config.ts|/app/vite.config.ts|false")
run host check
IDENTITY=${IDENTITY/false/true}
if run host start > "$root/output" 2>&1; then echo 'Writable source accepted' >&2; exit 1; fi
unset EXISTING IDENTITY
printf 'sentinel\n' > "$runtime/web/src/sentinel-not-in-repo.tsx"
run host check
[[ -f "$runtime/web/src/sentinel-not-in-repo.tsx" ]] || { echo 'check changed source' >&2; exit 1; }
rm "$runtime/web/src/sentinel-not-in-repo.tsx"
printf 'keep\n' > "$runtime/data-dev/database/marker"
env_before=$(cat "$runtime/.env")
IDENTITY=$(printf '%s\n' "$runtime/deploy" "$runtime/deploy/compose.dev.yml,$runtime/deploy/compose.host.yml" web "bind|$runtime/web/src|/app/src|false" "bind|$runtime/web/index.html|/app/index.html|false" "bind|$runtime/web/vite.config.ts|/app/vite.config.ts|false")
export EXISTING=1 IDENTITY
: > "$CALLS"
bash "$repo/scripts/dev.sh" sync
grep -Fxq '<restart>' "$CALLS"
grep -Fxq '<web>' "$CALLS"
[[ $(grep -Fxc '<ps>' "$CALLS") == 1 ]] || { echo 'Discovery repeated project enumeration' >&2; exit 1; }
cmp -s "$repo/web/src/main.tsx" "$runtime/web/src/main.tsx"
[[ $(cat "$runtime/data-dev/database/marker") == keep && $(cat "$runtime/.env") == "$env_before" ]] || { echo 'sync changed data or env' >&2; exit 1; }
# Default invocation deploys both sides even when the fixed backend is older.
printf '\nsynthetic older backend\n' >> "$runtime/backend/src/lib.rs"
printf 'stale web module\n' > "$runtime/web/src/default-deploy-sentinel"
: > "$CALLS"
if bash "$repo/scripts/dev.sh" sync > "$root/output" 2>&1; then echo 'UI-only sync accepted a different backend' >&2; exit 1; fi
[[ -f "$runtime/web/src/default-deploy-sentinel" ]] || exit 1
: > "$CALLS"
bash "$repo/scripts/dev.sh"
[[ $(grep -Fxc '<build>' "$CALLS") == 2 ]] || { echo 'Default deploy did not build both services' >&2; exit 1; }
grep -Fxq '<migrate>' "$CALLS"
grep -Fxq '<--network>' "$CALLS"
grep -Fxq '<none>' "$CALLS"
grep -Fxq '<--force-recreate>' "$CALLS"
cmp -s "$repo/backend/src/lib.rs" "$runtime/backend/src/lib.rs"
cmp -s "$repo/web/src/main.tsx" "$runtime/web/src/main.tsx"
[[ ! -f "$runtime/web/src/default-deploy-sentinel" ]] || { echo 'Default deploy kept stale source' >&2; exit 1; }
stop_line=$(grep -n '^<stop>$' "$CALLS" | cut -d: -f1)
migration_line=$(grep -n '^<migrate>$' "$CALLS" | cut -d: -f1)
up_line=$(grep -n '^<up>$' "$CALLS" | cut -d: -f1)
[[ "$stop_line" -lt "$migration_line" && "$migration_line" -lt "$up_line" ]] || { echo 'Unsafe deployment ordering' >&2; exit 1; }
[[ $(cat "$runtime/data-dev/database/marker") == keep && $(cat "$runtime/.env") == "$env_before" ]] || { echo 'Deploy changed persistent data or env' >&2; exit 1; }
# Build failure leaves running services/source untouched; migration failure
# leaves the old services stopped without installing mismatched Web source.
for failure in build migrate; do
  printf 'keep on failure\n' > "$runtime/web/src/failure-sentinel"
  : > "$CALLS"
  if [[ "$failure" == build ]]; then
    if FAIL_BUILD=1 bash "$repo/scripts/dev.sh" > "$root/output" 2>&1; then exit 1; fi
    if grep -Eq '^<(stop|run|up)>$' "$CALLS"; then echo 'Build failure reached stop/migration/start' >&2; exit 1; fi
  else
    if FAIL_MIGRATE=1 bash "$repo/scripts/dev.sh" > "$root/output" 2>&1; then exit 1; fi
    grep -Fq 'Synthetic checksum mismatch' "$root/output"
    grep -Fxq '<stop>' "$CALLS"
    if grep -Eq '^<(up|init)>$' "$CALLS"; then echo 'Migration failure started/initialized services' >&2; exit 1; fi
  fi
  [[ -f "$runtime/web/src/failure-sentinel" ]] || { echo 'Failed deploy installed frontend' >&2; exit 1; }
  rm "$runtime/web/src/failure-sentinel"
done
: > "$CALLS"
if bash "$repo/scripts/dev.sh" sync start > "$root/output" 2>&1; then echo 'duplicate action accepted' >&2; exit 1; fi
[[ ! -s "$CALLS" ]] || { echo 'Invalid arguments reached Docker' >&2; exit 1; }
unset EXISTING IDENTITY
: > "$CALLS"
if bash "$repo/scripts/dev.sh" > "$root/output" 2>&1; then echo 'missing project accepted' >&2; exit 1; fi
if grep -Eq '^<(up|restart|stop)>$' "$CALLS"; then echo 'Rejected discovery reached lifecycle command' >&2; exit 1; fi
# Enumeration failure (even after a partial result) must be fatal, not empty.
printf 'do not delete\n' > "$runtime/web/src/enumeration-sentinel"
for partial in 0 1; do
  for action in check start sync deploy; do
    : > "$CALLS"
    if EXISTING=$partial FAIL_PS=1 run host "$action" > "$root/output" 2>&1; then
      echo "Enumeration failure accepted: $partial/$action" >&2; exit 1
    fi
    grep -Fq 'Synthetic enumeration failure' "$root/output"
    if grep -Eq '^<(up|restart|stop|inspect)>$' "$CALLS"; then echo 'Failed enumeration reached ownership/lifecycle commands' >&2; exit 1; fi
  done
  : > "$CALLS"
  if EXISTING=$partial FAIL_PS=1 bash "$repo/scripts/dev.sh" > "$root/output" 2>&1; then echo 'Discovery failure accepted' >&2; exit 1; fi
  if grep -Eq '^<(up|restart|stop|inspect)>$' "$CALLS"; then echo 'Failed discovery reached ownership/lifecycle commands' >&2; exit 1; fi
done
[[ -f "$runtime/web/src/enumeration-sentinel" ]] || { echo 'Failed enumeration modified source' >&2; exit 1; }
rm "$runtime/web/src/enumeration-sentinel"
# Refused sync must not copy anything or execute lifecycle commands.
refuse_sync() {
  printf 'do not delete\n' > "$runtime/web/src/sync-sentinel"
  : > "$CALLS"
  if run host sync > "$root/output" 2>&1; then echo 'Unsafe sync accepted' >&2; exit 1; fi
  [[ -f "$runtime/web/src/sync-sentinel" ]] || { echo 'Refused sync modified source' >&2; exit 1; }
  if grep -Eq '^<(up|restart|stop)>$' "$CALLS"; then echo 'Refused sync reached lifecycle command' >&2; exit 1; fi
}
# A path inside the deployment is not necessarily safe: aliases and nesting.
for store in database files; do
  mv "$runtime/web/src" "$root/saved-source"
  cp "$repo/web/src/main.tsx" "$runtime/data-dev/$store/main.tsx"
  ln -s "../data-dev/$store" "$runtime/web/src"
  refuse_sync
  grep -Fq 'Unsafe web sync path' "$root/output"
  rm "$runtime/web/src" "$runtime/data-dev/$store/main.tsx" "$runtime/data-dev/$store/sync-sentinel"
  mv "$root/saved-source" "$runtime/web/src"
done
mv "$runtime/data-dev/files" "$root/saved-files"
mkdir "$runtime/web/src/nested-store"
ln -s ../web/src/nested-store "$runtime/data-dev/files"
refuse_sync
rm "$runtime/data-dev/files"
mv "$root/saved-files" "$runtime/data-dev/files"
rmdir "$runtime/web/src/nested-store"
# Single-file sync inputs must not alias persistent files either.
mv "$runtime/web/index.html" "$root/saved-index"
printf 'private synthetic content\n' > "$runtime/data-dev/database/synthetic-private-file"
ln -s ../data-dev/database/synthetic-private-file "$runtime/web/index.html"
refuse_sync
grep -Fxq 'private synthetic content' "$runtime/data-dev/database/synthetic-private-file"
rm "$runtime/web/index.html"
mv "$root/saved-index" "$runtime/web/index.html"
# Mixed backend versions, missing/extra build inputs and changed dependencies.
for path in backend/src/lib.rs backend/migrations/0001_next_release.sql backend/Cargo.lock deploy/backend.Dockerfile deploy/web.Dockerfile web/package.json web/pnpm-lock.yaml; do
  cp "$runtime/$path" "$root/saved-input"
  printf '\nsynthetic change\n' >> "$runtime/$path"
  refuse_sync
  grep -Fq 'Full development update required' "$root/output"
  mv "$root/saved-input" "$runtime/$path"
done
mv "$runtime/backend/src/lib.rs" "$root/saved-input"
refuse_sync
mv "$root/saved-input" "$runtime/backend/src/lib.rs"
printf 'stale backend module\n' > "$runtime/backend/src/stale.rs"
refuse_sync
rm "$runtime/backend/src/stale.rs"
# Partial parameter forms and read-only commands still work.
run status
run host status
run container check
run host sync
[[ ! -f "$runtime/web/src/sync-sentinel" ]] || { echo 'Successful mirror kept stale source' >&2; exit 1; }
[[ $(cat "$runtime/data-dev/database/marker") == keep && $(cat "$runtime/.env") == "$env_before" ]] || { echo 'sync changed data or env' >&2; exit 1; }
# Re-run in a non-default temporary root and require successful cleanup.
if [[ "${DEV_SCRIPT_TMP_CHILD:-0}" != 1 ]]; then
  mkdir "$root/custom-tmp"
  TMPDIR="$root/custom-tmp" DEV_SCRIPT_TMP_CHILD=1 bash "$repo/tests/dev_script.sh"
  shopt -s nullglob dotglob
  leftovers=("$root/custom-tmp"/*)
  [[ ${#leftovers[@]} == 0 ]] || { echo 'Temporary files leaked' >&2; exit 1; }
fi
echo 'Development manager CLI checks passed'
