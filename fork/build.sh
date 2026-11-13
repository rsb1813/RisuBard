#!/usr/bin/env bash
# Builds everything the fork deploys: the upstream frontend (dist/) and the
# server-side BardWiki bundle (server/node/fork/dist/bardwiki-runner.cjs).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PNPM="npx --yes pnpm@10.34.1"
NODE_OPTIONS=--max-old-space-size=8192 $PNPM build
$PNPM exec vite build --config fork/vite.bardwiki-server.config.ts
# The bundle must load in plain Node, without browser globals.
(cd server/node/fork/dist && node -e "const m=require('./bardwiki-runner.cjs'); for (const k of ['createStoredResponseMemoryAnalysis','createServerModelRequester','serverModelTargetsSupported','setBardWikiNodeContext','selfFetch']) if (typeof m[k] !== 'function') { console.error('missing export ' + k); process.exit(1) }")
echo "[build] OK"
