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

Upstream already sends model-preset chat requests, including BardWiki and memory model calls, as server jobs (`nodeOnlyServerSideRequests`, which defaults to on). The egress wrapper covers everything else that used to go out of the browser directly.

Rules for changes:

- **Do not change dependencies.** `node_modules` in production comes from the upstream image of the same tag.
- Prefer new files under `src/ts/fork/` plus one-line hooks over edits inside upstream files.
- Do not change upstream tests to make the patch pass.

## Job 1: model registry refresh (daily)

Work in `H:\projects\risubard-model-registry`. Follow its `MAINTENANCE.md` (the schema v4 layout and Tier 0 sources), with these fork rules:

1. Run `git fetch upstream`, then merge `upstream/main` into `main`. If `index.json` or `catalog.json` conflict, take either side and regenerate them in step 4; never hand-merge them.
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
2. Run `gh release view -R rpaddict/RisuBard --json tagName -q .tagName` and compare the result with `fork/UPSTREAM_TAG`. If they are equal, stop: there is nothing to do.
3. Mirror upstream main by running `git push origin upstream/main:main`. This is a fast-forward only; if it is rejected, report it and do not force.
4. Run `git switch deploy`, then `git merge --no-ff <newTag> -m "merge upstream <newTag>"`.
   - **Merge release tags, never upstream `main`.** Upstream `main` runs ahead of the latest release.
   - If there are conflicts, resolve them so that upstream's change wins and the fork's behaviour is kept. Usually that means re-adding the one import line in `src/main.ts`.
5. Write `<newTag>` into `fork/UPSTREAM_TAG` and commit.
6. Check what the release changed that touches the patch:
   - `src/main.ts` (is the import still first after the polyfill?)
   - `src/ts/globalApi.svelte.ts` (`fetchNative`, `fetchViaProxy2`, `fetchWithProxy`)
   - `server/node/server.cjs` (`reverseProxyFunc`, the `/proxy2` routes, the `express.raw` octet-stream parser)
   - `src/ts/preset/registry/remote.ts` (does the official registry URL still start with the `UPSTREAM_REGISTRY_BASE` in `serverEgress.ts`?)
   - `Dockerfile` (runtime `COPY --from=builder` paths; `deploy-pve.sh` reads them, but check for new runtime steps)
   - `package.json` and `pnpm-lock.yaml`. Changed dependencies are fine because they come from upstream's image, but the fork must not add its own.

   Adapt `src/ts/fork/*` if any of these moved.
7. Run `bash fork/verify.sh`. If it fails, fix the cause. Fix fork code first. Fix upstream code only for genuine merge breakage, never to silence an upstream test. If you cannot make it pass, **stop**: do not push and do not deploy, and leave the work on a local branch `sync/<newTag>` (`git switch -c sync/<newTag>`).
8. Run `git push origin deploy`. **Never push tags to origin**, because `v*` tags trigger upstream's Docker publish workflow on the fork.
9. Run `bash fork/deploy-pve.sh --skip-build`. `verify.sh` already built `dist` from this commit, and the deploy needs a clean tree. The script backs up the save volume to the PC, health-checks, and rolls back by itself on failure.
10. If the deploy failed and rolled back, report the error from the script output.

## Report

End every run with a short report covering the following:

- Registry: the profiles added (IDs) or "no new models", plus anything skipped or suspicious.
- Release: "no new release", or the old tag to the new tag, the merge conflicts and how they were resolved, the verify result, and the deploy result with the image name.
- Anything left for the maintainer to decide.
