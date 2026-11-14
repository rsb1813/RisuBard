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
| Registry checkout | `H:\projects\risubard-model-registry`. The `origin` remote is the rsb1813 fork of the upstream model registry, and `upstream` is the original registry; run `git remote -v` there to see both. The legacy names are kept out of this repository for its brand-boundary check. |
| Server | PVE host `pve` (ssh alias), container 103, app at `/opt/risubard`, port 7777 |
| Save backups | `H:\projects\risubard-backups`. The newest 7 are kept. |

## The fork patch (keep it this small)

Upstream files touched: `src/main.ts` (1 line), `src/ts/process/index.svelte.ts` (2 lines), and `server/node/server.cjs` (2 lines). Everything else is in fork-only files.

| File | What it does |
|---|---|
| `src/ts/fork/serverEgress.ts` (+ test) | Wraps `window.fetch`. Every cross-origin HTTP(S) request goes through the server's `/proxy2`, so the browser never contacts AI providers or other external APIs. It also rewrites the official model registry URL (the upstream registry's `main`) to the fork registry. |
| `src/main.ts` | One added line: `import "./ts/fork/serverEgress";` directly after the polyfill import. |
| `src/ts/fork/serverBardWiki.ts` (+ test) | Drop-in replacement for `createStoredResponseMemoryAnalysis`. `confirm()` resolves the chat's `memory` and `model` model presets plus their credentials (the same binding logic `requestChatDataMain` uses), posts the analysis to the server, and polls the job. It falls back to the in-browser analysis for classic or plugin models, or when the server answers 404/503. |
| `src/process/index.svelte.ts` | Two lines: the import of `createStoredResponseMemoryAnalysisWithServer`, and `const storedResponseMemoryAnalysis = createStoredResponseMemoryAnalysisWithServer({` in place of `createStoredResponseMemoryAnalysis({`. |
| `src/ts/fork/bardwikiServer/*` (+ tests) | The Node side. `entry.ts` is bundled to `server/node/fork/dist/bardwiki-runner.cjs`. `modelCall.ts` calls the model with the same adapters the browser uses. `nodeContext.ts` handles loopback self-calls and server-minted auth. `nodeStubs/` holds Node stand-ins for browser-only modules. |
| `server/node/fork/bardwiki-jobs.cjs` (+ test) | Routes for `/api/fork/bardwiki/jobs`. It holds jobs in memory and runs one job per chat at a time. |
| `server/node/server.cjs` | Two lines after `modelJobs.registerRoutes(...)`: a comment and `require('./fork/bardwiki-jobs.cjs').createBardWikiJobs(...).registerRoutes(app);` |
| `fork/*` | This tooling. `fork/vite.bardwiki-server.config.ts` builds the server bundle, and `fork/build.sh` builds the frontend and the server bundle. |

What the patch does and does not do:

- **Done:** the browser never contacts an external host with `fetch()`; everything goes through the server.
- **Done upstream:** model-preset requests (chat, BardWiki and memory model calls among them) already run as server jobs, because `nodeOnlyServerSideRequests` defaults to on. Those jobs survive a dropped connection.
- **Done: server-driven BardWiki.** Turn analysis and wiki-reboot batches (`confirm()`) run on the server once they start, and finish even if the tab is closed. The server runs the browser's own `memoryAnalysisClient.ts`, bundled for Node.
  - **Still in the browser:** the decision to start an analysis (made after a reply is stored), manual wiki commands (`directWikiCommand`), and the lore and markdown writers outside `confirm()`.
  - **Classic or plugin models:** chats whose memory or model role uses one keep the in-browser analysis.
  - **Server restarts:** a restart drops running jobs; the browser reports "job was lost".
  - **Limits on the server path:** it makes a single attempt per model call, with no fallback-model chain and no request log entry.
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
2. Run `node H:\projects\RisuBard\fork\registry-candidates.mjs H:\projects\risubard-model-registry --days 60`. It prints one list per gateway: models from tracked vendors that the gateway serves but that have no profile in that gateway's folder.
   - `[openrouter]`: compared with `profiles/openrouter/`, using data from `https://openrouter.ai/api/v1/models`.
   - `[vercel]`: compared with `profiles/vercel/`, using data from `https://ai-gateway.vercel.sh/v1/models`. Batch-API (`-batch`) variants are already filtered out.
   - If one source prints `FAILED`, do the other source and report the failure.
3. For each real new model, **add** a profile in that gateway's folder: `profiles/openrouter/` for an `[openrouter]` candidate and `profiles/vercel/` for a `[vercel]` one.
   - **Skip:**
     - Legal, regional and duplicate dated-snapshot variants, unless clearly useful.
     - Vercel speed tiers of a model that already has a profile (`-fast`, `-highspeed`, `-ultrafast`). List them in the report instead.
   - **Copying:** copy the closest sibling profile in the same folder (same vendor and family). Then set `id` (`<gateway>:<key>`), `displayName`, `displayNameI18n.ko`, `description`, `descriptionI18n.ko`, `modelId` (the gateway's model ID exactly), `sortOrder`, `capabilities`, `limits`, `recommendedTokenizer`, `profileStatus: "current"`, and `updatedAt` (the current time in ms). Keep the sibling's `endpoint`, `auth`, `tags` style and `sourceUrls`.
   - **OpenRouter fields:** take capabilities and limits from `/api/v1/models`, using the mapping table in the registry's MAINTENANCE.md.
   - **Vercel fields:**
     - `contextWindowTokens` comes from `context_window`, and `maxOutputTokens` from `max_tokens`.
     - Capabilities come from `tags` and `supported_parameters`:
       - `reasoning` from the `reasoning` tag or the `reasoning` parameter
       - `vision` from the `vision` tag or image input
       - `tools` from `tool-use` or `tools`
       - `json` from `structured-output` or `response_format`
       - `streaming` always
     - Vercel has no tokenizer field. Use the sibling's `recommendedTokenizer`, or the same model's OpenRouter profile if there is one.
   - **Model in both gateways:** add it to each folder; the two profiles are independent.
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
   - `deploy`: the deploy branch is ahead of what is running (for example an earlier deploy failed or rolled back). Run `git switch deploy` and `npx --yes pnpm@10.34.1 install --frozen-lockfile`, then build with `bash fork/build.sh`, then go to step 9.
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
   - **BardWiki server path:**
     - `src/ts/risubard/memoryAnalysisClient.ts`: the options and return shape of `createStoredResponseMemoryAnalysis`, and the `MemoryAnalysisModelCall` type.
     - `src/ts/process/index.svelte.ts`: the `storedResponseMemoryAnalysis` creation, which must still go through `createStoredResponseMemoryAnalysisWithServer`.
     - `src/ts/process/request/modelPresetBinding.ts` (binding and credential helpers) and `request.ts`: what `requestModelPreset` does for memory calls. Mirror any meaningful change in `bardwikiServer/modelCall.ts`.
     - `server/node/server.cjs`: `createServerJwt`, `checkProxyAuth`, and the `modelJobs.registerRoutes` anchor.
     - **Build failures from `fork/build.sh`:**
       - A "not exported" error from a `nodeStubs/*` file means a bundled module started importing more browser state. Add a Node stand-in for exactly that export, or cut the import from `bardwikiServer` code.
       - A failing bundle load check means some module touches `window`/`document` at import time. Find it with `BARDWIKI_TRACE=<module> npx --yes pnpm@10.34.1 exec vite build --config fork/vite.bardwiki-server.config.ts`.
     - **Bundled dependencies:** the bundle keeps the packages in `package.json` `dependencies` external, so they load from the runtime image. A new dev-only dependency pulled into the graph gets bundled.
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
