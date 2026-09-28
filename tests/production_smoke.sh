#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in docker cargo pnpm node caddy openssl mktemp realpath timeout; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }
done
root=$(mktemp -d -t filehop-production-XXXXXXXX)
project="filehop-prod-test-${root##*-}"; project=${project,,}
network="$project-network"
artifact="$project-artifact"
prod=(docker compose --env-file "$root/production.env" --project-directory "$PWD" -p "$project" -f "$PWD/deploy/compose.production.yml")
dev=(docker compose --env-file "$root/dev.env" --project-directory "$PWD/deploy" -p "$project-dev" -f "$PWD/deploy/compose.dev.yml" -f "$root/dev.yml")
cleanup() {
  local failed=0
  docker rm -f "$artifact" >/dev/null 2>&1 || true
  if [[ -f "$root/production.env" ]]; then "${prod[@]}" down --timeout 5 >/dev/null || failed=1; fi
  if [[ -f "$root/dev.env" ]]; then "${dev[@]}" down --timeout 5 >/dev/null || failed=1; fi
  for net in "$network" "$network-dev"; do
    if docker network inspect "$net" >/dev/null 2>&1; then docker network rm "$net" >/dev/null || failed=1; fi
  done
  if (( failed )); then echo "Cleanup failed; preserving $root" >&2; return 1; fi
  # 只清理由 mktemp 创建且规范路径匹配的本次合成目录，不删除任何既有挂载。
  if [[ "$root" == /tmp/filehop-production-* && -d "$root" && ! -L "$root" && "$(realpath "$root")" == "$root" ]]; then
    docker run --rm --network none --user 0:0 --entrypoint sh \
      --mount "type=bind,src=$root,dst=/fixture" "${FILEHOP_BACKEND_IMAGE:-filehop-issue6-backend}" \
      -c 'chown -R "$1:$2" /fixture' sh "$(id -u)" "$(id -g)"
    rm -rf -- "$root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 755 "$root"
mkdir "$root/database" "$root/files" "$root/dev-database" "$root/dev-files" "$root/web"
# 真实镜像默认 UID/GID 10001，不能用测试用户覆盖身份来掩盖权限错误。
docker run --rm --network none --user 0:0 --entrypoint sh \
  --mount "type=bind,src=$root,dst=/fixture" "${FILEHOP_BACKEND_IMAGE:-filehop-issue6-backend}" \
  -c 'chown 10001:10001 /fixture/database /fixture/files /fixture/dev-database /fixture/dev-files; chmod 700 /fixture/database /fixture/files /fixture/dev-database /fixture/dev-files'
docker create --name "$artifact" "${FILEHOP_PROD_WEB_IMAGE:-filehop-production-web}" /unused >/dev/null
docker cp "$artifact:/web/." "$root/web"
docker rm "$artifact" >/dev/null
[[ -s "$root/web/index.html" ]]
! grep -Eq '/@vite/client|/src/main' "$root/web/index.html"
[[ -z "$(find "$root/web" -name '.env*' -o -name '*.db' -o -name '*.map')" ]]
for net in "$network" "$network-dev"; do docker network create --internal "$net" >/dev/null; done
proxy=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$network")
dev_proxy=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$network-dev")
# Node 选择回环随机 HTTPS 端口；配置和浏览器使用完全相同的 Origin。
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
cat >"$root/production.env" <<EOF
FILEHOP_PROD_PROJECT=$project
FILEHOP_PROD_BACKEND_IMAGE=${FILEHOP_BACKEND_IMAGE:-filehop-issue6-backend}
FILEHOP_PROD_ORIGIN=https://localhost:$port
FILEHOP_PROD_TRUSTED_PROXY=$proxy
FILEHOP_PROD_DATABASE_DIR=$root/database
FILEHOP_PROD_FILES_DIR=$root/files
FILEHOP_PROD_NETWORK=$network
EOF
cat >"$root/dev.env" <<EOF
FILEHOP_DEV_HOST=127.0.0.1:$port
FILEHOP_TRUSTED_PROXY=$dev_proxy
FILEHOP_DEV_NETWORK=$network-dev
EOF
cat >"$root/dev.yml" <<EOF
services:
  backend:
    image: ${FILEHOP_BACKEND_IMAGE:-filehop-issue6-backend}
    volumes:
      - type: bind
        source: $root/dev-database
        target: /data/database
        bind:
          create_host_path: false
      - type: bind
        source: $root/dev-files
        target: /data/files
        bind:
          create_host_path: false
EOF
"${prod[@]}" config --quiet
# 缺失挂载由 Compose 拒绝，不能自动补目录；已有空目录由生产启动拒绝。
if FILEHOP_PROD_FILES_DIR="$root/missing" "${prod[@]}" run --rm -T --no-deps backend >"$root/missing.log" 2>&1; then exit 1; fi
[[ ! -e "$root/missing" ]]
if timeout 15 "${prod[@]}" run --rm -T --no-deps backend >"$root/empty.log" 2>&1; then exit 1; fi
grep -q 'initialized storage required' "$root/empty.log"
initialize() {
  FILEHOP_FIXTURE_COMMAND=docker FILEHOP_FIXTURE_ARGS="$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${@:2}" run --rm -it --no-deps backend init --username "$1" --confirm-paths)" \
    cargo test --manifest-path backend/Cargo.toml --locked --test initialization initialize_external_fixture -- --ignored --exact
}
initialize Admin "${prod[@]:1}"
initialize Developer "${dev[@]:1}"
# 交叉挂错合法实例的文件目录，必须拒绝而不是覆盖身份或创建新库。
if timeout 15 env FILEHOP_PROD_FILES_DIR="$root/dev-files" "${prod[@]}" run --rm -T --no-deps backend >"$root/wrong.log" 2>&1; then exit 1; fi
grep -q 'initialized storage required' "$root/wrong.log"
"${prod[@]}" up -d --no-build
"${dev[@]}" up -d --no-build backend
prod_id=$("${prod[@]}" ps -q backend)
dev_id=$("${dev[@]}" ps -q backend)
for id in "$prod_id" "$dev_id"; do
  [[ "$(docker inspect -f '{{len .HostConfig.PortBindings}}' "$id")" == 0 ]]
  [[ "$(docker exec "$id" id -u)" == 10001 ]]
  [[ "$(docker exec "$id" stat -c '%u:%g:%a' /data/database)" == 10001:10001:700 ]]
  [[ "$(docker exec "$id" stat -c '%u:%g:%a' /data/files)" == 10001:10001:700 ]]
done
[[ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$prod_id")" == unless-stopped ]]
[[ "$(docker inspect -f '{{.HostConfig.LogConfig.Type}}/{{index .HostConfig.LogConfig.Config "max-size"}}/{{index .HostConfig.LogConfig.Config "max-file"}}' "$prod_id")" == json-file/10m/3 ]]
export FILEHOP_PROD_BACKEND_UPSTREAM="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$prod_id"):8080"
export FILEHOP_BACKEND_UPSTREAM="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$dev_id"):8080"
export FILEHOP_WEB_UPSTREAM="$FILEHOP_BACKEND_UPSTREAM"
export FILEHOP_PROD_WEB_ROOT="$root/web"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$root/key.pem" -out "$root/cert.pem" >"$root/openssl.log" 2>&1
export FILEHOP_TEST_CERT_SPKI
FILEHOP_TEST_CERT_SPKI=$(openssl x509 -in "$root/cert.pem" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64 -A)
export FILEHOP_TEST_PROD_COMPOSE
FILEHOP_TEST_PROD_COMPOSE=$(node -e 'console.log(JSON.stringify(process.argv.slice(1)))' "${prod[@]:1}")
node tests/production_ingress.mjs "$root" "$port"
"${prod[@]}" logs --no-color >"$root/backend.log"
grep -q 'storage_status="initialized"' "$root/backend.log"
! grep -Eq 'synthetic password|production synthetic message|__Host-filehop' "$root/backend.log"
echo 'Production artifact, identity, mount rejection, isolated HTTPS exchange and recreation passed.'
