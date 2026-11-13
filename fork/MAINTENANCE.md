# Fork maintenance (rsb1813/RisuBard)

This fork tracks `rpaddict/RisuBard` releases and carries a small patch on top.
A daily 09:00 Claude Code scheduled task on the maintainer's PC follows this
file. It does two jobs:

1. **Model registry refresh.** This runs every day.
2. **Release sync.** This runs only when upstream publishes a new release: merge it, fix what the merge breaks, verify, push and deploy.

## Layout

| Thing | Where |
|---|---|
| Fork checkout | `H:\projects\RisuBard`. The `origin` remote is rsb1813/RisuBard and `upstream` is rpaddict/RisuBard. |
| Deploy branch | `deploy`. It is an upstream release tag plus the fork patch, and it is what runs on the server. |
| Fork `main` | A plain mirror of upstream `main`. Never commit fork changes to it. |
| Last merged release | `fork/UPSTREAM_TAG` |
| Registry checkout | `H:\projects\risubard-model-registry`. The `origin` remote is rsb1813/pocketrisu-model-registry and `upstream` is PocketRisu/pocketrisu-model-registry. |
| Server | PVE host `pve` (ssh alias), container 103, app at `/opt/risubard`, port 7777 |
| Save backups | `H:\projects\risubard-backups`. The newest 7 are kept. |

## The fork patch (keep it this small)

| File | What it does |
|---|---|
| `src/ts/fork/serverEgress.ts` (+ test) | Wraps `window.fetch`. Every cross-origin HTTP(S) request goes through the server's `/proxy2`, so the browser never contacts AI providers or other external APIs. It also rewrites the official model registry URL (PocketRisu `main`) to the fork registry. |
| `src/main.ts` | One added line: `import "./ts/fork/serverEgress";` directly after the polyfill import. |
| `fork/*` | This tooling. |

What the patch does and does not do:

- **Done:** the browser never contacts an external host with `fetch()`; everything goes through the server.
- **Done upstream:** model-preset requests (chat, BardWiki and memory model calls among them) already run as server jobs, because `nodeOnlyServerSideRequests` defaults to on. Those jobs survive a dropped connection.
- **Not done: server-driven BardWiki.** The analysis is still started and orchestrated by the browser tab (`src/ts/risubard/memoryAnalysisClient.ts`); only its model calls go through the server. If the tab is closed between steps, the remaining steps do not run.
- **Not covered by the wrapper:**
  - WebSocket (Ooba streaming)
  - XMLHttpRequest
  - fetches inside Web Workers
  - tool-use and preview requests, which use the `/proxy2` relay, not durable jobs
- **Behaviour change:** a `localhost` backend URL now resolves on the server, not on the viewing device.
- **Firewall limit:** PVE firewall rules for CT 103 drop outbound traffic to private addresses (`OUT DROP +private`), so LAN backends are not reachable from the server.

Rules for changes:

- **Do not change dependencies.** `node_modules` in production comes from the upstream image of the same tag.
- Prefer new files under `src/ts/fork/` plus one-line hooks over edits inside upstream files.
- Do not change upstream tests to make the patch pass.

## Job 1: model registry refresh (daily)

Work in `H:\projects\risubard-model-registry`. Follow its `MAINTENANCE.md` (the schema v4 layout and Tier 0 sources), with these fork rules:

1. Run `git fetch upstream`, then merge `upstream/main` into `main`. If `index.json` or `catalog.json` conflict, take either side and regenerate them in step 4; never hand-merge them.
   - **Collision rule:** upstream sometimes adds a model that we added earlier. That shows up as an add/add conflict on the same file, or as two profiles with the same `modelId` under one base. In either case keep upstream's file and remove ours. This is the only case where you delete a profile.
2. Run `node H:\projects\RisuBard\fork\registry-candidates.mjs H:\projects\risubard-model-registry --days 60`. It lists OpenRouter models from tracked vendors that have no `openrouter` profile.
3. For each real new model (skip legal, regional and duplicate snapshot variants unless clearly useful), **add** a profile:
   - Copy the closest sibling profile in `profiles/openrouter/` (same vendor and family). Then set `id`, `displayName`, `displayNameI18n.ko`, `description`, `descriptionI18n.ko`, `modelId`, `sortOrder`, `capabilities`, `limits`, `recommendedTokenizer`, `profileStatus: "current"`, and `updatedAt` (the current time in ms).
   - Take capabilities and limits from OpenRouter `/api/v1/models`, using the mapping table in the registry's MAINTENANCE.md.
   - For major-vendor models (Anthropic, OpenAI, Google), also add the vendor-direct profile (`profiles/anthropic`, `profiles/openai`, `profiles/google`) by copying the newest sibling of the same family. Confirm the exact model ID on the vendor's docs or models page. If you cannot confirm it, skip the direct profile and note it in the report.
   - Never edit or delete existing profiles unattended. Report suspected stale ones instead.
4. Run `node scripts/build.mjs`, then `node scripts/validate.mjs`. Validation must pass.
5. Commit the sources together with `index.json` and `catalog.json`, using a message like `feat: add <models>`, then push `origin main`.
6. If nothing is new, commit nothing.

## Job 2: release sync (only when a new release exists)

Work in `H:\projects\RisuBard`.

1. Run `git fetch upstream --tags` and `git fetch origin`.
2. Run `bash fork/status.sh` and act on its `ACTION=` line:
   - `none`: nothing to do.
   - `deploy`: the deploy branch is ahead of what is running (for example an earlier deploy failed or rolled back). Run `git switch deploy` and `npx --yes pnpm@10.34.1 install --frozen-lockfile`, then build with `NODE_OPTIONS=--max-old-space-size=8192 npx --yes pnpm@10.34.1 build`, then go to step 9.
   - `sync`: there is a new release `LATEST`. Continue with step 3.
3. Work on `sync/<LATEST>`. If that branch already exists from a failed earlier run, `git switch` to it and continue from where it stopped. Otherwise create it from `deploy`.
   - Do not push the fork's `main`. Pushes there trigger CodeQL and the other upstream workflows for nothing.
4. Run `git merge --no-ff <LATEST> -m "merge upstream <LATEST>"` (skip this if it is already merged).
   - **Merge release tags, never upstream `main`.** Upstream `main` runs ahead of the latest release.
   - If there are conflicts, resolve them so that upstream's change wins and the fork's behaviour is kept. Usually that means re-adding the one import line in `src/main.ts`.
5. Write `<LATEST>` into `fork/UPSTREAM_TAG` and commit on the sync branch.
6. Check what the release changed that touches the patch:
   - `src/main.ts` (is the import still first after the polyfill?)
   - `src/ts/globalApi.svelte.ts` (`fetchNative`, `fetchViaProxy2`, `fetchWithProxy`)
   - `server/node/server.cjs` (`reverseProxyFunc`, the `/proxy2` routes, the `express.raw` octet-stream parser)
   - `src/ts/preset/registry/remote.ts` (does the official registry URL still start with the `UPSTREAM_REGISTRY_BASE` in `serverEgress.ts`?)
   - `Dockerfile` (runtime `COPY --from=builder` paths; `deploy-pve.sh` reads them, but check for new runtime steps)
   - `package.json` and `pnpm-lock.yaml`. Changed dependencies are fine because they come from upstream's image, but the fork must not add its own.

   Adapt `src/ts/fork/*` if any of these moved.
7. Run `bash fork/verify.sh`. If it fails, fix the cause.
   - Fix fork code first. Fix upstream code only for genuine merge breakage, never to silence an upstream test.
   - If you cannot make it pass, **stop**: commit the work in progress on `sync/<LATEST>`, do not touch `deploy`, and do not push. The next run continues from that branch.
8. Run `git switch deploy` and `git merge --ff-only sync/<LATEST>`, then `git push origin deploy`.
   - **Never push tags to origin**, because `v*` tags trigger upstream's Docker publish workflow on the fork.
9. Run `bash fork/deploy-pve.sh --skip-build`.
   - `dist` was already built from this commit (by verify, or in step 2), and the deploy needs a clean tree.
   - The script backs up the save volume to the PC, runs a health check, rolls back by itself on failure, and prunes old images.
   - If the deploy fails, for example because the GHCR image for a brand-new tag is not published yet, report it. `status.sh` will say `ACTION=deploy` tomorrow, so the next run retries.
10. Run `bash fork/status.sh` again. It should print `ACTION=none`.

## Report

End every run with a short report covering the following:

- Registry: the profiles added (IDs) or "no new models", plus anything skipped or suspicious.
- Release: "no new release", or the old tag to the new tag, the merge conflicts and how they were resolved, the verify result, and the deploy result with the image name.
- Anything left for the maintainer to decide.
