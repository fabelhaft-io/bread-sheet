# TICKET-P6-008 Findings — Search by Name (Personal Scope, then Global)

**Status: `BLOCKED`** — reviewer verdict, 2026-11-08. Branch `agent/P6-008` (cut from `main`),
worktree `/home/jano/IdeaProjects/bread-sheet-agent-P6-008`.

Two blockers, one of them a code defect:

1. **`npm run typecheck` fails in `bread-sheet-app/`** — 24 TypeScript errors, all in the new
   `hooks/use-product-search.test.tsx`. The same command is green on `main`, and CI's `app` job
   runs it (`.github/workflows/test.yml:106`), so a PR would be red on arrival. Owner:
   **frontend implementer**. (The implementer's "tsc clean" report was produced by
   `npx tsc --noEmit`, which only covers `tsconfig.json`; the `npm run typecheck` script is
   `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit` and the test project is
   where the errors are.)
2. **`npm run test:e2e` (Playwright) could not be executed on this machine** — the local Supabase
   stack cannot start because rootless container networking is unavailable (`/dev/net/tun` returns
   `ENODEV`; no `tun` module for kernel `7.3.1-1-cachyos`). This is a UI-reachable deliverable, so
   per `agent-team/src/prompts/guardrails.md` § Verification ("an environment gap on the ticket's
   own deliverable is `BLOCKED`") it is not a footnote under a pass. Owner: **environment / human**
   (exact fix below). No code change is implied.

Everything else passed, including a from-scratch verification of the Slice B acceptance criteria
against a **real Postgres 18.6** with all migrations applied — see "Real-database verification".

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

### Backend — Slice B (commit `d8ca6d7`)

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
  pg_trgm` plus two GIN `gin_trgm_ops` indexes; the indexes are also declared in `schema.prisma`
  so a later `migrate dev` won't treat them as drift.
- Tests: `productSearchService.test.ts` (+296 lines), `productController.test.ts` (+133),
  `productVisibility.test.ts` (updated).
- Docs: `CLAUDE.md`, `docs/architecture/backend.md` (new § Product Search),
  `docs/bruno/Products/search-products.bru`, `docs/bruno/environments/local.bru`.

### Frontend — Slices A + B (commit `327123b`)

- `features/search/match.ts` — `normalizeSearchText` (NFKD + strip marks + lowercase),
  `matchesNameOrBrand` (plain `String.includes`, no regex over user input),
  `filterRatingsByQuery(entries, query, categoryPredicate?)`.
- `features/search/api.ts` — `searchProducts(query, cursor, signal)`, `isSearchableQuery`.
- `hooks/use-product-search.ts` — 300 ms debounce, `AbortController` aborted in the debounce
  effect's cleanup (i.e. on the next keystroke, not merely superseded), `aborted` re-checked in
  `then`/`catch`/`finally`, cursor pagination, `active` gate so the Mine scope issues zero requests.
- `app/(tabs)/index.tsx` — search bar + Mine/All toggle (default Mine), two distinct Mine empty
  states, All-scope result cards with the "Needs review" badge, offline → `OFFLINE_MESSAGE` +
  "Switch to Mine →", `onScroll` → `loadMore`.
- `lib/api.ts` — `api.get(path, { signal })`; a caught `AbortError` is rethrown as-is instead of
  being wrapped in `NetworkError`.
- `app/(tabs)/scan.tsx` — `scan-search-by-name` affordance → `/(tabs)` with
  `params: { focusSearch: 'all' }`, consumed once by the Home screen and cleared via `setParams`.
- Tests: `home-search-mine.test.tsx`, `home-search-all.test.tsx`, `use-product-search.test.tsx`,
  `features/search/{match,api}.test.ts`, `lib/api.test.ts` and `scan-screen.test.tsx` additions,
  `e2e/home-search.spec.ts`.
- Docs: `CLAUDE.md`, `docs/architecture/frontend.md` (new § Search).

---

## Test results

Every row below was executed by the reviewer in this worktree. `not_run` rows say why.

| # | Command (cwd) | Exit | Observed |
|---|---|---|---|
| 1 | `npm run typecheck` (`server/`) | 0 | no output |
| 2 | `npm test` (`server/`) | 0 | `Test Files 35 passed (35)` / `Tests 410 passed (410)` |
| 3 | `npm run lint` (`server/`) | 0 | no findings (`eslint "src/**/*.ts"`) |
| 4 | `npm test` (`bread-sheet-app/`, `--ci`) | 0 | `Test Suites: 35 passed, 35 total` / `Tests: 360 passed, 360 total` |
| 5 | **`npm run typecheck` (`bread-sheet-app/`)** | **2** | **24 errors, all in `hooks/use-product-search.test.tsx`** (TS2345 ×7, TS18046 ×13, TS7006 ×4). First: `use-product-search.test.tsx(49,41): error TS2345: Argument of type '({ query }: { query: any; }) => ProductSearchState' is not assignable to parameter of type '(props: unknown) => ProductSearchState'.` |
| 6 | `npm run typecheck` (`bread-sheet-app/`, **on `main`**) | 0 | no output — proves row 5 is introduced by this branch, not pre-existing |
| 7 | `npx tsc --noEmit` (`bread-sheet-app/`) | 0 | app sources alone are clean; this is the command the implementer reported |
| 8 | `npm run lint` (`bread-sheet-app/`) | 1 | 1 error, 0 warnings: `scripts/test-maestro.js 1009:40 error 'Buffer' is not defined no-undef` |
| 9 | `npm run lint` (`bread-sheet-app/`, **on `main`**) | 1 | byte-identical single error — row 8 is pre-existing in an untouched file, **not** a regression. (The implementer reported "1 error + 1 warning"; the warning does not reproduce on either branch.) |
| 10 | `npx prisma migrate deploy` (`server/`, throwaway PG 18.6) | 0 | `All migrations have been successfully applied.` (14 migrations) |
| 11 | `npx prisma migrate status` (`server/`) | 0 | `14 migrations found` / `Database schema is up to date!` |
| 12 | `npx prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --exit-code` | 0 | `No difference detected.` — no drift between `schema.prisma` and the migrated DB |
| 13 | Real-DB AC harness (`tsx`, imports the shipped service unmodified) | 0 | **22/22 checks passed** — see below |
| 14 | Real-app route probe (`tsx`, boots `src/app.ts`, unmocked middleware) | 0 | `GET /api/products/search?q=cola → 401 {"error":"Authorization header missing"}`; `GET /api/products/not-a-uuid → 400 {"code":"invalid_product_id"}`; route chains: `/search → [requireAuth, <anonymous=userLimiter>, searchProductsHandler]` |
| 15 | `npm run test:e2e` (`bread-sheet-app/`) | **not_run** | Prerequisite `supabase start` fails — see "Environment gap" |
| 16 | `npm run test:maestro` (`bread-sheet-app/`) | **not_run** | Prereq check passes (SDK/JDK/Maestro/AVD all present) but the flows need Supabase config — same root cause as row 15 |

### Row 13 — Real-database verification (what the committed tests cannot prove)

Every committed server test mocks `../db.js` (repo-wide convention; CI has no Postgres), so the
`pg_trgm` and visibility claims were re-executed here against a real database. Setup: a throwaway
`docker.io/library/postgres:18-alpine` container (`PostgreSQL 18.6`) on an isolated podman store
(`CONTAINERS_STORAGE_CONF` → vfs driver, graphroot under the session scratch dir, `--network=host`,
port 55432); the user's global podman configuration and default store were not touched, and
everything was removed afterwards. The harness imported
`server/src/services/productSearchService.ts` **unmodified** and seeded 32 products + 4 ratings.

Verified (all `PASS`):

- **Typo tolerance** — `"nutela"` returns `Nutella` with `similarity = 0.6666667`; the matched set
  and scores were `Nutella 0.6666667`, `Nutella Biscuits 0.33333334`, `Hazelnut Spread Jar`
  (brand-only match) `0.03846154`, i.e. ranked `similarity DESC` as documented.
- **`REJECTED` never appears** — for a registered caller *and* for an anonymous one.
- **`PENDING_REVIEW` appears with `unverified: true`** — for the anonymous caller too.
- **Both kinds** — a `CUSTOM`, brand-less product is found by name and carries `kind: 'CUSTOM'` and
  a numeric `similarity` (`1`).
- **Brand-only matches** are returned (name score, not brand score, is reported — as documented).
- **Image resolution** — a stored key serialises to
  `http://127.0.0.1:4566/breadsheet-images-local/processed/nutella.jpg`.
- **Rating-count tiebreak** — two rows with identical names (`similarity = 1`) order 3-ratings
  before 1-rating.
- **Cursor pagination over 25 matches** — page 1 = 20 rows + a `nextCursor`, page 2 = 5 rows +
  `nextCursor: null`, zero overlap, union = all 25 rows (no gaps, no duplicates).
- **Cursor bound to `q`** — replaying page 1's cursor against a different query raises
  `SearchValidationError`.
- **Input hygiene against the live DB** — 99 spaces + `"ab"` (101 raw chars, 2 trimmed) →
  `query_too_long`; `"'); DROP TABLE \"Product\"; --"` returns 0 rows and leaves all 32 rows intact.
- **The GIN index is genuinely usable by `%`** — `pg_extension` lists `pg_trgm`; `pg_indexes` shows
  `Product_name_idx` / `Product_brand_idx` as `USING gin (… gin_trgm_ops)`; with
  `enable_seqscan = off` the plan is
  `Bitmap Heap Scan → Bitmap Index Scan on "Product_name_idx"  Index Cond: (name % 'nutela'::text)`.
  (On the 32-row fixture the default plan is a seq scan, as expected for a table that size.)

### Row 14 — Route ordering, executed rather than inferred

The committed supertest case mocks `requireAuth`/`userLimiter`. To confirm the ordering holds in
the *shipped* middleware chain, the real `src/app.ts` was booted: `/api/products/search` answers
`401` (it reached `requireAuth` on its own route) while `/api/products/not-a-uuid` answers
`400 invalid_product_id`. Had `/search` been shadowed it would have produced the `400` too. The
printed chain also confirms `userLimiter` is mounted between `requireAuth` and the handler.

---

## Blocker 1 (code) — app `typecheck` fails: `hooks/use-product-search.test.tsx`

**Owner: frontend implementer.** Jest passes because it strips types; `tsc -p tsconfig.test.json`
does not. All 24 errors come from `renderHook` being called with an inline destructured props
callback and no type arguments, e.g.

```ts
const { result } = await renderHook(({ query }) => useProductSearch(query, false), {
  initialProps: { query: 'cola' },
});
```

RNTL 14 infers `props: unknown` here, so `{ query }` is unassignable (TS2345) and
`result.current` degrades to `unknown` (TS18046); the `.map((r) => r.id)` callbacks then trip
TS7006. Fix direction (implementer's call): give `renderHook` explicit type arguments
(`renderHook<ProductSearchState, { query: string }>(…)`) or annotate the callback parameter. Then
re-run `npm run typecheck` (**not** `npx tsc --noEmit`) in `bread-sheet-app/` and confirm exit 0.

Nothing else in the diff fails typecheck; no production file is implicated.

## Blocker 2 (environment) — Playwright `test:e2e` cannot be executed here

This was attempted properly, not assumed. Sequence and real output:

1. The user's default rootless podman store is unusable on this host (pre-existing, reproduced):
   `Error: configure storage: kernel does not support overlay fs: 'overlay' is not supported over
   btrfs at "/home/jano/.local/share/containers/storage/overlay"`.
2. Isolated store, **vfs** driver, graphroot under the session scratch dir: works for small images
   (the Postgres container above ran this way) but `supabase start` died pulling
   `supabase/postgres:17.11.0.006` — `creating read-only layer …: no space left on device` (vfs
   duplicates every layer; the 16 GB `/tmp` tmpfs filled).
3. Isolated store, **overlay** driver on the same tmpfs: `Error: configure storage: kernel does not
   support overlay fs: 'overlay' is not supported over tmpfs`. `fuse-overlayfs` is genuinely absent
   (`ls: cannot access '/usr/bin/fuse-overlayfs': No such file or directory`), so there is no
   mount-program fallback.
4. Isolated store, **btrfs** driver (graphroot on the btrfs `/home`): all Supabase images pulled
   successfully — then container start failed:
   `ContainerStartError: failed to start docker container "supabase_db_bread-sheet": setting up
   Pasta: pasta failed with exit code 1: Failed to open() /dev/net/tun: No such device`.
5. Root cause, checked directly rather than inferred: the device node exists
   (`crw-rw-rw- 1 root root 10, 200 /dev/net/tun`) but opening it fails —
   `open failed: [Errno 19] No such device: '/dev/net/tun'`; `lsmod` shows no `tun`,
   `modinfo tun` → `ERROR: Module tun not found`, and there is no
   `/lib/modules/7.3.1-1-cachyos/kernel/drivers/net/tun.ko*`. `slirp4netns` is also not installed,
   and it would need the same device.

**Precise fix needed:** make the `tun` device functional for rootless networking — install the
kernel-module package matching `7.3.1-1-cachyos` that ships `tun.ko` (or a kernel with `CONFIG_TUN`
built in), then `sudo modprobe tun` and persist it via `/etc/modules-load.d/tun.conf`. After that,
the README § "Web E2E (Playwright)" recipe is enough:
`export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock` (and a storage driver that works on
btrfs — `fuse-overlayfs` installed, or `driver = "btrfs"`), `npx supabase@2.122.0 start --exclude …`,
then `EXPO_PUBLIC_SUPABASE_URL=… EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=… npm run test:e2e`.
Alternatively, CI's `e2e` job (`.github/workflows/test.yml:236`) runs this suite on the PR — but it
cannot run before a PR exists, and this reviewer may not open one on a red matrix.

Cleanup performed: the Supabase stack was stopped (`supabase stop --no-backup` →
`Stopped supabase local development setup.`), all containers/images/volumes in the isolated stores
were pruned, both scratch stores and `/home/jano/.cache/p6008-podman-store` were deleted, the
temporary podman API service was killed and its socket removed. `/home` and `/tmp` free space are
back to their pre-run values and `podman ps -a` in the user's own store lists nothing new.

### Maestro (`npm run test:maestro`)

In scope on paper (the diff touches `app/(tabs)/scan.tsx`), and the script exists. Prerequisites
are genuinely present — `MAESTRO_PREREQS_ONLY=1 MAESTRO_SKIP_ENV_CHECK=1 npm run test:maestro`
exits 0 with `Android SDK: /home/jano/Android/Sdk`, `Java: /usr/lib/jvm/java-21-openjdk/bin/java`,
`Maestro: /home/jano/.maestro/bin/maestro`, `using existing AVD "breadsheet-e2e"` — but without the
flag it stops at `ERROR: No Supabase config`, and the reviewer must not read `.env`
(user standing instruction), while a local stack is blocked by the `tun` issue above.

Judged **incidental** to this ticket's deliverable: the scan-tab change is one additive
`TouchableOpacity` (`scan-search-by-name`) plus a `gap: 8` style; no camera, barcode-decode,
permission or rescan-suppression logic changed, no `e2e/maestro/` flow was touched, and the new
affordance's two behaviours (present in every permission state; routes to `/(tabs)` with
`focusSearch: 'all'`) are covered by executed jest tests. It is recorded here as an environment
gap, not fabricated as a pass. It does **not** on its own make this run `BLOCKED`; blockers 1 and 2
do.

---

## Acceptance criteria walk-through

### Slice A — personal search

| AC | Verdict | Evidence |
|---|---|---|
| Search input on Home filters my ratings as I type, no network request | **met** | `home-search-mine.test.tsx` "filters ratings by name as I type, with no network request" asserts the filtered list *and* `expect(mockSearch).not.toHaveBeenCalled()`; the hook is gated by `active=false` in Mine scope |
| Name + brand, case- and diacritic-insensitive, substring | **met** | `match.test.ts` (`cola`→`Coca-Cola`, `CAFE`→`Café Latte`, `artisan`→brand) and the screen-level equivalents |
| Works offline against cached ratings | **met** | `home-search-mine.test.tsx` writes `ratingsCache`, makes `api.get` reject with `NetworkError`, waits for `offline-indicator`, then filters — the cache is the real store over a mocked FS map, not a frozen mock |
| Composes with the category chips | **DEFERRED** (user decision) | P6-003 not built. `filterRatingsByQuery`'s `categoryPredicate` is the AND-composition point and is itself covered (`match.test.ts` "composes with an optional category predicate"), but no chips exist to compose with. **Box left unchecked.** |
| A barcode-less P6-007 item is findable by name | **DEFERRED** (user decision) | P6-007 not built; covered by a `kind: 'CUSTOM'`, `brand: null` fixture at both the matcher and screen level. **Box left unchecked.** |
| Plain string containment, not a regex from user input | **met** | `matchesNameOrBrand` is `String.includes` over normalised strings; the only regex in `match.ts` is the fixed combining-marks class, which never sees user input |
| Empty state distinguishes "no match" from "nothing rated yet" | **met** | Separate branches + testIDs (`home-search-no-match` / `home-search-nothing-rated`); the "nothing rated" test types a query and asserts the copy does **not** change |
| Query does not survive an app restart | **met** | Plain component state; test unmounts and re-renders, asserting the input's `value` is `''` |

### Slice B — global search

| AC | Verdict | Evidence |
|---|---|---|
| `GET /api/products/search` ranked by similarity, cursor-paginated at 20 | **met, executed on real PG** | Row 13: 25-match fixture pages 20 + 5 with no overlap and full coverage; ranking order observed |
| `REJECTED` never appears | **met, executed on real PG** | Row 13, for registered and anonymous callers |
| `PENDING_REVIEW` appears flagged `unverified`, anonymous included | **met, executed on real PG** | Row 13 |
| Both kinds, each carrying `kind` + `similarity`, same visibility helper | **met** | Row 13 (`CUSTOM` found, `kind`/`similarity` present); the predicate is `INVISIBLE_PRODUCT_STATUS` from `productVisibility.ts`, bound as a parameter — `productSearchService.test.ts` asserts the constant is in `values` and the literal `REJECTED` is *not* in the SQL text |
| `q` capped at 100 raw chars (pre-trim), rejected below 2 trimmed; no user input in a regex or raw SQL fragment | **met** | Row 13 (`query_too_long` for 101 raw/2 trimmed; injection-shaped query bound as a parameter, table intact). Client mirrors it in `isSearchableQuery` + `maxLength={100}` |
| A `pg_trgm` GIN index backs the query; the migration creates extension + index | **met, executed** | Rows 10–13: `pg_extension` lists `pg_trgm`; both GIN indexes exist; `EXPLAIN` with `enable_seqscan=off` uses `Product_name_idx` for `name % 'nutela'` |
| Typo tolerance: "nutela" returns "Nutella" | **met, executed** | Row 13, `similarity = 0.6666667` |
| Rate-limited, and integration tests incl. the visibility matrix | **met** (limiter structurally) | `userLimiter` is on the route and visible in the live chain (row 14). No test in this repo exercises any limiter's 429 — `userLimiter` is stubbed in all seven controller suites, a pre-existing convention; recorded as a follow-up rather than held against this ticket. The visibility matrix is covered at both the service (mocked) and real-DB level |
| Input debounced, superseded requests cancelled | **met** | `use-product-search.test.tsx` holds the first request's promise open, asserts `firstSignal.aborted === false`, rerenders with a new query, asserts `aborted === true`, then resolves the stale promise and asserts its results never land. Real `AbortController`; only the network boundary is mocked. Plus `lib/api.test.ts`: `signal` reaches `fetch`, and an `AbortError` is rethrown unwrapped |
| Global scope reports offline and points back to the working personal scope | **met** | `home-search-all.test.tsx` "reports being offline and offers switching back to Mine" presses `home-search-switch-to-mine` and asserts the Mine pill's `accessibilityState.selected` flipped; copy is `OFFLINE_MESSAGE` via the `isOffline` branch |
| Global results are not cached | **met** (by inspection of absence) | `hooks/use-product-search.ts` and the All-scope render path import nothing from `lib/offline/*`; results live in component state and are dropped when the scope or query changes |

## Test-quality review (per guardrails: "what production bug would this fail on?")

Checked specifically for mocks that freeze state the code under test mutates:

- **`AbortController` — real, not mocked.** The cancellation test would fail if the hook dropped
  the `controllerRef.current?.abort()` from its cleanup, and *separately* if it stopped re-checking
  `signal.aborted` before `setResults` (the late-resolve assertion). Good coverage.
- **Ratings cache — real store.** `home-search-mine.test.tsx` uses the actual
  `lib/offline/store` + `ratingsCache` over a mocked `expo-file-system/legacy` map that does
  reflect writes, so the offline test would fail if the screen stopped reading the cache.
- **`$queryRaw` mock — flattening reconstructed.** `productSearchService.test.ts` re-runs the
  captured tagged-template arguments through `Prisma.sql` so the assertions are about the SQL the
  driver would really receive; the "hostile `q` is a bound value, not text" test would fail on any
  future switch to string concatenation. This is the right shape for a mock-boundary test, and the
  claims it *can't* make are exactly the ones row 13 executes.
- **One weak spot (minor, non-blocking):** in `home-search-all.test.tsx` → "scan tab hand-off",
  `mockRouter.setParams` is a `jest.fn()` that does not mutate `mockParams`, so the mock freezes
  the state the code mutates. The test still means something (it asserts the clear was *called*),
  and re-triggering is independently prevented by the `consumedFocusSearch` ref, so no production
  bug hides here today. Recorded as a follow-up, not a blocker.
- **One placeholder test:** `home-search-mine.test.tsx` → "composes with the category chips —
  deferred (TICKET-P6-003 not built)" is `expect(true).toBe(true)`. Honest about being deferred,
  but it is a green test that proves nothing; the real composition coverage is in `match.test.ts`.
  Suggest deleting it when P6-003 lands (follow-up).

## Documentation review

`CLAUDE.md`, `docs/architecture/backend.md` (new § Product Search), `docs/architecture/frontend.md`
(new § Search), `docs/bruno/Products/search-products.bru` and `docs/bruno/environments/local.bru`
are all present, and the technical claims I spot-checked against the running database hold exactly
(`similarity('nutela','nutella') ≈ 0.667`, threshold `0.3`, index names, route-ordering rationale,
`CREATE EXTENSION` ordering). No ADR is warranted — ADR 0006 already covers the model this
endpoint reads, and nothing here is a new architectural commitment.

**One correction needed (backend implementer, one line):** `CLAUDE.md`'s new backend paragraph
opens with *"Product search (P6-008 Slice B — backend only; Slice A, the client-side 'Mine' scope,
is not part of this ticket)"*. Slice A **is** part of TICKET-P6-008 and shipped on this very
branch; the parenthetical reads as if it were out of scope for the ticket rather than merely out of
scope for the backend. Suggest "…— the backend half; Slice A's client-side 'Mine' scope is in
`docs/architecture/frontend.md`". Everything else in the doc diff is accurate.

## Follow-ups (not implemented here)

1. **Give the `server` CI job a Postgres service** so the `pg_trgm` behaviour, the visibility
   filter and the trigram/partial indexes are verified continuously instead of once by hand. Row 13
   is a reviewer-run harness and is deliberately *not* committed — nothing in the repo protects
   these claims from regression. `docs/architecture/backend.md` records the same follow-up. Per the
   repo's convention this belongs in `FEATURES.md` as a ticket, but a reviewer's `FEATURES.md`
   write scope is this ticket's checkboxes only (guardrails § Scope), so it is filed here for the
   coordinator/human to promote.
2. **Fix the host so `test:e2e`/`test:maestro` can run locally** — see "Blocker 2" for the exact
   `tun` fix. Unblocks the Maestro suite too.
3. **Make the `focusSearch` hand-off test's `setParams` mock mutate `mockParams`**, so the
   consumed-once behaviour is covered by state rather than by a call assertion.
4. **Drop the `expect(true).toBe(true)` placeholder** when P6-003 lands and the real chip
   composition can be asserted end-to-end.
5. **No limiter is exercised by any test in the repo** (`userLimiter` is stubbed in all seven
   controller suites). One shared test that drives a limiter to `429` would turn "rate-limited"
   from a structural claim into an executed one, for this endpoint and the ~20 others.
6. **Brand-only matches rank last by construction** — `similarity` is always name-vs-query, so a
   row matched purely on `brand` scores near 0 (observed `0.038`) and sorts below every weak name
   match. Intentional and documented (P6-007's "Did you mean …?" needs the name score), but if
   brand search is meant to feel first-class, ranking by `GREATEST(similarity(name,q),
   similarity(brand,q))` while still *returning* the name score is the cheap improvement.

## Open questions for the implementers

- **Frontend:** blocker 1 only. Is there a reason `tsconfig.test.json` was not part of your
  verification loop (e.g. you ran `npx tsc --noEmit` deliberately)? If so, note it — `npm run
  typecheck` is what CI runs, so that is the command the matrix is judged on.
- **Backend:** the `CLAUDE.md` wording correction above. No code changes requested; Slice B passed
  every criterion, including on a real database.
- **Neither:** nothing in blocker 2 is a code defect. After blocker 1 is fixed, this ticket needs a
  single `npm run test:e2e` run on a machine with working rootless container networking (or a
  deliberate human decision to let CI's `e2e` job be that run, on a PR opened by a human) before
  the boxes can be ticked.

## Boxes checked in `FEATURES.md`

**None.** The matrix is not green (blockers 1 and 2), so per guardrails § Documentation no
acceptance-criteria box was ticked and no PR was opened. The two DEFERRED criteria would stay
unchecked regardless, by the user's decision.
