#!/usr/bin/env bash
# Deploy the current working branch to the existing fixed development stack.
# Preserve local configuration and persistent data; never initialize or reset it.
set -euo pipefail
usage() {
  echo 'Usage: bash scripts/dev.sh [deployment-directory] [host|container] [deploy|sync|check|status|start|stop]' >&2
  echo 'Omitted directory and mode come from the existing filehop-dev project. Omitted action is deploy (build and update both services).' >&2
  exit 2
}
root=''
mode=''
action=''
for argument in "$@"; do
  case "$argument" in
    host|container)
      [[ -z "$mode" ]] || usage
      mode=$argument ;;
    deploy|sync|check|status|start|stop)
      [[ -z "$action" ]] || usage
      action=$argument ;;
    /*)
      [[ -z "$root" ]] || usage
      root=$argument ;;
    *) usage ;;
  esac
done
action=${action:-deploy}
for tool in realpath dirname; do
  command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
fail() { echo "$1" >&2; exit 1; }
inspect_format='{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{println}}{{index .Config.Labels "com.docker.compose.project.config_files"}}{{println}}{{index .Config.Labels "com.docker.compose.service"}}{{println}}{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}'
containers=''
first_container=''
discovered_project=0
discover_project() {
  [[ "$discovered_project" == 0 ]] || return 0
  discovered_project=1
  command -v docker >/dev/null || fail 'Missing tool: docker'
  # Capture status directly: process substitution would hide docker failures.
  containers=$(docker ps --all --quiet --filter label=com.docker.compose.project=filehop-dev) || fail 'Unable to enumerate the development project'
  while IFS= read -r container; do
    [[ -n "$container" ]] || continue
    first_container=$container
    break
  done <<< "$containers"
}
if [[ -z "$root" ]]; then
  discover_project
  [[ -n "$first_container" ]] || fail 'Pass the deployment directory; no existing filehop-dev project was found'
  discovered=$(docker inspect --format "$inspect_format" "$first_container")
  discovered=${discovered%%$'\n'*}
  [[ "$discovered" == /* ]] || fail 'Existing project has no deployment directory'
  root=$(dirname -- "$discovered")
fi
[[ -d "$root" ]] || fail 'Deployment directory is missing'
root=$(realpath -e -- "$root")
[[ "$root" != / ]] || fail 'Filesystem root is not a deployment directory'
# Linked worktrees have a .git file. Reject ancestor worktrees as well.
parent=$root
while [[ "$parent" != / ]]; do
  [[ ! -f "$parent/.git" ]] || fail 'Use a fixed deployment directory, not a linked worktree'
  parent=$(dirname -- "$parent")
done
if [[ -z "$mode" ]]; then
  discover_project
  if [[ -n "$first_container" ]]; then
    discovered=$(docker inspect --format "$inspect_format" "$first_container")
    discovered=${discovered#*$'\n'}
    discovered=${discovered%%$'\n'*}
    [[ "$discovered" == *compose.host.yml ]] && mode=host || mode=container
  elif [[ -f "$root/deploy/compose.host.yml" ]]; then
    mode=host
  else
    mode=container
  fi
fi
require_path() {
  local relative=$1 kind=$2 resolved
  if [[ "$kind" == file ]]; then
    [[ -f "$root/$relative" && -r "$root/$relative" ]] || fail "Missing or unreadable file: $relative"
  else
    [[ -d "$root/$relative" ]] || fail "Missing directory: $relative"
  fi
  resolved=$(realpath -e -- "$root/$relative")
  [[ "$resolved" == "$root/"* ]] || fail "Path escapes deployment directory: $relative"
}
for path in .env deploy/compose.dev.yml web/index.html web/vite.config.ts web/src/main.tsx; do
  require_path "$path" file
done
for path in data-dev/database data-dev/files; do
  require_path "$path" directory
done
# Prevent a typo or symlink from mounting the same directory for both stores.
database=$(realpath -e -- "$root/data-dev/database")
files=$(realpath -e -- "$root/data-dev/files")
[[ "$database" != "$files" && "$database/" != "$files/"* && "$files/" != "$database/"* ]] || fail 'Database and file directories must be separate'
# Never inherit ambient Compose overrides that can redirect the target stack.
unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
compose=(docker compose --project-name filehop-dev --project-directory "$root/deploy" --env-file "$root/.env" -f "$root/deploy/compose.dev.yml")
if [[ "$mode" == host ]]; then
  require_path deploy/compose.host.yml file
  compose+=(-f "$root/deploy/compose.host.yml")
fi
"${compose[@]}" config --quiet
# Compose selects by project name, not directory. Include stopped containers;
# ownership mismatches require an explicit migration, never an implicit up.
expected_configs="$root/deploy/compose.dev.yml"
[[ "$mode" != host ]] || expected_configs+=",$root/deploy/compose.host.yml"
discover_project
while IFS= read -r container; do
  [[ -n "$container" ]] || continue
  identity=$(docker inspect --format "$inspect_format" "$container")
  mapfile -t fields <<< "$identity"
  [[ "${fields[0]:-}" == "$root/deploy" && "${fields[1]:-}" == "$expected_configs" ]] || fail 'Existing project belongs to a different deployment directory or entry mode; explicit migration required'
  case "${fields[2]:-}" in
    backend) expected_mounts=("bind|$database|/data/database|true" "bind|$files|/data/files|true") ;;
    web) expected_mounts=("bind|$(realpath -e -- "$root/web/src")|/app/src|false" "bind|$(realpath -e -- "$root/web/index.html")|/app/index.html|false" "bind|$(realpath -e -- "$root/web/vite.config.ts")|/app/vite.config.ts|false") ;;
    *) fail 'Existing project contains an unexpected service' ;;
  esac
  actual_mounts=()
  for field in "${fields[@]:3}"; do
    [[ -z "$field" ]] || actual_mounts+=("$field")
  done
  [[ ${#actual_mounts[@]} == ${#expected_mounts[@]} ]] || fail 'Existing project mount set differs from the target deployment'
  for expected in "${expected_mounts[@]}"; do
    found=false
    for actual in "${actual_mounts[@]}"; do
      [[ "$actual" != "$expected" ]] || found=true
    done
    "$found" || fail 'Existing project mount differs from the target deployment'
  done
done <<< "$containers"
validate_write_path() {
  local relative=$1 target protected
  target=$(realpath -m -- "$root/$relative")
  [[ "$target" == "$root/$relative" ]] || fail "Unsafe deployment write path: $relative is a symbolic alias"
  for protected in "$database" "$files" "$(realpath -e -- "$root/.env")"; do
    [[ "$target" != "$protected" && "$target/" != "$protected/"* && "$protected/" != "$target/"* ]] || fail "Unsafe deployment write path: $relative overlaps persistent data or env"
  done
}
case "$action" in
  check) ;;
  status) "${compose[@]}" ps ;;
  start) "${compose[@]}" up -d --no-build --pull never ;;
  stop) "${compose[@]}" stop ;;
  deploy)
    for tool in git rsync mktemp flock jq cmp; do
      command -v "$tool" >/dev/null || fail "Missing tool: $tool"
    done
    repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
    [[ "$repo" != "$root" ]] || fail 'Run deploy from the source repository, not the fixed deployment snapshot'
    for relative in backend backend/src backend/migrations backend/Cargo.toml backend/Cargo.lock web web/src web/index.html web/vite.config.ts web/package.json web/pnpm-lock.yaml deploy deploy/backend.Dockerfile deploy/web.Dockerfile LICENSE .dockerignore .dev-deploy.lock; do
      validate_write_path "$relative"
    done
    # Keep the established network, mounts and entrypoint configuration unchanged.
    for relative in deploy/compose.dev.yml; do
      cmp -s "$repo/$relative" "$root/$relative" || fail 'Deployment Compose configuration differs; review the configuration change explicitly first'
    done
    [[ "$mode" != host ]] || cmp -s "$repo/deploy/compose.host.yml" "$root/deploy/compose.host.yml" || fail 'Host Compose configuration differs; review it explicitly first'
    exec 9> "$root/.dev-deploy.lock"
    flock -n 9 || fail 'Another development deployment is in progress'
    stage=$(mktemp -d)
    cleanup_stage() { [[ -n "${stage:-}" && -d "$stage" ]] && rm -rf -- "$stage"; }
    trap cleanup_stage EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # Snapshot the current branch INCLUDING local edits and non-ignored new files.
    # Never copy ignored data/dependencies or .env files into the build context.
    git -C "$repo" ls-files -z --cached --others --exclude-standard -- backend web deploy LICENSE .dockerignore > "$stage/paths.all"
    while IFS= read -r -d '' path; do
      case "$path" in
        .env*|*/.env*|*/node_modules/*|*/target/*|*/dist/*) continue ;;
      esac
      [[ -e "$repo/$path" || -L "$repo/$path" ]] || continue
      printf '%s\0' "$path"
    done < "$stage/paths.all" > "$stage/paths"
    rsync -a --from0 --files-from="$stage/paths" "$repo/" "$stage/source/"
    for relative in backend/src/main.rs backend/Cargo.toml backend/Cargo.lock web/src/main.tsx web/package.json web/pnpm-lock.yaml deploy/backend.Dockerfile deploy/web.Dockerfile LICENSE .dockerignore; do
      [[ -f "$stage/source/$relative" && ! -L "$stage/source/$relative" ]] || fail "Missing or aliased build input: $relative"
    done
    configuration=$("${compose[@]}" config --format json)
    backend_image=$(jq -er '.services.backend.image // "filehop-dev-backend"' <<< "$configuration")
    web_image=$(jq -er '.services.web.image // "filehop-dev-web"' <<< "$configuration")
    echo 'Building the current branch backend and frontend…'
    docker build -f "$stage/source/deploy/backend.Dockerfile" -t "$backend_image" "$stage/source"
    docker build -f "$stage/source/deploy/web.Dockerfile" -t "$web_image" "$stage/source"
    echo 'Stopping the old development services before migration…'
    "${compose[@]}" stop
    if ! docker run --rm --network none --mount "type=bind,src=$database,dst=/data/database" --mount "type=bind,src=$files,dst=/data/files" "$backend_image" migrate; then
      fail 'Development migration failed. Services remain stopped; data is preserved. Inspect the migration error; do not initialize, erase data, or start the old backend automatically.'
    fi
    # Mirror only application inputs, never the complete deployment directory.
    for relative in backend web; do
      mkdir -p "$root/$relative"
      rsync -a --delete --exclude='target/' --exclude='node_modules/' --exclude='dist/' --exclude='.env*' "$stage/source/$relative/" "$root/$relative/"
    done
    rsync -a "$stage/source/deploy/backend.Dockerfile" "$stage/source/deploy/web.Dockerfile" "$root/deploy/"
    rsync -a "$stage/source/LICENSE" "$stage/source/.dockerignore" "$root/"
    "${compose[@]}" up -d --no-build --pull never --force-recreate
    # Probe through the web container's Node runtime; no public ports or secrets.
    ready=0
    for ((attempt=0; attempt<30; attempt++)); do
      if "${compose[@]}" exec -T web node -e 'Promise.all([fetch("http://backend:8080/internal/ready",{signal:AbortSignal.timeout(2000)}).then(async r=>{const v=await r.json();if(!r.ok||!v.database_available||!v.uploads_ready)throw Error("backend not ready")}),fetch("http://localhost:5173/src/App.tsx",{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)throw Error("frontend not ready")})]).catch(()=>process.exit(1))'; then
        ready=1
        break
      fi
      sleep 1
    done
    [[ "$ready" == 1 ]] || fail 'Development startup checks failed. Keep the data and inspect container logs; deployment was not reported successful.'
    echo 'Deployed current working branch backend and frontend; internal startup checks passed.'
    ;;
  sync)
    for tool in rsync diff; do
      command -v "$tool" >/dev/null || fail "Missing tool: $tool"
    done
    repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
    [[ "$repo" != "$root" ]] || fail 'Refusing to sync a deployment directory onto itself'
    [[ -f "$repo/web/src/main.tsx" && -f "$repo/web/index.html" && -f "$repo/web/vite.config.ts" ]] || fail 'Source web files are missing'
    # Writes must use real Web paths, not aliases, and must be disjoint from
    # persistent directories (in either direction) and the local env file.
    for relative in web web/src web/index.html web/vite.config.ts; do
      target=$(realpath -e -- "$root/$relative")
      [[ "$target" == "$root/$relative" ]] || fail "Unsafe web sync path: $relative is a symbolic alias"
      for protected in "$database" "$files" "$(realpath -e -- "$root/.env")"; do
        [[ "$target" != "$protected" && "$target/" != "$protected/"* && "$protected/" != "$target/"* ]] || fail "Unsafe web sync path: $relative overlaps persistent data or env"
      done
    done
    # A lightweight UI sync keeps the installed images. Refuse known changes
    # to their build inputs rather than silently mixing application versions.
    full_update_required() {
      echo "Full development update required: $1" >&2
      echo 'sync only updates Web source; use ./scripts/dev.sh (or deploy) to build and deploy both services.' >&2
      echo 'To start the existing version without syncing, run: bash scripts/dev.sh start' >&2
      exit 1
    }
    for relative in backend/src backend/migrations backend/Cargo.toml backend/Cargo.lock deploy/backend.Dockerfile deploy/web.Dockerfile web/package.json web/pnpm-lock.yaml; do
      [[ -e "$repo/$relative" && -e "$root/$relative" ]] || full_update_required "missing build input $relative"
      diff -qr -- "$repo/$relative" "$root/$relative" >/dev/null || full_update_required "build input differs: $relative"
    done
    # Only the bind-mounted web inputs. Never mirror env, data, or dependencies.
    rsync -a "$repo/web/index.html" "$repo/web/vite.config.ts" "$root/web/"
    rsync -a --delete "$repo/web/src/" "$root/web/src/"
    "${compose[@]}" up -d --no-build --pull never
    "${compose[@]}" restart web
    echo 'Synced web source and restarted the development frontend.'
    ;;
esac
