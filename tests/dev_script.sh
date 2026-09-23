#!/usr/bin/env bash
# CLI contract tests: fake Docker records invocations, never touches a daemon.
set -euo pipefail
for tool in mktemp realpath dirname mkdir cp grep chmod rm mv ln bash; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
root=$(mktemp -d -t filehop-dev-script-XXXXXXXX)
cleanup() {
  [[ "$root" == /tmp/filehop-dev-script-* && -d "$root" && ! -L "$root" ]] || return 1
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
[[ $(grep -c '^CALL$' "$CALLS") == 1 ]]
grep -Fq "<$runtime/deploy/compose.host.yml>" "$CALLS"
: > "$CALLS"
run container start
[[ $(grep -c '^CALL$' "$CALLS") == 2 ]]
grep -Fxq '<--no-build>' "$CALLS"
grep -Fxq '<never>' "$CALLS"
! grep -Fq 'compose.host.yml' "$CALLS"
for action in status stop; do
  : > "$CALLS"
  run host "$action"
  [[ $(grep -c '^CALL$' "$CALLS") == 2 ]]
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
echo 'Development manager CLI checks passed'
