#!/usr/bin/env bash
# Public CLI: ci-scope.sh EVENT BASE_REF [BASE_SHA HEAD_SHA]
# Daily PR checks; environment/resource checks only for release PRs or manual runs.
set -euo pipefail
for tool in git mktemp; do command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }; done
application=true
containers=false
ingress=false
case "${1:?event required}" in
  workflow_dispatch) containers=true; ingress=true ;;
  pull_request)
    case "${2:?base ref required}" in
      main) containers=true; ingress=true ;;
      dev)
        changes=$(mktemp -t filehop-ci-paths-XXXXXXXX)
        trap 'rm -f -- "$changes"' EXIT
        git diff --name-only --no-renames -z "${3:?base SHA required}...${4:?head SHA required}" > "$changes"
        application=false
        while IFS= read -r -d '' path; do
          case "$path" in
            README.md|CONTEXT.md|CONTRIBUTING.md|AGENTS.md|LICENSE|docs/*.md|.github/pull_request_template.md) ;;
            *) application=true ;;
          esac
        done < "$changes"
        if [[ ! -s "$changes" ]]; then application=true; fi
        ;;
      *) echo 'Unsupported PR base' >&2; exit 1 ;;
    esac
    ;;
  *) echo 'Unsupported event' >&2; exit 1 ;;
esac
printf 'application=%s\ncontainers=%s\ningress=%s\n' "$application" "$containers" "$ingress"
