# TICKET-P6-008 Findings — Search by Name (Personal Scope, then Global)

**Status: `PASS`** — reviewer verdict, fix-cycle-2 review, 2026-11-08 (third and final review).
Branch `agent/P6-008` (cut from `main`, up to date with `0fc5e42`), worktree
`/home/jano/IdeaProjects/bread-sheet-agent-P6-008`.

**The full test matrix is green and every blocker from the two earlier reviews is resolved.** The
Playwright suite — the thing that blocked fix cycle 1 — now passes all 5 tests, including the three
this ticket added. 16 of the ticket's 18 acceptance criteria are ticked; the remaining two are
**deferred by the user's own decision** to the tickets that will make them testable (category-chip
composition → TICKET-P6-003, a barcode-less custom item → TICKET-P6-007) and stay unchecked.

| Blocker | Review 1 | Review 2 (fix cycle 1) | Now (fix cycle 2) |
|---|---|---|---|
| 1 — app `npm run typecheck`: 24 errors in `hooks/use-product-search.test.tsx` | `BLOCKED` | resolved (`98bc443`) | **resolved**, re-verified exit 0 |
| 2 — Playwright `test:e2e` not executable (rootless container defects) | `BLOCKED` | resolved (host defect diagnosed + worked around) | **resolved**, suite executed again from scratch this run |
| 3 — two Playwright tests fail in `e2e/home-search.spec.ts` | not reachable | `BLOCKED` | **resolved** (`2c14493`), `5 passed` |
| Follow-up 3 — `consumedFocusSearch` guard uncovered (mutation B survived) | — | open | **closed**: new test, mutation-killed on two independent assertions |

This was fix cycle 2 — the last one allowed by `agent-team/src/prompts/guardrails.md`
§ Stopping conditions. No further cycle was needed.

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

### Backend — Slice B (`d8ca6d7`, unchanged since review 1)

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

`git diff d8ca6d7..HEAD -- server/` is **empty** — the backend is byte-for-byte what review 1
verified against a real Postgres (22/22 checks; reproduced in the appendix).

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
  `params: { focusSearch: 'all' }` (+17/−0, purely additive).
- Tests: `home-search-mine.test.tsx`, `home-search-all.test.tsx`, `use-product-search.test.tsx`,
  `features/search/{match,api}.test.ts`, `lib/api.test.ts` and `scan-screen.test.tsx` additions,
  `e2e/home-search.spec.ts`.
- Docs: `CLAUDE.md`, `docs/architecture/frontend.md` § Search.

### Fix cycle 1 (`98bc443` frontend, `f226235` backend)

- Explicit `renderHook<ProductSearchState, SearchProps>` type arguments in
  `hooks/use-product-search.test.tsx` (blocker 1); `home-search-all.test.tsx`'s mocked `setParams`
  made to mutate the shared `mockParams` object; the `expect(true).toBe(true)` placeholder in
  `home-search-mine.test.tsx` replaced by a comment pointing at the real coverage.
- `CLAUDE.md`'s product-search paragraph reworded so Slice A reads as in scope for the *ticket*
  while out of scope for the *backend*. No code change.

### Fix cycle 2 (`2c14493`, frontend, 2 files / +49 −9)

- **3a** — the three ambiguous locators at `home-search.spec.ts:45,50,55` became
  `getByText('Coca-Cola', { exact: true })`. Correct fix: the fixture's brand is
  `"Coca-Cola Company"`, which contains the substring, and `exact: true` pins the *name* element
  rather than hiding the ambiguity behind a `.first()`.
- **3b** — the final assertion now expects Mine's `home-search-no-match` state after switching back
  with `"pepsi"` still in the box. **This matches the ticket**, which says in so many words
  *"One bar, two scopes. The same input serves both"* (`FEATURES.md:1161`) — the query surviving a
  scope switch is the design, and the same spec's second test depends on it. The expectation was
  changed, not the screen, which is the right half to move.
- **Follow-up 3 closed** — a new test in `app/(tabs)/home-search-all.test.tsx:282` pins the
  `consumedFocusSearch` guard. Verified by mutation below.

---

## Test results — fix-cycle-2 review run

Every row was executed by the reviewer in this worktree on 2026-11-08. `not_run` rows say why.

| # | Command (cwd) | Exit | Observed |
|---|---|---|---|
| 1 | `npm run typecheck` (`server/`) | **0** | no output |
| 2 | `npm test` (`server/`) | **0** | `Test Files  35 passed (35)` / `Tests  410 passed (410)` |
| 3 | `npm run lint` (`server/`) | **0** | no findings |
| 4 | `npm run typecheck` (`bread-sheet-app/`) | **0** | no output (both `tsconfig.json` and `tsconfig.test.json` projects) |
| 5 | `npm test -- --ci` (`bread-sheet-app/`) | **0** | `Test Suites: 35 passed, 35 total` / `Tests: 360 passed, 360 total` |
| 6 | `npm run lint` (`bread-sheet-app/`) | 1 | 1 error, 0 warnings: `scripts/test-maestro.js 1009:40 error 'Buffer' is not defined no-undef` |
| 7 | `npm run lint` (`bread-sheet-app/`, **on `main`**) | 1 | **byte-identical** single error, same file/line/column/rule. The file is untouched by this branch (`git diff main...HEAD -- bread-sheet-app/scripts/test-maestro.js` is empty) and **no workflow in `.github/workflows/` runs lint at all** (`grep -rn "run lint\|eslint" .github/workflows/` → no matches), so this is a pre-existing local-only condition, not a regression and not a CI gate |
| 8 | `npx supabase@2.122.0 start --exclude …` (repo root, the README/CI pin) | **0** | `API_URL "http://127.0.0.1:54321"`, `DB_URL …:54322`; `supabase_db` / `supabase_kong` / `supabase_auth` all `Up (healthy)`. Succeeded through the byte-level relay below |
| 9 | `POST /auth/v1/signup` anon probe | **0** | `http=200`; decoded JWT payload `is_anonymous = true`, `role = authenticated` — the stack the specs need really works |
| 10 | **`npm run test:e2e` (`bread-sheet-app/`)** | **0** | **`5 passed (4.1s)`** — `auth.spec.ts` ✓, `scan-tab.spec.ts` ✓, `home-search.spec.ts` **3/3** ✓ (`:42` Mine filters as you type, `:61` Mine→All hand-off, `:82` All-scope global result + switch back). **Blocker 3 resolved** |
| 11 | `MAESTRO_PREREQS_ONLY=1 npm run test:maestro` | **0** | `Supabase credentials: from the process environment (no .env file needed)`, SDK `/home/jano/Android/Sdk`, Java 21, Maestro `/home/jano/.maestro/bin/maestro`, `using existing AVD "breadsheet-e2e"` |
| 12 | `npm run test:maestro` (full) | **not_run** | Incidental to this ticket, and the flows need a *reachable backend* this machine cannot provide — see "Maestro" |
| 13 | Mutation C — guard test vs. **removed** `consumedFocusSearch` guard | — | Test **fails** at `home-search-all.test.tsx:298`: `Expected number of calls: 1 / Received number of calls: 4` |
| 14 | Mutation C again, with line 298 relaxed to `toBeGreaterThanOrEqual(1)` | — | Test **still fails**, now at `:303`: `Expected: true / Received: false` — the *user-visible* assertion (the Mine pill stays selected) is independently mutation-sensitive |
| 15 | Mutation C baseline (guard intact, same throwaway copy) | — | `Test Suites: 1 passed` / `Tests: 7 skipped, 1 passed` — the kill is the mutation's, not the copy's |
| 16 | Relay proof — `POST /containers/create` with `PidsLimit: 0` **direct** to the podman socket | — | container logs `sh: can't fork: Resource temporarily unavailable`; `inspect .HostConfig.PidsLimit` → `0`. Defect reproduced, not assumed |
| 17 | Same request **through the relay** | — | container logs `max` then `FORKTEST=ok`; `inspect` → `-1`. Workaround proven at the cgroup level before any Supabase call |

Row 6 is the only non-zero exit in the matrix, and row 7 is why it does not block: identical on
`main`, in a file this branch never touches, and not executed by CI.

---

## Verification of the fix-cycle-2 changes

### 3b — does the new expectation match the ticket?

**Yes.** The ticket's Slice heading is literally *"**One bar, two scopes.** The same input serves
both, with a scope toggle that defaults to **Mine**"* (`FEATURES.md:1161`). A query that survived
the switch Mine → All in the spec's second test cannot be expected to vanish on the switch back in
the third; review 2 flagged exactly that self-contradiction. The new assertion
(`home-search-no-match` visible, with `"pepsi"` still in the box) is also the *stronger* of the two
available fixes, because it proves the personal scope is still live and filtering rather than merely
re-rendering a list. The coordinator confirmed the product reading independently.

### Follow-up 3 — is the new guard test real coverage?

Two separate questions, both checked by execution rather than by reading.

**(a) Does it fail when the guard is deleted?** Yes, and twice over. A throwaway copy of
`bread-sheet-app/` was made (a real `tar` copy, not hard links, with `node_modules` symlinked), the
single line `if (consumedFocusSearch.current === focusSearch) return;` was removed from
`app/(tabs)/index.tsx` **in the copy only**, and the test was re-run:

- At `:298` — `Expected number of calls: 1 / Received number of calls: 4`. Without the guard the
  effect re-fires on every render while `focusSearch` is still `'all'`.
- Relaxing `:298` to see past it, the mutant then fails at `:303` —
  `Expected: true / Received: false`: the Mine pill is **not** selected any more, i.e. the scope has
  snapped back to "All" after the user deliberately chose "Mine". That is the production bug in its
  user-visible form, and the test catches it.

The worktree was verified byte-identical afterwards (`git status --porcelain` empty,
`git diff HEAD` empty), and the copy was deleted.

**(b) Does the mock model a plausible real condition?** Yes — and this is worth recording, because
"an unstable `useRouter()` identity" reads like a contrivance and isn't one in expo-router 58.0.30:

- `node_modules/expo-router/build/global-state/useRouterActions.js` memoises the router object on
  `[enqueue, setTransitionMode]`.
- Those come from `RoutingQueueApiContext`, whose value is memoised on `[startTransition,
  transitionMode]` (`global-state/routingQueueContext.js`). **`transitionMode` is `useState`** — when
  it changes, the context value changes, `enqueue` changes, and `useRouter()` genuinely returns a new
  object. The effect's `[focusSearch, router]` deps therefore really can change without
  `focusSearch` changing. (React also documents `useMemo` as not a semantic guarantee.)
- The other half of the mock — `setParams` as a no-op, i.e. the param has not cleared yet — is
  plainly real: `router.setParams` goes through `enqueue` → `setQueue(...)`, a state update drained
  in a *later* render. It cannot have cleared by the time the next render runs.

So the test's scenario is a genuine combination of two documented behaviours of the real router, not
a shape invented to make an assertion fire. Review 2's "fidelity over a contrived assertion"
objection is satisfied: fidelity was kept *and* the guard is now pinned.

---

## Resolution of all prior blockers

### Blocker 1 — app `typecheck` — resolved

`98bc443` gives every `renderHook` call in `hooks/use-product-search.test.tsx` explicit type
arguments. `npm run typecheck` exits 0 with no output over both TS projects (row 4), which is the
command CI's `app` job runs.

### Blocker 2 — Playwright not executable — resolved; host defect diagnosed, worked around, cleaned up

Two independent host defects were in the way across the three reviews. The first (no `tun` module
for the running kernel) was a stale-kernel artefact and is gone after the reboot (`uname -r` =
`7.3.3-1-cachyos`, `tun` and `overlay` loaded).

The second is real and still present: **podman 6.1.4's Docker-compat API applies Docker's
`HostConfig.PidsLimit: 0` — which Docker defines as *unlimited* — literally, writing
`pids.max = 0`.** Every `fork` in such a container returns `EAGAIN`. The Supabase CLI's Docker Go SDK
always sends the field, so its containers can never start.

| `PidsLimit` sent to podman's Docker-compat API | container `pids.max` | result |
|---|---|---|
| `0` (what the Supabase CLI sends; Docker = unlimited) | `0` | init starts, **every `fork` → `EAGAIN`** |
| `-1` (podman's own "unlimited") | `max` | works |
| omitted | `38292` | works |

Reproduced and fixed at the cgroup level before any Supabase call (rows 16–17), so the workaround is
proven rather than assumed.

**The workaround had to be a raw byte-level relay, not an HTTP proxy.** Review 2 used
`http.createServer` + `http.request`, which worked for `supabase start` but — as the fix-cycle-2
implementer found — breaks the Docker SDK's **attach/`Upgrade` hijack**: `gotrue migrate` hangs
forever, because re-serialising the request drops the connection hijack the SDK needs to stream the
migration's output. This run used `net.createServer` instead: it frames requests only far enough to
find `POST …/containers/create`, rewrites `"PidsLimit": 0` → `-1` in that one JSON body, fixes that
one `Content-Length`, and relays **every other byte untouched** — abandoning parsing entirely for the
rest of a connection the moment it sees `Transfer-Encoding: chunked` or an `Upgrade`. With
`DOCKER_HOST` pointed at it, the stack came up first try and the suite ran.

Two practical constraints, both of which cost time to rediscover and belong in follow-up 2:

- The listen socket must sit under a **short** path — unix socket paths cap at ~108 bytes and the
  session scratch directory's path alone is longer than that. `/tmp/p6008-sock/d.sock` (22 bytes) was
  used **for the socket only**.
- Keep-alive must be preserved; forcing `Connection: close` makes the Go SDK's next call fail with
  `unexpected EOF`. A byte-level relay gets this for free.

Nothing on the host or in podman's configuration was changed. The relay, its socket directory and the
throwaway app copy were all removed at the end of the run (verified: no `pids-relay` process,
`/tmp/p6008-sock` gone, both git trees clean). **No `.env` file was read at any point** — the
Supabase URL and publishable key came from `supabase status -o env` and were passed inline on the
`npm run test:e2e` command, per the README.

Everything from row 8 on is reproducible with the README § "Web E2E (Playwright)" recipe unchanged on
any host whose engine honours Docker's `PidsLimit: 0` (real Docker, or podman once this is fixed
upstream).

### Blocker 3 — two failing Playwright tests — resolved

`2c14493` fixed both, in the spec rather than the screen, which review 2 identified as the correct
side in both cases. `npm run test:e2e` is `5 passed`, exit 0 (row 10).

---

## Maestro (`npm run test:maestro`) — `not_run`, incidental, judgement unchanged

Nothing changed since review 2 that could move this judgement: fix cycle 2 touched exactly two files
(`git diff --name-only f44e9ca..HEAD` → `home-search-all.test.tsx`, `e2e/home-search.spec.ts`),
neither of them camera, scan or Maestro code.

- **Prerequisites are genuinely present, checked directly rather than inferred** (row 11, plus
  `ls -d /home/jano/Android/Sdk` and `ls /home/jano/.maestro/bin/maestro` both succeeding). The
  credentials gap from review 1 is gone.
- **What blocks a full run is the backend, not the harness.** README § "Native E2E" is explicit that
  these flows need a hosted Supabase project and the deployed dev API, "because the product lookup
  needs a reachable backend". The dev stack is paused by default (TICKET-P9-009; CI's own Maestro job
  fails a "dev stack is paused" preflight), and the local stack is not a substitute:
  `http://127.0.0.1:54321` is unreachable from inside an Android emulator, and nothing was listening
  on `:3000` (`ss -ltn` checked — proved, not assumed). Supplying either would mean reading `.env`,
  which is a standing prohibition.
- **The diff is incidental to the suite.** `git diff main...HEAD -- 'bread-sheet-app/app/(tabs)/scan.tsx'`
  is **+17/−0**: one additive `TouchableOpacity` (`scan-search-by-name`) and `gap: 8` on its
  container. No camera, barcode-decode, permission or rescan-suppression logic changed, and
  `git diff main...HEAD -- 'bread-sheet-app/e2e/maestro/' 'bread-sheet-app/scripts/test-maestro.js'`
  is empty. The two flows match by `testID`/text, not coordinates, so a second button in the same
  stack does not move their targets. The new affordance's own behaviours are covered by executed
  jest tests, and its *destination* is covered end to end by the passing Playwright test at
  `home-search.spec.ts:61`.

Recorded as an environment gap on an **incidental** suite, per `guardrails.md` § Native E2E. The
ticket's own deliverable — the search feature — was exercised end to end by the Playwright suite, so
this is a footnote under a pass, not the clause being used to pass something unexercised.

---

## Acceptance criteria walk-through

### Slice A — personal search

| AC | Verdict | Evidence |
|---|---|---|
| Search input on Home filters my ratings as I type, no network request | **met ✓** | `home-search-mine.test.tsx` asserts the filtered list *and* `expect(mockSearch).not.toHaveBeenCalled()`. Now also **executed end to end**: `home-search.spec.ts:42` types `cola` against real rendering and sees `Coca-Cola` kept / `Sourdough Loaf` dropped |
| Name + brand, case- and diacritic-insensitive, substring | **met ✓** | `match.test.ts` (`cola`→`Coca-Cola`, `CAFE`→`Café Latte`, `artisan`→brand); e2e re-types `COLA` and still matches, proving case-insensitivity and substring (not prefix) in the browser |
| Works offline against cached ratings | **met ✓** | `home-search-mine.test.tsx` writes `ratingsCache`, makes `api.get` reject with `NetworkError`, waits for `offline-indicator`, then filters — the real store over a mocked FS map that reflects writes |
| Composes with the category chips | **DEFERRED → TICKET-P6-003** | P6-003 is not built. `filterRatingsByQuery`'s `categoryPredicate` is the AND-composition point and is covered (`match.test.ts` "composes with an optional category predicate"), but there are no chips to compose with, so the criterion as written cannot be executed. **Box stays unchecked, by the user's decision.** |
| A barcode-less P6-007 item is findable by name | **DEFERRED → TICKET-P6-007** | P6-007 is not built; covered by a `kind: 'CUSTOM'`, `brand: null` fixture at matcher and screen level, but no real custom item can exist yet. **Box stays unchecked, by the user's decision.** |
| Plain string containment, not a regex from user input | **met ✓ (static, stated as such)** | This is a criterion about code structure, not runtime behaviour, so per `guardrails.md` § Verification it is satisfied statically and said so here: `matchesNameOrBrand` is `String.includes` over normalised strings, and the only regex in `match.ts` is a fixed combining-marks class that never sees user input |
| Empty state distinguishes "no match" from "nothing rated yet" | **met ✓** | Separate branches + testIDs (`home-search-no-match` / `home-search-nothing-rated`); the "nothing rated" test types a query and asserts the copy does **not** change. Both e2e tests at `:61` and `:82` now assert `home-search-no-match` live in the browser |
| Query does not survive an app restart | **met ✓** | Plain component state; the test unmounts and re-renders, asserting `value === ''` |

### Slice B — global search

| AC | Verdict | Evidence |
|---|---|---|
| `GET /api/products/search` ranked by similarity, cursor-paginated at 20 | **met ✓, executed on real PG** | 25-match fixture pages 20 + 5, no overlap, union = all 25; ranking order observed. `server/` byte-unchanged since that run |
| `REJECTED` never appears | **met ✓, executed on real PG** | For a registered *and* an anonymous caller |
| `PENDING_REVIEW` appears flagged `unverified`, anonymous included | **met ✓, executed on real PG** | — |
| Both kinds, each carrying `kind` + `similarity`, same visibility helper | **met ✓, executed on real PG** | A `CUSTOM`, brand-less product found with `kind: 'CUSTOM'`, `similarity: 1`. The predicate is `INVISIBLE_PRODUCT_STATUS` bound as a parameter — `productSearchService.test.ts` asserts the constant is in `values` and the literal `REJECTED` is *not* in the SQL text |
| `q` capped at 100 raw chars (pre-trim), rejected below 2 trimmed; no user input in a regex or raw SQL fragment | **met ✓, executed on real PG** | `query_too_long` for 101 raw / 2 trimmed; an injection-shaped `q` returns 0 rows and leaves all 32 fixture rows intact. The client mirrors it in `isSearchableQuery` + `maxLength={100}` |
| A `pg_trgm` GIN index backs the query; migration creates extension + index | **met ✓, executed** | `pg_extension` lists `pg_trgm`; both GIN `gin_trgm_ops` indexes exist; with `enable_seqscan=off` the plan is `Bitmap Index Scan on "Product_name_idx"  Index Cond: (name % 'nutela')` |
| Typo tolerance: "nutela" returns "Nutella" | **met ✓, executed** | `similarity = 0.6666667`, ranked first |
| Rate-limited, and integration tests incl. the visibility matrix | **met ✓, with one named residual** | Both halves have executed evidence: the booted real `src/app.ts` printed the chain `/search → [requireAuth, userLimiter, searchProductsHandler]`, and the visibility matrix is covered by passing tests plus the real-PG checks above. **Residual, stated plainly:** no test in this repo drives *any* limiter to a `429` — `userLimiter` is stubbed in all seven controller suites, a pre-existing repo-wide convention. What is proven here is that the limiter is mounted on this route, not that `express-rate-limit` throttles. Follow-up 5; not held against this ticket, which did not introduce the convention |
| Input debounced, superseded requests cancelled | **met ✓** | `use-product-search.test.tsx` holds the first request open, asserts `firstSignal.aborted === false`, rerenders, asserts `aborted === true`, resolves the stale promise and asserts its results never land. Real `AbortController`; only the network boundary mocked. Plus `lib/api.test.ts`: `signal` reaches `fetch`, `AbortError` rethrown unwrapped |
| Global scope reports offline and points back to the working personal scope | **met ✓** | `home-search-all.test.tsx` presses `home-search-switch-to-mine` and asserts the Mine pill's `accessibilityState.selected` flipped; copy is `OFFLINE_MESSAGE` via the `isOffline` branch |
| *(implicit)* Global results are not cached | **met ✓ (absence proved, not inferred)** | `hooks/use-product-search.ts` and the All-scope render path import nothing from `lib/offline/*` — checked by grep over the actual files; results live in component state and are dropped when scope or query changes |

**16 of 18 boxes ticked.** The 2 deferred criteria stay unchecked and are now referenced from the
tickets that will make them executable.

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
- **No frozen-state mocks remain in the hand-off tests.** The `setParams` mock mutates `mockParams`
  (fixed in `98bc443`), and the new guard test deliberately *overrides* it to a no-op for one
  scenario with a comment saying why — which is the honest way to model "the param hasn't cleared
  yet", not a frozen mock hiding a bug. Three mutations were executed across the three reviews and
  all three are now killed:
  - **A — delete `router.setParams({ focusSearch: undefined })`** → fails (`1` vs `0` calls).
  - **B — delete the `consumedFocusSearch` guard**, old suite → *passed*; this was review 2's honest
    residual and follow-up 3.
  - **C — delete the guard**, new suite → **fails twice** (rows 13–14 above). Residual closed.
- **One precise note on the new test's assertion order.** The mutant dies at `:298` (the call count)
  before reaching `:303`. I relaxed `:298` and re-ran specifically to check that `:303` is not dead
  weight — it isn't; it fails on its own. Both the "consumed once" property and its user-visible
  consequence are pinned.
- **Known weak spot, unchanged: the new Playwright spec mocks `/api/products/search`** at the network
  layer, so nothing in the committed suite exercises the real endpoint end to end. That matches the
  existing e2e convention (the API server is not part of the Playwright stack, and the spec's header
  says so) and the endpoint *was* executed against real Postgres by the reviewer — but the live query
  ships with no committed regression test. Follow-ups 1 and 7.

## Documentation review

`CLAUDE.md`, `docs/architecture/backend.md` § Product Search, `docs/architecture/frontend.md`
§ Search, `docs/bruno/Products/search-products.bru` and `docs/bruno/environments/local.bru` are all
present and consistent with the code as shipped. The technical claims were spot-checked against a
running database in review 1 and hold exactly (`similarity('nutela','nutella') ≈ 0.667`, threshold
`0.3`, index names, route-ordering rationale, `CREATE EXTENSION` ordering). Both cross-reference
anchors resolve (`frontend.md:372`, `backend.md:265`). No endpoint shape changed in fix cycle 2, so
no `.bru` update was due. No ADR is warranted — ADR 0006 already covers the model this endpoint
reads, and nothing here is a new architectural commitment. **CLAUDE.md's "Mandatory
Post-Implementation Steps" are satisfied.**

## Follow-ups (not implemented here)

Per the repo's convention these belong in `FEATURES.md` as tickets, but a reviewer's `FEATURES.md`
write scope is this ticket's checkboxes only (`guardrails.md` § Scope), so they are filed here for
the coordinator or a human to promote. **Items 1 and 2 are the ones worth promoting first.**

**Promoted to `FEATURES.md` (coordinator, 2026-11-08):**

| # | Home in `FEATURES.md` |
|---|---|
| 1 | new **TICKET-P9-011** — real-Postgres integration tests in CI |
| 2 | note + acceptance criterion on **TICKET-P9-006**, which already tracked the "can't fork" failure |
| 3 | done in `2c14493`; no ticket |
| 4 | note on **TICKET-P6-003** (closes P6-008's chip-composition box) |
| 5 | new **TICKET-P9-012** — prove the rate limiters throttle |
| 6 | new **TICKET-P6-012** — rank brand matches fairly |
| 7 | implementation bullet on **TICKET-P9-007** |
| 8 | widened **TICKET-P9-008** to the app and to a CI lint step |

The other open Slice A box (P6-007 item findable) is now an acceptance criterion on **TICKET-P6-007**.

1. **Give the `server` CI job a Postgres service**, so `pg_trgm` behaviour, the visibility filter and
   the trigram indexes are verified continuously instead of twice by hand. Every server test mocks
   `../db.js` (repo-wide convention; CI has no Postgres), so the claims proved by the reviewer's
   real-database harness are protected by nothing in the repo — including the GIN index actually
   being used, the `%` threshold, and `REJECTED`-exclusion in raw SQL. That harness is deliberately
   not committed, so a future refactor can silently regress all of it.
   Suggested shape: a `services: postgres:18-alpine` block on the `server` job in
   `.github/workflows/test.yml`, `npx prisma migrate deploy` against it, and the reviewer's 22-check
   harness promoted into `server/src/__tests__/` behind a `DATABASE_URL`-present guard so it skips
   locally and runs in CI. `docs/architecture/backend.md` records the same gap.
2. **Host container engine: podman writes `PidsLimit: 0` through as `pids.max = 0`** (blocker 2's
   table; reproduced at rows 16–17). Until podman fixes it, *any* Docker-SDK tool is broken on this
   machine, not just Supabase. **Amended after fix cycle 2 — the shim's shape is now a hard
   requirement, not a detail:**
   - It must be a **raw byte-level relay** (`net.createServer`), patching only the
     `POST …/containers/create` body's `PidsLimit` and that request's `Content-Length` and passing
     all other bytes through, upgrades included. An HTTP re-serialising proxy
     (`http.createServer` + `http.request`) **breaks the Docker SDK's attach/`Upgrade` hijack and
     hangs `gotrue migrate`** — discovered the expensive way by the fix-cycle-2 implementer.
   - Keep-alive must be preserved (forcing `Connection: close` → `unexpected EOF` on the SDK's next
     call), and the listen socket needs a **short path** (unix sockets cap at ~108 bytes; an agent
     session's scratch path alone exceeds it).
   - Durable options in order of preference: report upstream and pin the fix; run the Playwright
     stack under real Docker; or commit a small dev-only shim under `scripts/`, documented in
     README § Web E2E, rather than each run rebuilding a scratch-dir relay from the findings doc.
3. ~~**Cover the `consumedFocusSearch` guard.**~~ **DONE** in `2c14493` —
   `home-search-all.test.tsx:282`, mutation-verified at rows 13–15. Kept here only to close the
   loop from review 2.
4. **Drop the deferred-AC comment and write the real test** when P6-003 lands and chip ∧ query
   composition can be asserted end to end. Tie to the unchecked Slice A box.
5. **No limiter is exercised by any test in the repo** (`userLimiter` is stubbed in all seven
   controller suites). One shared test driving a limiter to `429` would turn "rate-limited" from a
   mounting claim into an executed one, for this endpoint and the ~20 others.
6. **Brand-only matches rank last by construction** — `similarity` is always name-vs-query, so a row
   matched purely on `brand` scores near 0 (observed `0.038`) and sorts below every weak name match.
   Intentional and documented (P6-007's "Did you mean …?" needs the name score), but if brand search
   is meant to feel first-class, ranking by `GREATEST(similarity(name,q), similarity(brand,q))`
   while still *returning* the name score is the cheap improvement.
7. **`e2e/home-search.spec.ts` mocks the search endpoint.** If the Playwright stack ever gains the
   API server, one unmocked search assertion would be worth more than the three mocked ones.
8. **`bread-sheet-app` lint is red on `main`** — `scripts/test-maestro.js:1009` `'Buffer' is not
   defined`, and **no workflow runs lint**, so nothing catches it or would catch the next one. Either
   add `node` globals for `scripts/` in the ESLint config and fix the error, or add a lint job. Not
   this ticket's to fix (the file is untouched here), but it is why row 6 needs a paragraph of
   explanation on every review.

## Open questions

**None blocking.** The one product question review 2 raised — *should the query survive a scope
switch?* — is answered and now matches the ticket, the spec and the screen (see "Verification of the
fix-cycle-2 changes"). The two deferred acceptance criteria are not open questions but deliberate
deferrals with named destination tickets.

## Boxes checked in `FEATURES.md`

**16 of the ticket's 18 acceptance criteria**: 6 of 8 under Slice A and all 10 under Slice B. The two
left unchecked are the deferred ones — category-chip composition (→ TICKET-P6-003) and a barcode-less
P6-007 item being findable (→ TICKET-P6-007) — by the user's decision, since neither can be executed
before its dependency exists.

---

## Appendix — real-database verification of Slice B (review 1; `server/` byte-unchanged since)

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
