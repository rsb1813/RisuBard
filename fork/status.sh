#!/usr/bin/env bash
# Prints what the daily maintenance has to do for the release side:
#   LATEST    newest upstream release tag
#   MERGED    tag recorded in fork/UPSTREAM_TAG on the deploy branch
#   EXPECTED  image deploy-pve.sh would build from the deploy branch
#   DEPLOYED  image running in the container
#   ACTION    none | deploy | sync
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
SSH_BIN="${RISUBARD_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"

LATEST="$(gh release view -R rpaddict/RisuBard --json tagName -q .tagName)"
MERGED="$(git show deploy:fork/UPSTREAM_TAG | tr -d '[:space:]')"
EXPECTED="risubard-fork:${MERGED}-$(git rev-parse --short=10 deploy)"
DEPLOYED="$("$SSH_BIN" -o BatchMode=yes pve "pct exec ${RISUBARD_CT:-103} -- docker inspect risubard --format '{{.Config.Image}}'" 2>/dev/null || echo unknown)"

if [ "$LATEST" != "$MERGED" ]; then ACTION=sync
elif [ "$DEPLOYED" != "$EXPECTED" ]; then ACTION=deploy
else ACTION=none
fi

printf 'LATEST=%s\nMERGED=%s\nEXPECTED=%s\nDEPLOYED=%s\nACTION=%s\n' "$LATEST" "$MERGED" "$EXPECTED" "$DEPLOYED" "$ACTION"
