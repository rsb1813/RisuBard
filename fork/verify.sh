#!/usr/bin/env bash
# Verification gate for the fork: install, client + server tests, build.
# Exit code 0 means it is safe to deploy.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PNPM="npx --yes pnpm@10.34.1"

# Node 25+ ships an experimental global localStorage that shadows happy-dom's
# and breaks ~190 client tests; upstream CI runs Node 24 where it is absent.
export NODE_OPTIONS=--no-experimental-webstorage

echo "[verify] install"
$PNPM install --frozen-lockfile
echo "[verify] fork tests"
$PNPM exec vitest run src/ts/fork
echo "[verify] client tests"
$PNPM exec vitest run --reporter=dot
echo "[verify] server tests"
$PNPM exec vitest run --config vitest.config.server.ts --reporter=dot
echo "[verify] build"
NODE_OPTIONS=--max-old-space-size=8192 $PNPM build
echo "[verify] OK"
