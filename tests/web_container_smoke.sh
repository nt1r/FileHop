#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker mktemp find timeout; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
root=$(mktemp -d -t filehop-context-test-XXXXXXXX)
name="filehop-web-test-${root##*-}"
cleanup() {
  docker logs "$name" 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  [[ "$root" == /tmp/filehop-context-test-* ]] && rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$root/web/nested"
for file in .env .env.local web/.env web/.env.local web/nested/.env.production; do
  printf 'SYNTHETIC_TEST_ONLY=not-a-secret\n' >"$root/$file"
done
printf 'included\n' >"$root/safe.txt"
cp .dockerignore "$root/.dockerignore"
printf 'FROM scratch\nCOPY . /context/\n' >"$root/Dockerfile"
docker build --output "type=local,dest=$root/output" "$root"
test -f "$root/output/context/safe.txt"
[[ -z "$(find "$root/output/context" -name '.env*' -print -quit)" ]] || { echo 'Environment file leaked into context' >&2; exit 1; }
args=(docker run -d --name "$name" --network none -e FILEHOP_DEV_HOST=transfer-dev.example.invalid)
for relative in src index.html vite.config.ts; do
  args+=(--mount "type=bind,src=$PWD/web/$relative,dst=/app/$relative,readonly")
done
"${args[@]}" "${FILEHOP_WEB_IMAGE:-filehop-issue6-web}"
[[ "$(docker exec "$name" id -u)" != 0 ]]
timeout 30 docker exec "$name" node --input-type=module -e '
const deadline = Date.now() + 20000;
let lastError;
while (Date.now() < deadline) {
  try {
    for (const path of ["/", "/src/main.tsx", "/src/App.tsx"]) {
      const response = await fetch("http://127.0.0.1:5173" + path, {signal: AbortSignal.timeout(2000)});
      if (!response.ok || !(await response.text()).length) throw new Error(path + ": " + response.status);
    }
    process.exit(0);
  } catch (error) { lastError = error; }
  await new Promise(resolve => setTimeout(resolve, 100));
}
throw lastError;
'
[[ "$(docker inspect -f '{{.State.Running}}' "$name")" == true ]]
[[ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$name")" == 0 ]]
echo 'Non-root Vite and recursive environment exclusions passed.'
