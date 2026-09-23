#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker cargo node mktemp timeout realpath; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
root=$(mktemp -d -t filehop-compose-XXXXXXXX)
project="filehop-test-${root##*-}"
project=${project,,}
compose=(docker compose -p "$project" -f "$root/compose.yml")
probe="${project}-probe"
cleanup() {
  if docker container inspect "$probe" >/dev/null 2>&1; then
    docker rm -f "$probe" >/dev/null || return 1
  fi
  if ! "${compose[@]}" down; then
    echo "Container cleanup failed; preserving $root for manual inspection" >&2
    return 1
  fi
  [[ "$root" == /tmp/filehop-compose-* && -d "$root" && ! -L "$root" && "$(realpath -- "$root")" == "$root" ]] && rm -rf -- "$root"
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
# 使用已有 Web 镜像中的 Node 探测实际后端容器；应用镜像不增加测试工具。
mkdir "$root/fixture"
probe_http() {
  local container
  container=$("${compose[@]}" ps -q backend)
  [[ -n "$container" ]]
  [[ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$container")" == 0 ]]
  timeout 45 docker run --rm --name "$probe" --user "$(id -u):$(id -g)" \
    --network "container:$container" \
    --mount "type=bind,src=$PWD/tests/persistence.mjs,dst=/persistence.mjs,readonly" \
    --mount "type=bind,src=$root/fixture,dst=/fixture" \
    --entrypoint node "${FILEHOP_WEB_IMAGE:-filehop-issue6-web}" /persistence.mjs "$1"
}
probe_http seed
"${compose[@]}" restart backend
probe_http verify
"${compose[@]}" kill -s SIGKILL backend
"${compose[@]}" up -d
probe_http verify
"${compose[@]}" up -d --force-recreate
probe_http verify
echo 'Compose initialization, graceful restart, SIGKILL and recreation persistence passed.'
