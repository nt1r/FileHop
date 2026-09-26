#!/usr/bin/env bash
# Public CLI: ci-scope.sh EVENT BASE_REF [BASE_SHA HEAD_SHA]
# Emits only GitHub step outputs. A failed diff must fail the check, not skip it.
set -euo pipefail
for tool in git mktemp; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
application=true
containers=false
ingress=false
case "${1:?event required}" in
  workflow_dispatch) containers=true; ingress=true ;;
  push) ;;
  pull_request)
    case "${2:?base ref required}" in
      main) containers=true; ingress=true ;;
      dev)
        changes=$(mktemp -t filehop-ci-paths-XXXXXXXX)
        trap 'rm -f -- "$changes"' EXIT
        git diff --name-only --no-renames -z "${3:?base SHA required}...${4:?head SHA required}" > "$changes"
        application=false
        while IFS= read -r -d '' path; do
          # Explicit documentation allowlist only; unknown inputs run application checks.
          case "$path" in
            README.md|CONTEXT.md|CONTRIBUTING.md|AGENTS.md|LICENSE|docs/*.md|.github/pull_request_template.md) continue ;;
          esac
          application=true
          case "$path" in
            # These fixtures are independent of container and ingress smoke tests.
            tests/browser.sh|tests/browser.mjs|tests/text-cases.json|tests/dev_script.sh|.github/workflows/pr-policy.yml) ;;
            tests/caddy_ingress.sh|tests/caddy_ingress.mjs|deploy/caddy*|deploy/Caddyfile*|deploy/filehop-caddy.service) ingress=true ;;
            # Shared/unknown orchestration is deliberately conservative.
            scripts/*|.github/*|tests/*|.nvmrc|.env.example) containers=true; ingress=true ;;
            deploy/*|.dockerignore|rust-toolchain*|Cargo.toml|Cargo.lock|backend/Cargo.toml|backend/Cargo.lock|\
            .cargo/*|backend/.cargo/*|backend/build.rs|backend/migrations/*|backend/tests/initialization.rs|backend/tests/support/*|\
            package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|\
            web/package.json|web/pnpm-lock.yaml|web/pnpm-workspace.yaml|web/.npmrc|\
            web/.pnpmfile.*|web/patches/*|web/*config*|web/index.html) containers=true ;;
          esac
          # Compose/network changes can also affect the ingress contract.
          case "$path" in deploy/*) ingress=true ;; esac
        done < "$changes"
        # An empty diff is not evidence of a documentation-only PR.
        if [[ ! -s "$changes" ]]; then application=true; fi
        ;;
      *) echo 'Unsupported PR base' >&2; exit 1 ;;
    esac
    ;;
  *) echo 'Unsupported event' >&2; exit 1 ;;
esac
printf 'application=%s\ncontainers=%s\ningress=%s\n' "$application" "$containers" "$ingress"
