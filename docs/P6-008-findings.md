# TICKET-P6-008 Findings — Search by Name (Personal Scope, then Global)

**Status: `BLOCKED`** — reviewer verdict, fix-cycle-1 review, 2026-11-08 (second review).
Branch `agent/P6-008` (cut from `main`, up to date with `0fc5e42`), worktree
`/home/jano/IdeaProjects/bread-sheet-agent-P6-008`.

**One blocker remains, and it is a real test defect, not an environment gap.** Both of the first
review's blockers are resolved; the Playwright suite could now be *executed* for the first time,
and executing it revealed two failing tests in the ticket's own new spec
`bread-sheet-app/e2e/home-search.spec.ts`. The matrix is therefore not green, no acceptance box is
ticked and no PR was opened.

| Blocker | First review | Now |
|---|---|---|
| 1 — app `npm run typecheck`: 24 errors in `hooks/use-product-search.test.tsx` | `BLOCKED` | **resolved** (`98bc443`), re-verified exit 0 |
| 2 — Playwright `test:e2e` not executable (rootless container networking) | `BLOCKED` | **resolved**: kernel reboot fixed `tun`; a second, different podman defect was diagnosed and worked around; the suite ran |
| 3 — **two Playwright tests fail** in `e2e/home-search.spec.ts` | not reachable | **`BLOCKED`**, owner **frontend implementer** |

This is fix cycle 1's review. Per `agent-team/src/prompts/guardrails.md` § Stopping conditions,
**one more fix cycle is allowed** before the run hands back to the human unmerged.

---

## Current state (what was on `main` before this branch)

- No search bar anywhere in `bread-sheet-app/app/`; no `/api` endpoint accepting a name query.
- `server/src/services/productVisibility.ts` (P6-009) held the `REJECTED`-is-invisible rule as a
  Prisma `where` object only.
- `lib/api.ts`'s `api.get()` took no per-request options, and every `fetch` rejection became a
  `NetworkError`.
- `app/(tabs)/scan.tsx` offered manual code entry as the only camera-free way out.
- The `pg_trgm` extension was not enabled and `Product` had no trigram indexes.

## What was implemented

### Backend — Slice B (`d8ca6d7`, **unchanged since the first review**)

- `server/src/services/productSearchService.ts` — `parseSearchQuery` (100 raw chars measured
  **before** trimming, ≥ 2 trimmed), the opaque keyset cursor codec (`base64url(JSON{q,s,r,id})`,
  bound to the issuing `q`), and the `$queryRaw` search: `pg_trgm` `%` matching on `name`/`brand`,
  ranked `similarity DESC, ratingCount DESC, id ASC`, `LIMIT 21` to detect a next page.
- `server/src/services/productVisibility.ts` — exports `INVISIBLE_PRODUCT_STATUS`, now the single
  source for the rule in both the Prisma `where` object and the raw-SQL predicate.
- `server/src/controllers/productController.ts` — `searchProductsHandler`, mapping
  `SearchValidationError` → `400 { code, message }`.
- `server/src/routes/productRoutes.ts` — `GET /search` registered **ahead of** `/:productId`
  (whose `router.param` 400s non-UUIDs), `requireAuth` + `userLimiter`, no `requireRegistered`.
- `server/prisma/migrations/20261108153920_product_search_trgm/` — `CREATE EXTENSION IF NOT EXISTS
  pg_trgm` plus two GIN `gin_trgm_ops` indexes, also declared in `schema.prisma` so a later
  `migrate dev` won't treat them as drift.
- Tests: `productSearchService.test.ts`, `productController.test.ts`, `productVisibility.test.ts`.
- Docs: `CLAUDE.md`, `docs/architecture/backend.md` § Product Search,
  `docs/bruno/Products/search-products.bru`, `docs/bruno/environments/local.bru`.

### Frontend — Slices A + B (`327123b`)

- `features/search/match.ts` — `normalizeSearchText`, `matchesNameOrBrand` (plain
  `String.includes`), `filterRatingsByQuery(entries, query, categoryPredicate?)`.
- `features/search/api.ts` — `searchProducts(query, cursor, signal)`, `isSearchableQuery`.
- `hooks/use-product-search.ts` — 300 ms debounce, `AbortController` aborted in the debounce
  effect's cleanup, `aborted` re-checked in `then`/`catch`/`finally`, cursor pagination, `active`
  gate so the Mine scope issues zero requests.
- `app/(tabs)/index.tsx` — search bar + Mine/All toggle (default Mine), two distinct Mine empty
  states, All-scope result cards with the "Needs review" badge, offline → `OFFLINE_MESSAGE` +
  "Switch to Mine →", `onScroll` → `loadMore`, and the `focusSearch` hand-off consumer.
- `lib/api.ts` — `api.get(path, { signal })`; a caught `AbortError` is rethrown as-is.
- `app/(tabs)/scan.tsx` — `scan-search-by-name` affordance → `/(tabs)` with
  `params: { focusSearch: 'all' }`.
- Tests: `home-search-mine.test.tsx`, `home-search-all.test.tsx`, `use-product-search.test.tsx`,
  `features/search/{match,api}.test.ts`, `lib/api.test.ts` and `scan-screen.test.tsx` additions,
  `e2e/home-search.spec.ts`.
- Docs: `CLAUDE.md`, `docs/architecture/frontend.md` § Search.

### Fix cycle 1

- **`98bc443` (frontend)** — explicit `renderHook<ProductSearchState, SearchProps>` type arguments
  in `hooks/use-product-search.test.tsx` (23 lines changed); `home-search-all.test.tsx`'s mocked
  `setParams` now mutates the shared `mockParams` object and the hand-off test asserts single
  consumption across a re-render; the `expect(true).toBe(true)` placeholder in
  `home-search-mine.test.tsx` replaced by a comment pointing at the real coverage.
- **`f226235` (backend)** — `CLAUDE.md`'s product-search paragraph reworded so Slice A reads as in
  scope for the *ticket* while out of scope for the *backend*, with a link to
  `docs/architecture/frontend.md#search--personal-scope-then-global-ticket-p6-008`. Anchor verified
  to exist (`frontend.md:372`). No code change. **Resolved.**

---

## Test results — fix-cycle-1 review run

Every row was executed by the reviewer in this worktree on 2026-11-08. `not_run` rows say why.

| # | Command (cwd) | Exit | Observed |
|---|---|---|---|
| 1 | `npm run typecheck` (`server/`) | 0 | no output |
| 2 | `npm test` (`server/`) | 0 | `Test Files 35 passed (35)` / `Tests 410 passed (410)` |
| 3 | `npm run lint` (`server/`) | 0 | no findings |
| 4 | **`npm run typecheck` (`bread-sheet-app/`)** | **0** | no output — **blocker 1 resolved** (was exit 2 with 24 errors) |
| 5 | `npm test -- --ci` (`bread-sheet-app/`) | 0 | `Test Suites: 35 passed, 35 total` / `Tests: 359 passed, 359 total` |
| 6 | `npm run lint` (`bread-sheet-app/`) | 1 | 1 error, 0 warnings: `scripts/test-maestro.js 1009:40 error 'Buffer' is not defined no-undef` |
| 7 | `npm run lint` (`bread-sheet-app/`, **on `main`**) | 1 | **byte-identical** single error, same file/line/column/rule — re-confirmed this run; pre-existing, untouched file, not a regression |
| 8 | `supabase start --exclude …` (repo root, CLI 2.122.0, the README/CI pin) | 0 | `API_URL "http://127.0.0.1:54321"`, `DB_URL …:54322` — succeeded only through the podman workaround below |
| 9 | `POST /auth/v1/signup` anon probe | 0 | `http=200`, token carries `"is_anonymous":true` — the stack the specs need really works |
| 10 | **`npm run test:e2e` (`bread-sheet-app/`)** | **1** | **`3 passed`, `2 failed`** — `auth.spec.ts` ✓, `scan-tab.spec.ts` ✓, `home-search.spec.ts` 1 ✓ / 2 ✘. **Blocker 3** |
| 11 | `MAESTRO_PREREQS_ONLY=1 npm run test:maestro` (`bread-sheet-app/`) | 0 | `Supabase credentials: from the process environment (no .env file needed)`, SDK `/home/jano/Android/Sdk`, Java 21, Maestro `/home/jano/.maestro/bin/maestro`, `using existing AVD "breadsheet-e2e"` |
| 12 | `npm run test:maestro` (full) | **not_run** | Incidental to this ticket, and the flows need a *reachable backend*, which this machine cannot provide — see "Maestro" |
| 13 | Mutation test A (hand-off spec vs. removed `router.setParams`) | — | Test **fails**: `Expected number of calls: 1 / Received number of calls: 0` |
| 14 | Mutation test B (hand-off spec vs. removed consumed-once guard) | — | Test **passes** — honest residual gap, see "Test-quality review" |

Real-database verification of Slice B is **not repeated**: `d8ca6d7` is byte-for-byte unchanged
since the first review (`git diff d8ca6d7 HEAD -- server/` is empty apart from `f226235`'s
`CLAUDE.md` line), so the first review's 22/22 real-Postgres AC harness and live route-ordering
probe still stand. They are reproduced verbatim in the appendix below for the PR body's benefit.

---

## Blocker 3 (code) — two Playwright tests fail in `e2e/home-search.spec.ts`

**Owner: frontend implementer.** Both failures are in the spec the ticket added, and both are
defects in the *spec*, not in the shipped screen — the app's observed behaviour is correct in both
cases. Neither could have survived a single local run of the suite, which is exactly why the first
review refused to treat the un-runnable suite as a footnote.

### 3a — `home-search.spec.ts:45` — strict-mode violation (ambiguous locator)

```
Error: strict mode violation: getByText('Coca-Cola') resolved to 2 elements:
    1) <div …>Coca-Cola</div>          aka getByText('Coca-Cola', { exact: true })
    2) <div …>Coca-Cola Company</div>  aka getByText('Coca-Cola Company')
```

The fixture's own data defeats the locator: `RATINGS[0].product` is
`{ name: 'Coca-Cola', brand: 'Coca-Cola Company' }`, the card renders both, and `getByText` is
substring-matching, so Playwright refuses to pick one. Three occurrences of the same pattern are at
risk (lines 45, 50, 55) plus the negative assertion at line 51.

*Fix direction (implementer's call):* `getByText('Coca-Cola', { exact: true })`, or give the result
card's name a `testID` and locate by that. A `.first()` would also pass but would stop proving
*which* element matched, which is the point of the assertion.

### 3b — `home-search.spec.ts:107` — the expectation contradicts the ticket's own design

```
Locator: getByText('Coca-Cola')   Expected: visible   Error: element(s) not found
```

Playwright's captured page state at the moment of failure:

```yaml
- textbox "Search products":
  - /placeholder: Search your ratings
  - text: pepsi
- button "Mine"
- button "All products"
- text: MY RATINGS 🔍 No matches in your ratings for "pepsi". Search all products →
```

The screen is behaving correctly: **one bar, two scopes** means the query survives a scope switch,
so coming back to Mine with `pepsi` still typed correctly shows the no-match empty state. The spec's
comment — *"Mine still works underneath — switching back shows the (unfiltered) ratings again"* — is
simply wrong about the design, and the same spec's second test (line 69–76) depends on the opposite
behaviour: it switches Mine → All *because* the query carries over. So the two tests in this file
assert mutually exclusive things about the same mechanism.

*Fix direction:* either clear the input before switching back and then assert the full list, or keep
the query and assert `home-search-no-match` (which is the more interesting assertion, since it shows
the personal scope is still live and filtering). Decide deliberately — do not "fix" the screen; the
query carrying over is what the ticket asks for ("The same input serves both").

### What is **not** implicated

`auth.spec.ts` and `scan-tab.spec.ts` both pass, so the Expo-web harness, guest sign-in and the
scan tab (including the new `scan-search-by-name` button being added to that screen) are fine. The
spec that does pass in this file — "a query with no match in Mine offers a way into All products" —
exercises the Mine → All hand-off end to end against real rendering.

---

## Resolution of the first review's blockers

### Blocker 1 — app `typecheck` — **resolved**

`98bc443` gives every `renderHook` call in `hooks/use-product-search.test.tsx` explicit type
arguments. `npm run typecheck` (both `tsconfig.json` *and* `tsconfig.test.json` projects, which is
what CI's `app` job runs) now exits 0 with no output; the jest suite is unchanged at 35 suites.
The implementer's open question is answered implicitly and correctly: `npm run typecheck`, not
`npx tsc --noEmit`, is the command the matrix is judged on.

### Blocker 2 — Playwright not executable — **resolved, with a diagnosed host defect and a workaround**

The first review's root cause (no `tun` module for the running kernel) was a stale-kernel artefact:
the host had booted `7.3.1-1-cachyos` while `/lib/modules` already held `7.3.3`, so no module could
load. After the reboot, `uname -r` = `7.3.3-1-cachyos`, `tun` and `overlay` are loaded, podman uses
the user's normal `overlay` store with `netavark`, and no isolated store was needed for this run.

`supabase start` then failed for a **completely different and previously invisible reason**, which
is worth recording because it will bite the next person:

```
sh: can't fork: Resource temporarily unavailable     (×362, one per restart attempt)
supabase_db_bread-sheet container is not running: exited
```

Diagnosed by bisection rather than guessed (the full sequence: an identical `podman run` of the same
image, with the same 9.6 KB entrypoint script, the same named volume, the same network, ulimits,
`--oom-score-adj`, `--cgroup-parent`, journald logging, ipc/shm settings and restart policy, started
*and stayed up*; a faithful replay of the container's whole create payload through the Docker-compat
API also worked). The single differing field is `HostConfig.PidsLimit`:

| `PidsLimit` sent to podman's Docker-compat API | container `pids.max` | result |
|---|---|---|
| `0` (what the Supabase CLI's Docker Go SDK sends, and what Docker defines as *unlimited*) | `0` | init process starts, **every `fork` returns `EAGAIN`** |
| `-1` (podman's own "unlimited") | `max` | works |
| omitted | `38292` | works |

So podman 6.1.4 takes Docker's "0 means unlimited" literally and writes `pids.max = 0`. Any
Docker-SDK client that sets the field explicitly — the Supabase CLI does — creates containers that
can never fork. Nothing on the host was reconfigured to get around it: a ~120-line unix-socket
HTTP proxy was put in front of `$XDG_RUNTIME_DIR/podman/podman.sock` that rewrites `PidsLimit: 0`
→ `-1` on `POST /containers/create` and passes everything else through byte for byte (keep-alive
included — forcing `Connection: close` makes the Go SDK's next call fail with `unexpected EOF`,
which cost one wasted attempt). With `DOCKER_HOST` pointed at that socket the stack came up first
try and the e2e suite ran.

The proxy lives only in this review session's scratch directory, deliberately: it is a workaround,
not something to commit. See follow-up 2 for the durable options.

**Everything from here on is reproducible without it** on any host whose container engine honours
Docker's `PidsLimit: 0` (i.e. actual Docker, or podman once this is fixed upstream), using the
README § "Web E2E (Playwright)" recipe unchanged. No `.env` file was read at any point: the Supabase
URL and publishable key were taken from `supabase status -o env`/`-o json` and passed inline on the
`npm run test:e2e` command, as the README prescribes.

---

## Maestro (`npm run test:maestro`) — `not_run`, incidental, with the real reason

The judgement from the first review is **unchanged**, and now rests on executed checks rather than
an environment gap:

- **Prerequisites are genuinely present and the credentials problem is gone.** Row 11: with the two
  `EXPO_PUBLIC_*` values exported inline, the runner reports
  `Supabase credentials: from the process environment (no .env file needed)` and clears every other
  prerequisite. The first review's `ERROR: No Supabase config` no longer applies.
- **What still blocks a full run is the backend, not the harness.** README § "Native E2E" is
  explicit: *"Unlike the Playwright suite, these flows run against a hosted Supabase project and the
  deployed dev API … because the product lookup needs a reachable backend."* The dev stack is paused
  by default (TICKET-P9-009 — CI's own Maestro job fails a "dev stack is paused" preflight), and the
  local stack started here is not a substitute: `http://127.0.0.1:54321` is not reachable from inside
  an Android emulator, and no API server was running. Providing either would mean reading `.env`,
  which is a standing prohibition.
- **The diff is incidental to the suite.** `git diff main...HEAD -- 'app/(tabs)/scan.tsx'` is
  **+17/−0**: one additive `TouchableOpacity` (`scan-search-by-name`) and `gap: 8` on its container.
  No camera, barcode-decode, permission or rescan-suppression logic changed, and no file under
  `e2e/maestro/` was touched. The two flows (`barcode-scan.yaml`, `manual-entry.yaml`) match by
  `testID`/text, not coordinates, so a second button in the same stack does not move their targets.
  The new affordance's own behaviours (rendered in every permission state; routes to `/(tabs)` with
  `focusSearch: 'all'`) are covered by executed jest tests, and its *destination* is now covered
  end-to-end by the passing Playwright test at `home-search.spec.ts:58`.

Recorded as an environment gap on an incidental suite, per
`agent-team/src/prompts/guardrails.md` § Native E2E. It is **not** what blocks this run — blocker 3
is.

---

## Acceptance criteria walk-through

### Slice A — personal search

| AC | Verdict | Evidence |
|---|---|---|
| Search input on Home filters my ratings as I type, no network request | **met** (unit) / **spec failing** (e2e) | `home-search-mine.test.tsx` asserts the filtered list *and* `expect(mockSearch).not.toHaveBeenCalled()`. The e2e test covering the same thing (`home-search.spec.ts:42`) **fails on its own locator** (3a) — the behaviour was visibly correct in the trace, but the box cannot be ticked while the spec is red |
| Name + brand, case- and diacritic-insensitive, substring | **met** | `match.test.ts` (`cola`→`Coca-Cola`, `CAFE`→`Café Latte`, `artisan`→brand) and the screen-level equivalents |
| Works offline against cached ratings | **met** | `home-search-mine.test.tsx` writes `ratingsCache`, makes `api.get` reject with `NetworkError`, waits for `offline-indicator`, then filters — the real store over a mocked FS map that reflects writes |
| Composes with the category chips | **DEFERRED → TICKET-P6-003** | P6-003 not built. `filterRatingsByQuery`'s `categoryPredicate` is the AND-composition point and is covered (`match.test.ts` "composes with an optional category predicate"), but no chips exist to compose with. **Box stays unchecked by user decision.** |
| A barcode-less P6-007 item is findable by name | **DEFERRED → TICKET-P6-007** | P6-007 not built; covered by a `kind: 'CUSTOM'`, `brand: null` fixture at matcher and screen level. **Box stays unchecked by user decision.** |
| Plain string containment, not a regex from user input | **met** | `matchesNameOrBrand` is `String.includes` over normalised strings; the only regex in `match.ts` is the fixed combining-marks class, which never sees user input |
| Empty state distinguishes "no match" from "nothing rated yet" | **met** | Separate branches + testIDs (`home-search-no-match` / `home-search-nothing-rated`); the "nothing rated" test types a query and asserts the copy does **not** change. Also observed live in the Playwright page dump under 3b |
| Query does not survive an app restart | **met** | Plain component state; test unmounts and re-renders, asserting `value === ''` |

### Slice B — global search

| AC | Verdict | Evidence |
|---|---|---|
| `GET /api/products/search` ranked by similarity, cursor-paginated at 20 | **met, executed on real PG** (first review, code unchanged) | 25-match fixture pages 20 + 5, no overlap, full coverage; ranking order observed |
| `REJECTED` never appears | **met, executed on real PG** | For registered and anonymous callers |
| `PENDING_REVIEW` appears flagged `unverified`, anonymous included | **met, executed on real PG** | — |
| Both kinds, each carrying `kind` + `similarity`, same visibility helper | **met** | `CUSTOM` found with `kind`/`similarity`; the predicate is `INVISIBLE_PRODUCT_STATUS` bound as a parameter — `productSearchService.test.ts` asserts the constant is in `values` and the literal `REJECTED` is *not* in the SQL text |
| `q` capped at 100 raw chars (pre-trim), rejected below 2 trimmed; no user input in a regex or raw SQL fragment | **met, executed on real PG** | `query_too_long` for 101 raw / 2 trimmed; an injection-shaped query returns 0 rows and leaves all 32 fixture rows intact. Client mirrors it in `isSearchableQuery` + `maxLength={100}` |
| A `pg_trgm` GIN index backs the query; migration creates extension + index | **met, executed** | `pg_extension` lists `pg_trgm`; both GIN `gin_trgm_ops` indexes exist; with `enable_seqscan=off` the plan is `Bitmap Index Scan on "Product_name_idx"  Index Cond: (name % 'nutela')` |
| Typo tolerance: "nutela" returns "Nutella" | **met, executed** | `similarity = 0.6666667` |
| Rate-limited, and integration tests incl. the visibility matrix | **met** (limiter structurally) | `userLimiter` is on the route and visible in the live middleware chain. No test in this repo exercises any limiter's 429 (stubbed in all seven controller suites, a pre-existing convention) — follow-up 5, not held against this ticket |
| Input debounced, superseded requests cancelled | **met** | `use-product-search.test.tsx` holds the first request open, asserts `firstSignal.aborted === false`, rerenders, asserts `aborted === true`, resolves the stale promise and asserts its results never land. Real `AbortController`; only the network boundary mocked. Plus `lib/api.test.ts`: `signal` reaches `fetch`, `AbortError` rethrown unwrapped |
| Global scope reports offline and points back to the working personal scope | **met** | `home-search-all.test.tsx` presses `home-search-switch-to-mine` and asserts the Mine pill's `accessibilityState.selected` flipped; copy is `OFFLINE_MESSAGE` via the `isOffline` branch |
| *(implicit)* Global results are not cached | **met** (proved by absence, checked directly) | `hooks/use-product-search.ts` and the All-scope render path import nothing from `lib/offline/*`; results live in component state and are dropped when the scope or query changes |

**No box is ticked.** Slice B's criteria are all met and executed, but
`agent-team/src/prompts/guardrails.md` § Documentation gates ticking on the *full matrix* being
green, and `test:e2e` is red.

---

## Test-quality review (per guardrails: "what production bug would this fail on?")

- **`AbortController` — real, not mocked.** The cancellation test fails if the hook drops
  `controllerRef.current?.abort()` from its cleanup, and *separately* if it stops re-checking
  `signal.aborted` before `setResults`.
- **Ratings cache — real store.** `home-search-mine.test.tsx` uses the actual `lib/offline/store` +
  `ratingsCache` over a mocked `expo-file-system/legacy` map that reflects writes, so the offline
  test fails if the screen stops reading the cache.
- **`$queryRaw` mock — flattening reconstructed.** `productSearchService.test.ts` re-runs the
  captured tagged-template arguments through `Prisma.sql`, so the "hostile `q` is a bound value, not
  text" test would fail on any future switch to string concatenation.
- **The `setParams` mock is fixed, and I executed the check rather than reading it.** `98bc443`
  makes the mock mutate `mockParams` — the frozen-state problem the first review flagged is gone.
  To establish what the test now actually catches, the screen was mutated in a throwaway copy of the
  app (hard-link copy under the session scratch dir, `node_modules` symlinked; the worktree was not
  touched, verified byte-identical afterwards):
  - **Mutation A — delete `router.setParams({ focusSearch: undefined })`** (i.e. the param is never
    consumed, the production bug that matters: the scan→search hand-off would re-fire on every
    return to the Home tab). Test **fails**: `Expected number of calls: 1 / Received: 0`. ✅
  - **Mutation B — delete the `consumedFocusSearch.current === focusSearch` guard.** Test still
    **passes**, because the now-faithful mock really does clear the param, so the guard is redundant
    in this scenario. That is the right trade — fidelity over a contrived assertion — but it means
    the guard itself is uncovered; it only earns its keep against a router that does not clear
    synchronously. Follow-up 3, not a blocker.
- **Placeholder test removed.** The `expect(true).toBe(true)` stub for the deferred category-chips
  AC is gone, replaced by a comment pointing at `features/search/match.test.ts`. Suite count moved
  360 → 359 accordingly, which accounts for the whole delta.
- **New weak spot found this round: the new Playwright spec mocks `/api/products/search` at the
  network layer**, so nothing in the committed suite exercises the real endpoint end to end. That is
  consistent with the existing e2e convention (the API server is not part of the Playwright stack
  and the spec's header says so), and the endpoint *was* executed against real Postgres by the
  reviewer — but it means the ticket ships no committed regression test for the live query. See
  follow-up 1.

## Documentation review

`CLAUDE.md`, `docs/architecture/backend.md` § Product Search, `docs/architecture/frontend.md`
§ Search, `docs/bruno/Products/search-products.bru` and `docs/bruno/environments/local.bru` are all
present, and the technical claims spot-checked against a running database hold exactly
(`similarity('nutela','nutella') ≈ 0.667`, threshold `0.3`, index names, route-ordering rationale,
`CREATE EXTENSION` ordering). Both cross-reference anchors resolve (`frontend.md:372`,
`backend.md:265`). The first review's one wording objection is fixed by `f226235`. No ADR is
warranted — ADR 0006 already covers the model this endpoint reads, and nothing here is a new
architectural commitment. **Documentation is complete; it is not what blocks this ticket.**

## Follow-ups (not implemented here)

Per the repo's convention (`MEMORY.md` → "Follow-ups in FEATURES.md") these belong in `FEATURES.md`
as tickets, but a reviewer's `FEATURES.md` write scope is this ticket's checkboxes only
(`agent-team/src/prompts/guardrails.md` § Scope), so they are filed here for the coordinator or a
human to promote. **Item 1 is the one explicitly requested for promotion.**

1. **Give the `server` CI job a Postgres service**, so `pg_trgm` behaviour, the visibility filter and
   the trigram/partial indexes are verified continuously instead of twice by hand. Every server test
   mocks `../db.js` (repo-wide convention; CI has no Postgres), so the claims proved by the
   reviewer's real-database harness are protected by nothing in the repo — including the GIN index
   actually being used, the `%` threshold, and `REJECTED`-exclusion in raw SQL. That harness is
   deliberately not committed, so a future refactor can silently regress all of it.
   Suggested ticket shape: add a `services: postgres:18-alpine` block to the `server` job in
   `.github/workflows/test.yml`, run `npx prisma migrate deploy` against it, and promote the
   reviewer's 22-check harness into `server/src/__tests__/` behind a `DATABASE_URL`-present guard so
   it skips locally and runs in CI. `docs/architecture/backend.md` records the same gap.
2. **Host container engine: `PidsLimit: 0` is written through as `pids.max = 0`** (see blocker 2's
   table). Until podman fixes it, any Docker-SDK tool is broken on this machine, not just Supabase.
   Durable options, in order of preference: report upstream and pin the fix; run the Playwright
   stack under real Docker; or keep a small committed dev-only shim (`scripts/`) rather than a
   scratch-dir proxy, documented in README § Web E2E.
3. **Cover the `consumedFocusSearch` guard** (mutation B above survives). A second test where
   `setParams` is a no-op — modelling a router that has not yet applied the change — would pin the
   guard's purpose.
4. **Drop the deferred-AC comment and write the real test** when P6-003 lands and chip ∧ query
   composition can be asserted end to end.
5. **No limiter is exercised by any test in the repo** (`userLimiter` is stubbed in all seven
   controller suites). One shared test driving a limiter to `429` would turn "rate-limited" from a
   structural claim into an executed one, for this endpoint and the ~20 others.
6. **Brand-only matches rank last by construction** — `similarity` is always name-vs-query, so a row
   matched purely on `brand` scores near 0 (observed `0.038`) and sorts below every weak name match.
   Intentional and documented (P6-007's "Did you mean …?" needs the name score), but if brand search
   is meant to feel first-class, ranking by `GREATEST(similarity(name,q), similarity(brand,q))`
   while still *returning* the name score is the cheap improvement.
7. **`e2e/home-search.spec.ts` mocks the search endpoint** (see test-quality review). If the
   Playwright stack ever gains the API server, one unmocked search assertion would be worth more
   than the three mocked ones.

## Open questions for the implementers

- **Frontend (blocker 3, both parts).** Fix the two failing assertions in
  `bread-sheet-app/e2e/home-search.spec.ts` and **run `npm run test:e2e` yourself before reporting
  done** — the README recipe works on this host now (start the local stack from the repo root; pass
  `EXPO_PUBLIC_SUPABASE_URL`/`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` inline from
  `supabase status -o env`; do not read `.env`). If `supabase start` dies with
  `sh: can't fork`, that is blocker 2's podman defect, not your code — say so and hand it back
  rather than changing the spec to avoid it.
  - 3b needs a deliberate product call, not just a green test: **should the query survive a scope
    switch?** The ticket's "the same input serves both" and this spec's own second test say yes, so
    the expectation at line 107 is what should change. Confirm that reading in your report.
- **Backend:** nothing outstanding. `f226235` closed the only request, Slice B passed every
  criterion including on a real database, and `server/` is untouched since `d8ca6d7`.
- **Neither:** blocker 2 is a host defect with a known workaround; it needs no code change on this
  branch, but follow-up 2 should be promoted so the next ticket does not rediscover it.

## Boxes checked in `FEATURES.md`

**None.** `npm run test:e2e` is red (blocker 3), so per guardrails § Documentation no
acceptance-criteria box was ticked and no PR was opened. The two DEFERRED criteria (category chips →
TICKET-P6-003, barcode-less P6-007 item → TICKET-P6-007) stay unchecked regardless, by the user's
decision.

---

## Appendix — first review's real-database verification (still valid; `server/` unchanged)

A throwaway `postgres:18-alpine` container (`PostgreSQL 18.6`) with all 14 migrations applied
(`npx prisma migrate deploy` → `All migrations have been successfully applied.`;
`migrate diff … --exit-code` → `No difference detected.`). The harness imported
`server/src/services/productSearchService.ts` **unmodified** and seeded 32 products + 4 ratings.
**22/22 checks passed:**

- Typo tolerance — `"nutela"` → `Nutella` at `similarity = 0.6666667`; matched set ranked
  `Nutella 0.6666667`, `Nutella Biscuits 0.33333334`, `Hazelnut Spread Jar` (brand-only) `0.038`.
- `REJECTED` never appears, for a registered *and* an anonymous caller.
- `PENDING_REVIEW` appears with `unverified: true`, anonymous caller included.
- A `CUSTOM`, brand-less product is found by name, carrying `kind: 'CUSTOM'` and `similarity: 1`.
- Brand-only matches are returned (name score reported, as documented).
- Image resolution — a stored key serialises through `resolveImageUrl` to an absolute URL.
- Rating-count tiebreak — identical names (`similarity = 1`) order 3-ratings before 1-rating.
- Cursor pagination over 25 matches — page 1 = 20 + `nextCursor`, page 2 = 5 + `null`, zero overlap,
  union = all 25.
- A cursor replayed against a different `q` raises `SearchValidationError`.
- 99 spaces + `"ab"` (101 raw, 2 trimmed) → `query_too_long`; `"'); DROP TABLE \"Product\"; --"`
  returns 0 rows and leaves all 32 rows intact.
- `pg_extension` lists `pg_trgm`; `pg_indexes` shows `Product_name_idx`/`Product_brand_idx` as
  `USING gin (… gin_trgm_ops)`; with `enable_seqscan = off` the plan is
  `Bitmap Heap Scan → Bitmap Index Scan on "Product_name_idx"  Index Cond: (name % 'nutela'::text)`.

Route ordering was executed rather than inferred by booting the real `src/app.ts`:
`GET /api/products/search?q=cola` → `401 {"error":"Authorization header missing"}` (it reached
`requireAuth` on its own route) while `GET /api/products/not-a-uuid` → `400
{"code":"invalid_product_id"}`; had `/search` been shadowed it would have produced the `400` too.
The printed chain confirmed `/search → [requireAuth, userLimiter, searchProductsHandler]`.
