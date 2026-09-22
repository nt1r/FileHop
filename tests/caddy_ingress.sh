#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for tool in caddy node openssl mktemp; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }
done
root=$(mktemp -d -t filehop-ingress-XXXXXXXX)
cleanup() {
  [[ "$root" == /tmp/filehop-ingress-* && -d "$root" && ! -L "$root" ]] && rm -rf -- "$root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# 仅生成一次性测试证书；客户端显式信任它，不安装系统根证书或跳过 TLS 校验。
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$root/key.pem" -out "$root/cert.pem" >"$root/openssl.log" 2>&1
node tests/caddy_ingress.mjs "$root"
