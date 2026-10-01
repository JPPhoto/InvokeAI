---
title: Frontend Development
lastUpdated: 2026-02-18
---

Invoke's UI is made possible by many contributors and open-source libraries. Thank you!

## Dev environment

Follow the [dev environment](/development/setup/dev-environment/) guide to get set up. The default UI lives in `invokeai/frontend/webv2`. Run `make frontend-install`, then `make frontend-dev`; `make frontend-build` builds the bundle served by `invokeai-web`. The existing `frontendv2-*` targets remain aliases.

`invokeai/frontend/webv1` is the legacy frontend. Build it with `make frontend-legacy-build` and select it with `invokeai-web --web-legacy`. `--webv2` remains a compatibility alias for the default UI. Close other editor tabs before switching frontends on the same origin. Existing browser storage and project recovery data retain their names and formats; switching frontends does not migrate or erase them.

## Package scripts

Run these in `invokeai/frontend/webv2`:

- `dev`: run the frontend with hot reloading
- `build`: run formatting, lint, types, and architecture checks, then build
- `lint`: run formatting, Oxc lint, TypeScript, and architecture checks
- `fix`: fix supported lint and formatting issues
- `test`: run the unit suite
- `test:browser`: run Chromium interaction tests
- `check:release`: run the complete release gates, including performance, project-file, and accessibility journeys

The legacy package has its own scripts and lockfile. Frontend CI runs webv2's checks and release gate; legacy lint and tests remain available locally. See each package's `AGENTS.md` for its commands and ownership rules.

## Gallery paging

The Gallery and media picker virtualize rows at absolute listing indices. An unloaded page leaves empty tile slots in the scroll geometry, so page eviction and backward reload do not regroup rows or move the viewport, including when the column count does not divide the 60-item page size.

Each mounted consumer owns a transient, account-scoped TanStack Query window. The paging core and query-cache owner hold the window geometry and lifecycle; mounted Gallery and picker consumers construct its observers. Its normal retention budget is ten pages of 60 items. Forward fetches evict the oldest retained page; backward fetches evict the newest. A viewport that requires more than this budget uses a capacity derived from its visible range, rather than a larger listing cutoff. Only virtual rows mount thumbnail resources. Inactive query entries are collected immediately. A retained widget paused by React Activity keeps its last bounded immutable snapshot for rendering on resume, while its observer is stopped; resuming reloads the visible range. Evicted images remain accessible through backend offsets, without retaining their tile data.

The range loader serializes requests toward the latest viewport range. A distant scrollbar jump loads directly at the requested page instead of replaying all preceding pages. Boundary-fetch failures preserve the retained pages and offer retry. A distant reload releases the old pages while preserving the last known listing size, so loading and retry leave the viewport geometry intact. Listing invalidation rebuilds the retained span atomically, using the same sort and filters. Offset pagination follows the backend's live listing: additions or removals can change an image's index; page eviction alone cannot. Semantic and date-board queries retain their existing ordered-name metadata for hydration and range selection, separate from loaded thumbnail data.

Selection records the item's actual page so Preview and explicit reveals can start near it. Paginated mode continues to address its selected 60-item page. The regression tests cover traversal beyond ten pages, backward reload, bounded retained data, and fixed viewport positions.

Infinite Gallery projects up to 60 matching local completions into the displayed listing until an authoritative page contains them. Each completion is inserted by the active timestamp/kind/name sort relative to retained backend rows; when adjacent rows confirm its rank, that rank is retained in small per-listing overlay state across page eviction and rebased when a listing change shifts it. If its neighboring page has not loaded yet, a row beyond a deep window uses the absolute listing head or tail; a partial prefix keeps it at the next loaded slot until more rows arrive. Stored positions clamp to the current backend total after deletions. The display total and sparse indices include overlay rows, and range requests translate display coordinates back to backend offsets. Reconciled keys stay recorded for the current filter/account window so evicting their page does not add a duplicate local row when it is reloaded. Query pages and page parameters remain in backend coordinates.

## Type generation

The shared `invokeai/frontend/api` package owns OpenAPI/type generation for backend contracts. CI checks these artifacts independently of either UI package. We use [openapi-typescript] to generate types from the app's OpenAPI schema. The generated types are committed to the repo in [schema.ts].

If you make backend changes, it's important to regenerate the frontend types:

```sh
set -o pipefail
pnpm -C invokeai/frontend/api install --frozen-lockfile
cd invokeai/frontend/api && python ../../../scripts/generate_openapi_schema.py | pnpm typegen
```

On macOS and Linux, you can run `make frontend-typegen` as a shortcut for the above snippet.

## Localization

We use [i18next] for localization, but translation to languages other than English happens on our [Weblate] project.

Only the English source strings (i.e. `en.json`) should be changed on this repo.

## VSCode

### Example debugger config

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "chrome",
      "request": "launch",
      "name": "Invoke UI",
      "url": "http://localhost:5173",
      "webRoot": "${workspaceFolder}/invokeai/frontend/webv2"
    }
  ]
}
```

### Remote dev

We've noticed an intermittent timeout issue with the VSCode remote dev port forwarding.

We suggest disabling the editor's port forwarding feature and doing it manually via SSH:

```sh
ssh -L 9090:localhost:9090 -L 5173:localhost:5173 user@host
```

## Contributing Guidelines

Thanks for your interest in contributing to the Invoke Web UI!

Please follow these guidelines when contributing.

## Check in before investing your time

Please check in before you invest your time on anything besides a trivial fix, in case it conflicts with ongoing work or isn't aligned with the vision for the app.

If a feature request or issue doesn't already exist for the thing you want to work on, please create one.

Ping `@psychedelicious` on [discord] in the `#frontend-dev` channel or in the feature request / issue you want to work on - we're happy to chat.

## Code conventions

Follow `invokeai/frontend/webv2/AGENTS.md` and its `ARCHITECTURE.md` for ownership, state, React, persistence, and product-quality rules. The linked Redux and control-layer guides describe the legacy frontend.

## Commit format

Please use the [conventional commits] spec for the web UI, with a scope of "ui":

- `chore(ui): bump deps`
- `chore(ui): lint`
- `feat(ui): add some cool new feature`
- `fix(ui): fix some bug`

## Tests

Colocate unit tests and Chromium browser tests with the owning code. Use real browser storage and interaction where mocks cannot establish correctness. Run `pnpm check:release` before milestone readiness; browser screenshots and interaction review complement automated gates.

## Submitting a PR

- Ensure your branch is tidy. Use an interactive rebase to clean up the commit history and reword the commit messages if they are not descriptive.
- Run `pnpm lint`. Some issues are auto-fixable with `pnpm fix`.
- Fill out the PR form when creating the PR.
  - It doesn't need to be super detailed, but a screenshot or video is nice if you changed something visually.
  - If a section isn't relevant, delete it.

## Other docs

- [Workflows - Design and Implementation]
- [State Management]

[discord]: https://discord.gg/ZmtBAhwWhy
[i18next]: https://github.com/i18next/react-i18next
[Weblate]: https://hosted.weblate.org/engage/invokeai/
[openapi-typescript]: https://github.com/openapi-ts/openapi-typescript
[schema.ts]: https://github.com/invoke-ai/InvokeAI-7/blob/main/invokeai/frontend/api/schema.ts
[conventional commits]: https://www.conventionalcommits.org/en/v1.0.0/
[Workflows - Design and Implementation]: ./workflows/
[State Management]: ./state-management/
