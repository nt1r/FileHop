#!/usr/bin/env bash
# CLI contract tests: fake Docker records invocations, never touches a daemon.
set -euo pipefail
for tool in mktemp realpath dirname mkdir cp grep chmod rm mv ln bash; do
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
export CALLS="$root/calls"
cat > "$root/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -eu
printf 'CALL\n' >> "$CALLS"
printf '<%s>\n' "$@" >> "$CALLS"
if [[ "${FAIL_CONFIG:-0}" == 1 && " $* " == *' config '* ]]; then exit 1; fi
if [[ "$1" == ps ]]; then
  [[ " $* " == *' --all '* ]] || exit 1
  if [[ "${EXISTING:-0}" == 1 ]]; then printf 'synthetic-container\n'; fi
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
  for action in status start stop; do
    : > "$CALLS"
    if run host "$action" > "$root/output" 2>&1; then echo "Ownership check accepted $fault/$action" >&2; exit 1; fi
    if grep -Eq '^<(up|stop)>$' "$CALLS"; then echo 'Rejected ownership reached lifecycle command' >&2; exit 1; fi
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
# Re-run in a non-default temporary root and require successful cleanup.
if [[ "${DEV_SCRIPT_TMP_CHILD:-0}" != 1 ]]; then
  mkdir "$root/custom-tmp"
  TMPDIR="$root/custom-tmp" DEV_SCRIPT_TMP_CHILD=1 bash "$repo/tests/dev_script.sh"
  shopt -s nullglob dotglob
  leftovers=("$root/custom-tmp"/*)
  [[ ${#leftovers[@]} == 0 ]] || { echo 'Temporary files leaked' >&2; exit 1; }
fi
echo 'Development manager CLI checks passed'
