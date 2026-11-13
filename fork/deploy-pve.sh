#!/usr/bin/env bash
# Deploys this fork to the PVE container that runs RisuBard.
#
# The container is too small to build the app (2 cores / 1 GB RAM), so the
# frontend is built here and the container only builds a thin image on top of
# the upstream release image of the same tag:
#
#   FROM ghcr.io/rpaddict/risubard:<UPSTREAM_TAG>
#   + the files upstream's Dockerfile copies out of its builder stage
#     (dist, server, packages/risubard-core, src/ts/risubard, ...), from this checkout
#
# node_modules comes from the upstream image, so the fork must not change
# dependencies. The list of copied paths is read from upstream's Dockerfile on
# every run, so a release that adds a runtime path is picked up automatically.
#
# Steps: build -> ship -> build image -> stop -> back up save volume to this PC
#        -> start new image -> health check -> roll back on failure.
#
# Usage: fork/deploy-pve.sh [--skip-build]
# Env:   RISUBARD_SSH (default: Windows OpenSSH), RISUBARD_PVE_HOST (pve),
#        RISUBARD_CT (103), RISUBARD_BACKUP_DIR (/h/projects/risubard-backups),
#        RISUBARD_BACKUP_KEEP (7)
set -euo pipefail

SSH_BIN="${RISUBARD_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
PVE_HOST="${RISUBARD_PVE_HOST:-pve}"
CT_ID="${RISUBARD_CT:-103}"
BACKUP_DIR="${RISUBARD_BACKUP_DIR:-/h/projects/risubard-backups}"
BACKUP_KEEP="${RISUBARD_BACKUP_KEEP:-7}"
REMOTE_DIR=/opt/risubard
VOLUME_DIR=/var/lib/docker/volumes/risubard_risubard-save/_data
PNPM="npx --yes pnpm@10.34.1"

SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

info() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
ct() { "$SSH_BIN" -o BatchMode=yes "$PVE_HOST" "pct exec $CT_ID -- bash -s" ; }

cd "$(git rev-parse --show-toplevel)"

[ -z "$(git status --porcelain)" ] || fail "working tree is not clean; commit first"
BASE_TAG="$(tr -d '[:space:]' < fork/UPSTREAM_TAG)"
[ -n "$BASE_TAG" ] || fail "fork/UPSTREAM_TAG is empty"
SHA="$(git rev-parse --short=10 HEAD)"
IMAGE="risubard-fork:${BASE_TAG}-${SHA}"
info "base ghcr.io/rpaddict/risubard:${BASE_TAG}, image ${IMAGE}"

# Runtime paths upstream copies out of its builder stage.
mapfile -t RUNTIME_PATHS < <(sed -nE 's#^COPY --from=builder /app/([^ ]+) .*#\1#p' Dockerfile)
[ "${#RUNTIME_PATHS[@]}" -gt 0 ] || fail "could not read runtime paths from Dockerfile"
info "runtime paths: ${RUNTIME_PATHS[*]}"

if [ "$SKIP_BUILD" -eq 0 ]; then
    info "building frontend"
    NODE_OPTIONS=--max-old-space-size=8192 $PNPM build
fi
for p in "${RUNTIME_PATHS[@]}"; do [ -e "$p" ] || fail "missing $p (build first)"; done

OVERLAY="$(mktemp)"
trap 'rm -f "$OVERLAY"' EXIT
{
    echo "FROM ghcr.io/rpaddict/risubard:${BASE_TAG}"
    for p in "${RUNTIME_PATHS[@]}"; do echo "RUN rm -rf /app/${p}"; done
    for p in "${RUNTIME_PATHS[@]}"; do echo "COPY ${p} /app/${p}"; done
    echo "LABEL org.opencontainers.image.revision=${SHA} risubard.fork.base=${BASE_TAG}"
} > "$OVERLAY"
cp "$OVERLAY" ./.Dockerfile.overlay

info "shipping build context"
tar -czf - --exclude='*.test.ts' --exclude='node_modules' .Dockerfile.overlay "${RUNTIME_PATHS[@]}" \
    | "$SSH_BIN" -o BatchMode=yes "$PVE_HOST" \
      "pct exec $CT_ID -- bash -c 'rm -rf $REMOTE_DIR/build && mkdir -p $REMOTE_DIR/build && tar -xzf - -C $REMOTE_DIR/build'"
rm -f ./.Dockerfile.overlay

info "building image in CT ${CT_ID}"
ct <<EOF
set -euo pipefail
cd $REMOTE_DIR
docker image prune -f >/dev/null
avail_kb=\$(df --output=avail / | tail -1)
if [ "\$avail_kb" -lt 3000000 ]; then
    echo "[ct] low disk (\${avail_kb} KB), removing images not used by the running container"
    docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -v "^\$(docker inspect risubard --format '{{.Config.Image}}')\$" | xargs -r docker rmi >/dev/null 2>&1 || true
fi
docker pull -q ghcr.io/rpaddict/risubard:${BASE_TAG}
docker build -q -f build/.Dockerfile.overlay -t ${IMAGE} build
EOF

PREV_IMAGE="$(echo "docker inspect risubard --format '{{.Config.Image}}'" | ct)"
info "previous image ${PREV_IMAGE}"

info "stopping container for a consistent backup"
echo "cd $REMOTE_DIR && docker compose stop" | ct
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/save-$(date +%Y%m%d-%H%M%S)-before-${BASE_TAG}-${SHA}.tgz"
if ! "$SSH_BIN" -o BatchMode=yes "$PVE_HOST" "pct exec $CT_ID -- tar -C $VOLUME_DIR -czf - ." > "$BACKUP_FILE" \
    || ! gzip -t "$BACKUP_FILE"; then
    echo "cd $REMOTE_DIR && docker compose start" | ct
    fail "backup failed; old container restarted, nothing deployed"
fi
info "backup $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
ls -1t "$BACKUP_DIR"/save-*.tgz | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f

info "starting ${IMAGE}"
if ! ct <<EOF
set -euo pipefail
cd $REMOTE_DIR
cat > docker-compose.override.yml <<'YML'
services:
  risubard:
    image: \${RISUBARD_IMAGE:-ghcr.io/rpaddict/risubard:latest}
    # Loads nokeepalive.cjs before the server; see that file for the reason.
    environment:
      NODE_OPTIONS: --require /opt/preload/nokeepalive.cjs
    volumes:
      - ./nokeepalive.cjs:/opt/preload/nokeepalive.cjs:ro
YML
echo "RISUBARD_IMAGE=${IMAGE}" > .env
docker compose up -d --force-recreate >/dev/null
for i in \$(seq 1 45); do
    code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7777/ || true)
    state=\$(docker inspect risubard --format '{{.State.Status}} {{.RestartCount}}')
    if [ "\$code" = "200" ] && [ "\$state" = "running 0" ]; then echo "[ct] healthy after \$((i*2))s"; exit 0; fi
    sleep 2
done
echo "[ct] unhealthy: http=\$code state=\$state"; docker logs --tail 40 risubard; exit 1
EOF
then
    info "health check failed, rolling back to ${PREV_IMAGE}"
    ct <<EOF
cd $REMOTE_DIR
echo "RISUBARD_IMAGE=${PREV_IMAGE}" > .env
docker compose up -d --force-recreate
EOF
    fail "deploy of ${IMAGE} failed; rolled back to ${PREV_IMAGE} (backup: $BACKUP_FILE)"
fi

echo "cd $REMOTE_DIR && docker image prune -f >/dev/null; docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}'" | ct
info "deployed ${IMAGE}"
