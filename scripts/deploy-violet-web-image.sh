#!/usr/bin/env bash
# Deploy a prebuilt linux/arm64 Violet Web image without rebuilding or touching DB services.
set -Eeuo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

if (( $# > 1 )) || [[ ${1:-} == --help ]]; then
  echo 'Usage: bash scripts/deploy-violet-web-image.sh [ghcr.io/OWNER/IMAGE:TAG | --rollback]'
  exit 0
fi

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/violet-web-image"
mkdir -p "$state_dir"
exec 9>"$state_dir/lock"
flock -n 9 || { echo 'A web deployment is already running.' >&2; exit 1; }

case $(docker info --format '{{.Architecture}}') in
  aarch64|arm64) ;;
  *) echo 'Violet Web published images require an ARM64 Docker host.' >&2; exit 1 ;;
esac

compose_files=()
if [[ -n ${COMPOSE_FILE:-} ]]; then
  IFS="${COMPOSE_PATH_SEPARATOR:-:}" read -r -a configured_files <<< "$COMPOSE_FILE"
  for file in "${configured_files[@]}"; do
    [[ -f $file ]] || { echo "Missing Compose file: $file" >&2; exit 1; }
    compose_files+=(-f "$file")
  done
else
  compose_files=(-f docker-compose.yml)
  for file in docker-compose.override.yml docker-compose.override.yaml; do
    if [[ -f $file ]]; then compose_files+=(-f "$file"); break; fi
  done
fi
compose_files+=(-f docker-compose.image.yml)
compose() { docker compose "${compose_files[@]}" "$@"; }

rollback=false
requested=${1:-ghcr.io/pingpingjinping/violet-web:main-arm64}
if [[ $requested == --rollback ]]; then
  rollback=true
  [[ -s "$state_dir/previous" ]] || { echo 'No saved previous web image.' >&2; exit 1; }
  IFS= read -r requested < "$state_dir/previous"
fi
[[ $requested =~ ^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$ ]] || { echo 'Invalid image reference.' >&2; exit 1; }
export VIOLET_WEB_IMAGE=$requested
compose config --quiet
container=$(compose ps -q web)
[[ -n $container ]] || { echo 'Existing Violet Web container not found; refusing to create a new stack.' >&2; exit 1; }
old_image=$(docker inspect --format '{{.Image}}' "$container")

# Pull before touching the running app. A failed pull leaves the service unchanged.
if [[ $rollback == false ]]; then docker pull --platform linux/arm64 "$requested"; fi
architecture=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$requested")
[[ $architecture == linux/arm64 ]] || { echo "Unexpected image architecture: $architecture" >&2; exit 1; }
new_image=$(docker image inspect --format '{{.Id}}' "$requested")
if [[ $new_image == "$old_image" ]]; then
  echo "Already running: $requested ($new_image)"
  exit 0
fi

# Tag the last known working image before replacing only the web container.
previous="violet-web-rollback:${old_image#sha256:}"
docker tag "$old_image" "$previous"
printf '%s\n' "$previous" > "$state_dir/previous.tmp"
mv "$state_dir/previous.tmp" "$state_dir/previous"

export VIOLET_WEB_IMAGE=$new_image
if compose up -d --no-deps --no-build --pull never web; then
  for _ in $(seq 1 25); do
    if curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:3001/api/health; then
      printf '%s\n' "$new_image" > "$state_dir/current.tmp"
      mv "$state_dir/current.tmp" "$state_dir/current"
      echo "Healthy Violet Web: $requested ($new_image)"
      exit 0
    fi
    sleep 2
  done
  echo 'Violet Web health check did not succeed.' >&2
else
  echo 'New Violet Web container failed to start.' >&2
fi

# Restore the image the existing web container actually used before deployment.
echo 'Restoring previous Violet Web image...' >&2
export VIOLET_WEB_IMAGE=$old_image
if compose up -d --no-deps --no-build --pull never web; then
  echo 'Previous web image restored. Deployment failed.' >&2
else
  echo 'Rollback failed; check docker logs violet-web-1.' >&2
fi
exit 1
