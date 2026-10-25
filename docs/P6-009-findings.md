# TICKET-P6-009 Findings — Product Model Split (Slim `Product` + `PackagedProduct`)

This doc is filled in by the backend implementer (this section) and the frontend implementer,
then checked by the reviewer against the full test matrix. See `docs/P6-009-implementation-plan.md`
for the plan this run followed.

## Backend (server/)

### Summary

Implemented ADR 0006 / the plan's work items B1–B7 in full. `Product` is now the slim, server-identified
thing that gets rated; `PackagedProduct` holds the GTIN, nutrition and ingredient columns 1:1 by
`productId`. Every product route is keyed by `Product.id` (UUID), `GET /api/products/gtin/:gtin` is the
only way to resolve a GTIN, `ProductEdit.productId` replaces `ProductEdit.barcode`, and a new
`productVisibility` helper is the single place the `REJECTED`-is-invisible rule lives.

### Files changed

**Schema / migration**
- `server/prisma/schema.prisma` — `ProductKind` enum, slim `Product`, new `PackagedProduct`,
  `ProductEdit.productId` (FK → `Product.id`), index/partial-unique-index renamed.
- `server/prisma/migrations/20261025150342_product_model_split/migration.sql` — hand-edited (per the
  plan's SQL sketch) to backfill `PackagedProduct` and `ProductEdit.productId` from the existing rows
  before dropping anything, so no data is lost. Generated via `prisma migrate dev --create-only`
  (needed a pty — the sandboxed shell reports non-interactive — see "Environment notes" below), then
  rewritten by hand.
- `server/scripts/verify-product-split.sql` — new, read-only verification script (see "Migration
  verification" below).

**New services/validators**
- `server/src/services/productVisibility.ts` — `visibleProductWhere(user)` / `assertProductVisible(user, id)`
  / `ProductNotFoundError`.
- `server/src/services/productSerializer.ts` — `serializeProduct(product, user)`, the explicit
  allowlist described in the plan's decision 2.
- `server/src/validators/idValidator.ts` — `isValidUuid`, a bounded, ReDoS-safe UUID check shared by
  route `:productId` validation and the `POST /api/ratings` body check.

**Rewritten services**
- `server/src/services/productService.ts` — `fetchFromOpenFoodFacts(gtin)`, `createSubmittedProduct`
  writes `Product` + `PackagedProduct` in one transaction across all five resubmission branches; error
  classes carry `gtin` instead of `barcode`.
- `server/src/services/productVerificationService.ts` — `castVote(productId, ...)`, the product lookup
  now goes through `visibleProductWhere()` so a vote on a `REJECTED` product 404s instead of 409ing.
- `server/src/services/productEditService.ts` — `PRODUCT_EDIT_FIELDS` / `PACKAGED_EDIT_FIELDS` partition
  the editable fields; `correctPendingProduct`, `createEdit`, `getPendingEdit` and `castEditVote` all
  read/write through both tables as needed, in one transaction; `getPendingEdit` now asserts visibility
  first (404 for a `REJECTED` product, where it previously did no existence check at all).

**Rewritten controllers/routes**
- `server/src/controllers/productController.ts` — new `getProductByGtin` (OFF fetch + two-table create,
  `P2002` race → re-read instead of 409) and `getProductById`; both serialize via `productSerializer`.
- `server/src/controllers/productEditController.ts`, `ratingController.ts` — re-keyed to `productId`;
  `getMyRatingForProduct` and its route deleted; rating responses embed `{ id, kind, name, brand, image }`
  via an explicit `select`, not the full row.
- `server/src/routes/productRoutes.ts` — `router.param('productId', ...)` validates the UUID shape
  (`400 { code: 'invalid_product_id' }`); `GET /gtin/:gtin` registered before `GET /:productId`.
- `server/src/routes/ratingRoutes.ts` — same `productId` param validation; `GET /me/:barcode` removed.

**Tests** — every existing suite touched by the rename was rewritten to the new shapes (not just
mechanically re-keyed): `productService.test.ts`, `productVerificationService.test.ts`,
`productEditService.test.ts`, `productController.test.ts`, `productEditController.test.ts`,
`verifyProduct.test.ts`, `ratingController.test.ts`, `productSubmissionValidator.test.ts`. New:
`productSerializer.test.ts` (allowlist leak test, CUSTOM → `packaged: null`, anonymous vs registered
`submittedByUserId`), `productVisibility.test.ts`, `idValidator.test.ts`. New cases added per the
plan's B6 list: GTIN concurrent-create race, non-UUID `:productId` → 400, a rating without `productId`
→ 400, the visibility test (`REJECTED` → 404 on `GET /:productId`, `POST /ratings`, `/verify`, `/edits`,
`/edits/pending`), and an edit spanning both tables applying both updates in one transaction.

**Docs (backend half, per the coordinator's assignment)**
- `CLAUDE.md` — backend/data-model paragraphs only (data model, `requireRegistered` route list, image
  URL resolution, product visibility, new product-serialization paragraph, product editing & peer
  review, ADR 0006 status line). Frontend-owned paragraphs (route list, offline cache, manual-entry,
  leaving-the-rating-flow) were left to the frontend implementer, who has already updated them in this
  worktree.
- `docs/architecture/backend.md` — data model table, both endpoint tables, product submission section,
  peer verification section, image URL section.
- `docs/architecture/data.md` — ER diagram and the submission-fields row now show the split.
- `docs/architecture-decision-records/0006-product-model-split.md` — status flipped to
  *Accepted — implemented*.
- `docs/bruno/` — new `Products/lookup-by-gtin.bru` (stores `productId` from the lookup in a
  post-response script); `Products/get-product-by-barcode.bru` renamed to `get-product-by-id.bru`;
  `approve-product.bru`, `reject-product.bru`, `correct-product.bru`, `propose-product-edit.bru`,
  `get-pending-edit.bru`, `submit-product.bru`, `Ratings/create-or-update-rating.bru`,
  `Ratings/get-ratings-for-product.bru` all re-keyed; `Ratings/get-my-rating-for-product.bru` deleted
  (endpoint removed); `environments/local.bru` renamed `barcode` → `gtin` and added `productId`.
- I did **not** touch `docs/architecture/frontend.md` (frontend-owned) — the frontend implementer should
  confirm its product-screen / offline-cache / resolver sections match what was actually built here.

### Contract divergences from the plan

1. **`GET /api/ratings/product/:barcode` was re-keyed to `:productId`, not left untouched.** The plan's
   backend section says "`GET /ratings/product/:barcode` is left alone; P6-002 deletes it," but that
   route's implementation does `prisma.product.findUnique({ where: { barcode } })`, and `Product.barcode`
   no longer exists after this migration — the route could not have kept working unmodified. I re-keyed
   it to `/ratings/product/:productId` (with the same `router.param` UUID validation as every other
   product-id route) rather than leave it broken. This route is not called by the app today (confirmed by
   grep before starting) and is not part of the user's explicit API contract list, so I believe this is a
   mechanical necessity rather than a scope decision, but flagging it for the reviewer since the plan
   text said something different.
2. Everything else matches the user's stated contract (`GET /products/gtin/:gtin`; `GET|PATCH
   /products/:productId`, `/verify`, `/edits`, `/edits/pending`; the product body shape with nested
   `packaged`; `POST /products` taking `gtin` and returning `{ id, gtin, status }`; `POST /ratings` taking
   `{ productId, taste, comment? }`; `GET /ratings/me/:barcode` deleted; `PendingEdit.barcode` renamed
   `productId`) exactly as specified.

### Migration verification (server/scripts/verify-product-split.sql)

Run against local Postgres (`podman compose up -d db`) with seeded data: 2 `Product` rows (one
`VERIFIED`, one `PENDING_REVIEW`), 1 `Rating`, 1 `ProductVerification`, 1 `PENDING` `ProductEdit`.

**Before migration** (`prisma migrate deploy` applied only through `20260909142530_gemini_daily_usage`):

```
=== Baseline row counts (meaningful both before and after) ===
 product_count         | 2
 product_edit_count     | 1
 rating_count            | 1
 product_verification_count | 1

=== Post-migration sections (expected to error — PackagedProduct/productId don't exist yet) ===
ERROR:  relation "PackagedProduct" does not exist
ERROR:  column p.kind does not exist
ERROR:  column "kind" does not exist
ERROR:  column "productId" does not exist (x2)
ERROR:  column "productId" of relation "ProductEdit" does not exist
```

**After `prisma migrate deploy` applied `20261025150342_product_model_split`:**

```
=== Baseline row counts (meaningful both before and after) ===
 product_count              | 2
 product_edit_count         | 1
 rating_count                | 1
 product_verification_count  | 1

=== Post-migration: Product <-> PackagedProduct 1:1 for every PACKAGED row ===
 packaged_product_count | 2
 packaged_without_row   | 0
 non_packaged_count     | 0

=== Post-migration: ProductEdit re-keyed with no data loss ===
 product_edit_null_product_id | 0
 product_edit_dangling_fk     | 0

=== Post-migration: one_pending_edit_per_product rejects a second PENDING row ===
BEGIN
ERROR:  duplicate key value violates unique constraint "one_pending_edit_per_product"
DETAIL:  Key ("productId")=(aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) already exists.
ROLLBACK
```

Every row count matches (2 products = 2 PackagedProduct rows, 1 ProductEdit unchanged, 1 Rating
unchanged, 1 ProductVerification unchanged), zero `ProductEdit.productId` nulls or dangling FKs, every
row is `PACKAGED`, and the rebuilt partial unique index correctly rejects a second `PENDING` edit for the
same product inside a transaction that is then rolled back (no data was actually changed by the check).
`prisma migrate deploy` run a second time afterward reports "No pending migrations to apply" and `prisma
migrate status` reports "Database schema is up to date!" — the migration is idempotent/safe to re-run as
`dev`'s `start.sh` does on every deploy.

### Test / lint / typecheck results

| Command | Result |
|---|---|
| `cd server && npm run typecheck` | **PASS** — 0 errors |
| `cd server && npm test` | **PASS** — 33 test files, 374 tests |
| `cd server && npm run lint` | **PASS** — 0 errors/warnings |
| Migration verify script, before `migrate deploy` | **PASS** (baseline counts correct; post-migration sections error as expected, documented above) |
| Migration verify script, after `migrate deploy` | **PASS** (all counts match, invariant holds) — see above |
| `prisma migrate deploy` run twice | **PASS** — idempotent, "No pending migrations to apply" |

I did not run the frontend suites (`bread-sheet-app/`), Playwright, or Maestro — those are the frontend
implementer's / reviewer's responsibility per the guardrails (backend role only edits/tests `server/`).

### Environment notes

- Container runtime: podman. Started with `GCLOUD_ADC_PATH=/tmp/noop.json podman compose up -d db`
  (the compose file's `GCLOUD_ADC_PATH` interpolation errors with an empty value under podman-compose;
  pointing it at any path, even a non-existent one, satisfies the interpolation and only the `db` service
  was needed for this ticket).
- `prisma migrate dev --create-only` reports "Prisma Migrate has detected that the environment is
  non-interactive" under this sandbox's shell even with `yes | ...` piped in (it checks `isTTY`, not just
  stdin content). Wrapping the command in `script -qefc '...' /dev/null` allocates a pty and lets the
  interactive confirmation prompt succeed. Recorded here in case another agent hits the same wall.
- `psql` is not installed on the host; verification queries were run via `podman exec -i
  bread-sheet-agent-p6-009-db-1 psql -U admin -d breadsheet -f ...` against the containerized Postgres.

### Left out of scope (per the ticket's scope guards)

- No custom-product creation, `nameKey`, search, allergens, or OFF sync — `kind: CUSTOM` exists in the
  enum and `serializeProduct`/`productEditService` handle a `packaged: null` row correctly (tested), but
  nothing creates one yet.
- `GET /ratings/product/:productId` was kept working (see divergence #1) but not otherwise extended;
  P6-002 still owns its eventual removal.
- Did not add any legacy/compat shim anywhere — this is a clean break, per the ticket's explicit
  instruction and the "no users yet" project context.

---

## Frontend (bread-sheet-app/)

### Summary

Implemented the plan's work items F1–F10 in full against the backend's actual contract (confirmed by
reading `productSerializer.ts`, `productRoutes.ts`, `ratingController.ts` and
`productEditController.ts` directly — no divergence found; the frontend matches `{ id, kind, name,
brand, image, description, status, unverified, submittedByUserId?, packaged: {...} | null,
submission? }`, `POST /api/products` taking `gtin` and returning `{ id, gtin, status }`, `POST
/api/ratings` taking `{ productId, taste, comment? }`, and `PendingEdit.productId`). The product route
is re-keyed from `product/[barcode]` to `product/[id]`, with a new `product/gtin/[gtin]` resolver that
owns every code-shaped state (invalid/not-found/offline-uncached) — moved verbatim, `testID`s included,
from the old barcode-keyed screen. `edit-product` and `review-product` are re-keyed to `[id]`;
`review-edit` takes `productId` instead of `barcode`. The `products` offline cache is keyed by id with a
`gtin → id` index; `ratings`, the outbox, `use-my-rating`, `use-recent-products` and `RatedProduct` all
key by `productId`/`id`. `CACHE_SCHEMA_VERSION` bumped `1 → 2`.

### Files changed

**Types / API client**
- `features/products/types.ts` — `ProductSubmission.barcode` → `gtin`; new `PackagedDetails`,
  `ProductKind`; `ProductDetail` now `{ id, kind, ..., packaged: PackagedDetails | null }` (no top-level
  nutrition); `PendingEdit.barcode` → `productId`.
- `features/products/api.ts` — new `lookupProductByGtin(gtin)`, `getProduct(id)`; `submitProduct`
  returns `{ id, gtin, status }`; `approveProduct`/`rejectProduct`/`correctProduct`/
  `proposeProductEdit`/`getPendingEdit` take `id` instead of `barcode`; `correctProduct`'s return type
  corrected to `ProductDetail` (the server returns the full serialized product from `PATCH`, not
  `{ id, status }`).
- `features/products/edit-form.ts` — `productToFormValues` reads nutrition/ingredient fields from
  `product.packaged` (null-safe) instead of the top level.
- `features/ratings/types.ts` — `RatedProduct`: `barcode` dropped, `kind` added.

**Offline layer**
- `lib/offline/store.ts` — `CACHE_SCHEMA_VERSION` `1 → 2`.
- `lib/offline/caches.ts` — `products` document is now `{ byId, gtinIndex }`; `productCache(id)`;
  new `peekProductIdByGtin` / `readProductIdByGtin`; LRU eviction drops an evicted id's index entry
  with it; `findCachedRating` / `upsertCachedRating` compare `product.id`; `StoredRecentProduct` is
  `{ id, name, brand, image, viewedAt }`.
- `lib/offline/outbox.ts` — `OutboxRating`/`OutboxFailure` keyed by `productId`; `enqueueRating`,
  `runFlush`'s `POST /api/ratings` body and cache-write guard all re-keyed.
- `hooks/use-outbox.tsx`, `hooks/use-my-rating.ts`, `hooks/use-recent-products.tsx` — re-keyed to
  `productId`/`id` throughout (`RecentProduct.barcode` → `id`).

**Routes**
- `app/(app)/product/[barcode].tsx` deleted; new `app/(app)/product/[id].tsx` — fetches by id, drops
  the invalid/not-found/offline-uncached states (moved to the resolver), adds a plain id-`404` state
  (testID `product-id-not-found`, "Back to Home", no add-product action — an id has no GTIN to add),
  reads the barcode chip from `product.packaged?.gtin` (omitted when `packaged` is `null`), and keys
  every downstream call (`getPendingEdit`, `POST /api/ratings`, `enqueue`, `isQueued`, recents,
  edit/review navigation) by `product.id`.
- New `app/(app)/product/gtin/[gtin].tsx` — the resolver described in the plan's decision 3. On mount:
  cache-index hit → `router.replace` with no network call; miss → `lookupProductByGtin`, write-through
  the id-keyed cache (populating the index), replace; `400`/`404`/`NetworkError`/other error render the
  states moved verbatim from the old barcode screen (JSX and `testID`s unchanged: `product-invalid-barcode`,
  `product-not-found`(-add/-signup), `product-offline`(-retry), `product-error`). A `retry` counter
  re-runs the resolve effect for the offline/error "Try again" buttons.
- `app/(app)/_layout.tsx` — registers `product/gtin/[gtin]`, `product/[id]`, `review-product/[id]`,
  `edit-product/[id]` (and keeps `add-product`, `review-edit/[editId]`).
- `app/(app)/edit-product/[barcode].tsx` → `edit-product/[id].tsx` (`git mv`) — fetches via
  `getProduct(id)`; barcode field renders `product.packaged.gtin` and is omitted entirely when
  `packaged` is `null`; `correctProduct`/`proposeProductEdit` and the post-submit `router.replace` all
  use `id`.
- `app/(app)/review-product/[barcode].tsx` → `review-product/[id].tsx` (`git mv`) — same treatment;
  `approveProduct`/`rejectProduct`/`getProduct` take `id`; the barcode line reads
  `product.packaged.gtin` and is omitted for a `CUSTOM` product.
- `app/(app)/review-edit/[editId].tsx` — param renamed `barcode` → `productId`; `getPendingEdit` and
  the post-action `router.replace` use it.
- `app/(app)/add-product.tsx` — param `barcode` → `gtin` throughout (local state renamed `gtinInput`/
  `setGtinInput`, `ReviewStep` prop renamed `gtin`/`setGtin`); submission payload sends `gtin`;
  `onSubmitted(result.id)` replaces into `product/[id]`. The `field-barcode` `testID` and "Barcode"
  label are kept verbatim per the plan (that's what the user sees and types).
- `components/manual-barcode-sheet.tsx` — default `onSubmit` now routes to `/(app)/product/gtin/<code>`
  (callers that pass their own `onSubmit`, e.g. the resolver's invalid-code retry, are unaffected).
- `app/(tabs)/scan.tsx` — `processScan`'s success path routes to `/(app)/product/gtin/<code>` instead
  of `/(app)/product/<code>`.
- `app/(tabs)/index.tsx` (Home) — rating cards and recents navigate to `/(app)/product/<id>` (not the
  resolver — these ids are already known, so going through the GTIN resolver would be a pointless
  extra hop); `rating-pending-sync-<id>` testID; `isQueued`/recents keyed by `id`.

### Tests

- Renamed/rewrote `product-screen.test.tsx`, `product-screen-edit.test.tsx`,
  `product-screen-offline.test.tsx` for `product/[id]` (the 400/404/offline-uncached cases moved out;
  new cases: id-`404` plain dead end with no add-product CTA, barcode chip shown for `PACKAGED` /
  omitted for `CUSTOM`, ratings posted with `productId`).
- New `app/(app)/product/gtin/product-gtin-resolver.test.tsx`: cached-index hit skips the network;
  network hit writes the cache (with its gtin index) and redirects; `400`/`404`/offline/generic-error
  states and their retry buttons; guest-gate `returnTo` carries `/product/gtin/<gtin>`.
- `lib/offline/caches.test.ts`, `outbox.test.ts`, `hooks/use-recent-products.test.tsx` — re-keyed to
  `id`/`productId`; added a case asserting the gtin index is written with the product and evicted with
  it under LRU.
- `edit-form.test.ts`, `edit-product.test.tsx`, `review-product.test.tsx`, `review-edit.test.tsx`,
  `add-product.test.tsx`, `home-screen.test.tsx`, `scan-screen.test.tsx`,
  `manual-barcode-sheet.test.tsx` — all re-keyed to the new shapes/routes. Added: a `CUSTOM`-product
  case to `review-product.test.tsx` (no barcode chip) mirroring the product screen's.
- No test file needed new jest-expo shims; `jest.mock('@/lib/api')` continues to keep `ApiError`/
  `NetworkError` as real classes.

### Scope guard compliance

Per the ticket's explicit scope guard, nothing creates a `CUSTOM` product. The only `CUSTOM` code paths
added are "`packaged` is null → render no barcode-chip/nutrition UI" on the product, edit-product and
review-product screens, each with a test. No custom-product creation UI, `nameKey`, search or
allergens were touched.

### Test / lint / typecheck / e2e results

| Command | Result |
|---|---|
| `cd bread-sheet-app && npm test` | **PASS** — 30 suites, 309 tests |
| `cd bread-sheet-app && npx tsc --noEmit` | **PASS** — 0 errors |
| `cd bread-sheet-app && npm run lint` | **PASS** — 0 errors/warnings |
| `cd bread-sheet-app && MAESTRO_PREREQS_ONLY=1 npm run test:maestro` | **BLOCKED (environment gap)** — see below |
| `cd bread-sheet-app && npx playwright test` | **BLOCKED (environment gap)** — see below |

**Maestro.** `MAESTRO_PREREQS_ONLY=1 npm run test:maestro` exits with: *"No Supabase config. The flows
sign in as guest and look up a product, so they need a reachable Supabase project... Either export
EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY in your shell... or copy
bread-sheet-app/.env.example → .env and fill them in."* This worktree has neither (fresh checkout, no
`.env`, and the coordinator's instructions block Bash commands touching `.env*` files), so I could not
supply Supabase credentials to get past this check — it never reached the Android-SDK/emulator/JDK
checks the prerequisite script also performs, so I have **no evidence either way** about whether an AVD
is present. This is an environment gap on the ticket's own deliverable (the diff touches `scan.tsx` and
`manual-barcode-sheet.tsx`), so per the guardrails this is `BLOCKED`, not a footnote under a pass — the
reviewer (or a run with real Supabase credentials exported) needs to execute this for real.

**Playwright.** Ran `npx playwright test` for real (not just a prereq check) against the installed
Chromium (`1.64.1`, browsers already present). Both specs failed identically after a 30 s timeout
waiting for "Continue as Guest"; the captured page snapshot shows Expo's error overlay with `Uncaught
Error: Supabase URL and Publishable Key are required.` thrown from `lib/supabase.ts:10`, i.e. the exact
same missing-credentials gap as Maestro, not a regression from this change (neither spec touches a
product/barcode/gtin route at all — `auth.spec.ts` only reaches the Home tab, `scan-tab.spec.ts` only
asserts the camera-permission prompt). Also `BLOCKED` for the same reason as above; killed the orphaned
`expo start --web` process afterward and confirmed port 8081 is clear.

### Divergence noted, not acted on

`docs/architecture/data.md:210` still reads `GET /products/:barcode` in a sentence about
`submittedByUserId` visibility (backend-owned file, not touched here) — a one-line leftover from before
the backend's own pass finished updating that file. Flagging for the reviewer; not fixed here because
`data.md` is outside the frontend docs this run owns per the coordinator's split.

### Left out of scope (per the ticket's scope guards)

- No custom-product creation, `nameKey`, search, allergens, or OFF sync UI.
- No legacy `{ barcode }` rating payload, no digits-only alias, no client redirect for stale
  `/product/<gtin>` paths, no outbox carry-over — clean break, per the ticket's explicit instruction.
- Did not touch `docs/bruno/`, `docs/architecture/backend.md`, `docs/architecture/data.md`, or the ADR
  0006 status line — backend-owned per the coordinator's split, and already done in this worktree.
- Did not tick the `FEATURES.md` acceptance boxes — that's the reviewer's job once the full matrix is
  green, including the two `BLOCKED` e2e rows above.

---

## Reviewer verdict — **BLOCKED** (one blocker, mechanical)

**Reviewed:** `git diff main...HEAD` — commits `4943d71` (backend) and `1d25f63` (frontend), 84 files,
+3492 / −1371. **Date:** 2026-10-25.

The implementation is sound. The schema split, the hand-edited data-preserving migration, the
serializer allowlist, the visibility helper, the route re-keying and the GTIN resolver all match ADR
0006 and `docs/P6-009-implementation-plan.md`. I did not take the implementers' evidence on trust:
the migration was re-verified from scratch on my own seeded database, the re-keyed API was exercised
live against a running server and a real Postgres, and **both Maestro flows were executed on a real
Android emulator against that server** — the two e2e rows the implementers had to record as
unrunnable are now green, because the Supabase config was supplied (user-provided, passed inline on
the test commands; nothing written to any file).

**One thing blocks the merge:** `bread-sheet-app` no longer typechecks. It is a two-line test-fixture
fix (B-1), not a design problem, and nothing else in the matrix is red.

### Test matrix — what was actually run

| # | Command (cwd) | Exit | Observed |
|---|---|---|---|
| 1 | `npm run typecheck` (`server/`) | 0 | PASS — 0 errors |
| 2 | `npm run lint` (`server/`) | 0 | PASS — 0 errors/warnings |
| 3 | `npm test` (`server/`) | 0 | PASS — 33 test files, 374 tests, 986 ms |
| 4 | `npm run typecheck` (`bread-sheet-app/`) | **2** | **FAIL — 2 × TS2345** → B-1 |
| 5 | `npm run lint` (`bread-sheet-app/`) | 0 | PASS — 0 errors/warnings |
| 6 | `npm test` (`bread-sheet-app/`) | 0 | PASS — 30 suites, 309 tests, 16.5 s |
| 7 | `npm run typecheck` (`bread-sheet-app/`, **on `main`**) | 0 | PASS — baseline, so row 4 is a regression of this branch |
| 8 | `npx playwright test` (no Supabase config) | 1 | 2 failed — `Supabase URL and Publishable Key are required.` (reproduced the implementers' gap) |
| 9 | `npx playwright test` (user-provided Supabase config, passed inline) | **0** | **PASS — 2 passed (4.5 s)**: `auth.spec.ts`, `scan-tab.spec.ts` |
| 10 | `MAESTRO_PREREQS_ONLY=1 npm run test:maestro` (config inline) | **0** | **PASS** — SDK `/home/jano/Android/Sdk`, JDK 21, Maestro `/home/jano/.maestro/bin/maestro`, existing AVD `breadsheet-e2e` |
| 11 | `npm run test:maestro` (**full run**, config inline, `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000`) | **0** | **PASS — 2/2 Flows Passed in 46 s**: `[Passed] manual-entry (26s)`, `[Passed] barcode-scan (20s)` |
| 12 | Live API probe of every re-keyed route against a running server + real Postgres | — | PASS — table below |
| 13 | `verify-product-split.sql`, pre-migration, reviewer's own seeded DB | — | PASS — baseline counts; post-migration sections error as designed |
| 14 | `verify-product-split.sql`, post-migration, same DB | — | PASS — all invariants hold, plus a row-level payload check |
| 15 | `prisma migrate diff --from-config-datasource --to-schema` vs the migrated DB | **0** | PASS — *"No difference detected"* (no schema/migration drift) |
| 16 | `prisma migrate deploy` + `migrate status` on an empty DB | 0 | PASS — all 13 migrations apply; *"Database schema is up to date!"* |

### The blocker

**B-1 — `bread-sheet-app` `npm run typecheck` exits 2.**

```
app/(app)/product/product-screen-offline.test.tsx(116,42): error TS2345: Argument of type
  '{ id: string; kind: "PACKAGED"; …; packaged: { gtin: string; }; }' is not assignable to
  parameter of type 'ProductDetail'.
  Types of property 'packaged' are incompatible.
    Type '{ gtin: string; }' is missing the following properties from type 'PackagedDetails':
      genericName, energyKcal, fat, saturatedFat, and 6 more.
app/(app)/product/product-screen-offline.test.tsx(146,42): error TS2345: (identical)
```

The `PRODUCT` fixture in that file sets `packaged: { gtin: '0000000000001' }`, but the new
`PackagedDetails` in `features/products/types.ts` requires all eleven fields. The two call sites are
`await productCache(PRODUCT.id).write(PRODUCT)` at lines 116 and 146.

**It is a regression, not pre-existing:** the same command on `main` exits 0 (row 7). It slipped
through because the frontend section above records `npx tsc --noEmit`, which only covers
`tsconfig.json`. The documented command is `npm run typecheck` =
`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`, and the error lives in a test
file — only the second half sees it. Jest transpiles without typechecking, so `npm test` stayed green.

*Fix:* expand that fixture's `packaged` to a full `PackagedDetails`. The resolver test's own `PRODUCT`
constant (`product-gtin-resolver.test.tsx:81-93`) is already in exactly the right shape and can be
copied verbatim. Then re-verify with `npm run typecheck`, **not** `npx tsc --noEmit`.

### Live verification of the re-keyed API (row 12)

Method: the worktree's server started on port 3000 with inline non-secret local values
(`DATABASE_URL` → the podman Postgres database `p6009_fresh`, migrated from empty by
`prisma migrate deploy`; `DB_SSL=disabled`, `VISION_MODE=mock`, `PLAUSIBILITY_MODE=mock`,
`S3_MODE=localstack`), plus an anonymous Supabase session for the bearer token. Not mocks — real
HTTP, real Prisma, real Postgres, a real Open Food Facts fetch.

| Request | Expected | Got |
|---|---|---|
| `GET /api/products/gtin/4006381333931` (cold, OFF fetch) | 200, new body shape | **200** `{"id":"bc689b4f-…","kind":"PACKAGED","name":"…","status":"VERIFIED","unverified":false,"packaged":{"gtin":"4006381333931",…}}` — nutrition nested, **no** `submittedByUserId` for an anonymous caller |
| DB state immediately after | both rows, one transaction | **1 `Product` (`kind=PACKAGED`) + 1 `PackagedProduct` (`gtin=4006381333931`)**, same `productId` |
| `GET /api/products/bc689b4f-…` | 200, same body | **200**, identical serialization |
| `GET /api/products/not-a-uuid` | 400 `invalid_product_id` | **400** `{"code":"invalid_product_id"}` |
| `GET /api/products/4006381333931` (GTIN in the id slot — the clean break) | 400 | **400** `{"code":"invalid_product_id"}` |
| `GET /api/products/gtin/abc123` | 400 | **400** `{"message":"Invalid barcode format"}` |
| `GET /api/products/gtin/0000000000000` (OFF miss) | 404 | **404** `{"message":"Product not found"}` |
| `GET /api/products/<unknown uuid>` | 404 | **404** |
| `GET /api/ratings/me/4006381333931` (deleted route) | 404, no handler | **404** `Cannot GET /api/ratings/me/…` — the route is gone, not re-keyed |
| `POST /api/ratings {productId,taste,comment}` | 201 | **201** `{…,"productId":"bc689b4f-…","product":{"id","kind","name","brand","image"}}` — embedded product is exactly the five-field select, matching the app's `RatedProduct` |
| `POST /api/ratings {barcode,taste}` (legacy shape) | 400, no compat layer | **400** `{"message":"productId and taste are required"}` |

Then, with the row flipped to `REJECTED` directly in the database — the visibility criterion, executed
rather than mocked:

| Request on a `REJECTED` product | Got |
|---|---|
| `GET /api/products/:productId` | **404** `{"message":"Product not found"}` |
| `GET /api/products/gtin/:gtin` | **404** |
| `GET /api/products/:productId/edits/pending` | **404** `{"error":"product_not_found"}` |
| `POST /api/ratings` | **404** `{"message":"Product not found. Fetch it via GET /api/products/gtin/:gtin first."}` |
| `GET /api/ratings/product/:productId` | **404** — it *does* go through `visibleProductWhere` (`ratingController.ts:108`) |
| `POST /api/products/:productId/verify`, `POST /api/products/:productId/edits` | **403** `Registration required` — `requireRegistered` fires first, as designed |

The two `403` rows are a limitation of the live check, not a gap in the code: this Supabase project
requires email confirmation, so no registered token could be minted and the write paths could not be
driven past the gate. Their `REJECTED` → 404 behaviour rests on `visibleProductWhere()` being present
in `productVerificationService.ts:36` and `productEditService.ts:210` (confirmed by grep) plus the
unit tests — see N-2 for why those particular tests are weaker than they look.

### Native E2E (row 11) — the evidence that matters for criteria 7 and 8

Both flows passed on the emulator, and the server log independently proves the **new two-hop route**
the ticket introduces, once per flow:

```
17:26:21.402 GET /api/products/gtin/4006381333931                     200   (manual-entry)
17:26:21.825 GET /api/products/bc689b4f-193d-4190-b828-58d7d67b6854   200
17:26:43.041 GET /api/products/gtin/4006381333931                     200   (barcode-scan)
17:26:43.457 GET /api/products/bc689b4f-193d-4190-b828-58d7d67b6854   200
```

That is scan / manual entry → `product/gtin/[gtin]` → `lookupProductByGtin` → `router.replace` →
`product/[id]`, executed on a device, through both entry points, landing on the `product-screen`
`testID` the flows assert. The redirect hop is the one piece of this ticket that no unit test can
reach, and it works. The flow YAML changes were comment-only, and every `testID` the flows match
still exists (`product-not-found`, `product-offline`, `product-error` now on the resolver;
`product-screen` at `product/[id].tsx:631`).

### Independent migration verification

Re-run from scratch rather than taken on trust, because the backend suite mocks Prisma and no test
touches a real database. Method: a fresh database `p6009_review`, the twelve pre-split migrations
applied in order, then seeded to exercise the edges the script alone would not catch — 3 products
(`VERIFIED` / `PENDING_REVIEW` / `REJECTED`), full nutrition on one and all-null on another, 2
ratings, 1 verification, **3** `ProductEdit` rows (a `PENDING` + `REJECTED` pair on one product, and
a third `PENDING` on a *different* product, so a globally-unique index would have failed the
migration), 1 edit vote, 1 dismissal.

Pre-migration: `product_count 3, product_edit_count 3, rating_count 2, product_verification_count 1`;
the post-migration sections error as designed (`relation "PackagedProduct" does not exist`,
`column p.kind does not exist`, `column "productId" does not exist`).

The migration itself applied under `psql -v ON_ERROR_STOP=1`, exit 0, with `UPDATE 3` / `INSERT 0 3`
/ `UPDATE 3` confirming the three backfills ran. Post-migration:

```
=== Baseline row counts ===   product_count 3 | product_edit_count 3 | rating_count 2 | product_verification_count 1
=== Product <-> PackagedProduct 1:1 ===
 packaged_product_count 3 | packaged_without_row 0 | non_packaged_count 0
=== ProductEdit re-keyed with no data loss ===
 product_edit_null_product_id 0 | product_edit_dangling_fk 0
=== one_pending_edit_per_product rejects a second PENDING row ===
BEGIN
ERROR:  duplicate key value violates unique constraint "one_pending_edit_per_product"
DETAIL:  Key ("productId")=(aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1) already exists.
ROLLBACK
```

Row-level payload check, because matching counts would not catch a column-order slip in the
`INSERT … SELECT`:

```
 productId  | gtin          | genericName | energyKcal | sugars | saturatedFat | servingSize | ingredients
 …aaaaaaa1  | 0000000000001 | bread       |      250.5 |    2.1 |          0.3 | 100 g       | flour, water, salt
 …aaaaaaa2  | 0000000000002 |             |            |        |              |             |
 …aaaaaaa3  | 0000000000003 |             |          1 |        |              |             |
```

Every value landed in the right column; all three `Product` rows are `PACKAGED` with their `id`
unchanged (so no `Rating`, `ProductVerification`, `ProductEditVote` or `ProductEditDismissal` is
re-pointed); the two `PENDING` edits on *different* products coexist, proving the rebuilt index is
both partial and per-product. Two checks the backend section did not cover:

- `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` against
  the migrated database → **"No difference detected"**, exit 0. The hand-edited SQL and
  `schema.prisma` have not drifted — the specific risk of editing a generated migration.
- `prisma migrate deploy` on an empty database → all 13 migrations apply, `migrate status` reports
  *"Database schema is up to date!"*. The migration works greenfield as well as on populated data,
  which is what `dev`'s `scripts/start.sh` does on every deploy.

Note for future runs: `verify-product-split.sql` is read-only and runs with `ON_ERROR_STOP off`, so
"the script exited 0" proves nothing by itself. The pass is the *content* of the output above plus
the `ON_ERROR_STOP=1` run of the migration.

### Non-blocking findings

**N-1 — one product read still re-types the visibility rule.** The criterion (and the ticket body:
*"the rule is never re-typed as a `where` clause"*) is not literally satisfied by
`getProductByGtin`, `server/src/controllers/productController.ts:65-76`:

```ts
const cached = await prisma.packagedProduct.findUnique({ where: { gtin }, include: { product: true } });
if (cached) {
  if (cached.product.status === ProductStatus.REJECTED) {   // ← the rule, re-typed
    return res.status(404).json({ message: 'Product not found' });
  }
```

Every other read does use the helper (`productController.ts:144`, `ratingController.ts:62` and
`:108`, `productVerificationService.ts:36`, `productEditService.ts:210`, `:273`, `:349`). Behaviour
is correct and I confirmed the `404` live, so this is drift rather than a bug — but it is exactly the
drift the helper exists to prevent. Suggested shape:
`prisma.packagedProduct.findFirst({ where: { gtin, product: visibleProductWhere(req.user) }, include: { product: true } })`.
(`productService.ts:121` also reads a `PackagedProduct` without the helper, but that is the
resubmission path, which *must* see `REJECTED` rows — correct as written.)

**N-2 — three of the new "REJECTED → 404" tests cannot fail.** They mock the product lookup to
resolve `null` and assert `404` / `ProductNotFoundError`, which is byte-for-byte the "product does
not exist" case sitting beside them. Deleting `...visibleProductWhere()` from the query under test
would leave all three green:

- `services/productVerificationService.test.ts:66`
- `services/productEditService.test.ts:314`
- `controllers/productEditController.test.ts:244` (mocks the *service* to reject — fine as controller
  error-mapping coverage, but it is not visibility coverage)

The two that do it right are `controllers/productController.test.ts:459` and
`controllers/ratingController.test.ts:115`, which assert
`where: { id: PRODUCT_ID, status: { not: ProductStatus.REJECTED } }`. Adding that same `where`
assertion to the three above would make the criterion's "a test asserts …" clause load-bearing.
Relatedly, `productController.test.ts:485` is an exact duplicate of the "unknown product" test at
`:505` — same mock, same assertion, different name.

**N-3 — `CLAUDE.md:102` still names the old route.** The "Test mocks" paragraph reads *"screens using
it (`product/[barcode].tsx`) render with `{ wrapper: GestureHandlerRootView }`"* → should be
`product/[id].tsx`. Outside the reviewer's write scope (only `docs/` and the `FEATURES.md`
checkboxes), so left for the frontend implementer.

**N-4 — `docs/architecture/data.md:210` fixed by the reviewer.** The stale `GET /products/:barcode`
the frontend flagged now reads `GET /products/:productId` and `GET /products/gtin/:gtin`, and points
at `serializeProduct` as the single place `submittedByUserId` is dropped for anonymous callers.
`docs/` is the reviewer's write target, so this needed no implementer round trip.

**N-5 — the "no nutrition section when `packaged` is null" branch is vacuous, by pre-existing fact.**
The ticket body asks for it, but the product screen has never had a nutrition section —
`git show main:…/product/[barcode].tsx | grep -i nutrition` is empty. What landed instead is the
equivalent null-branch on the data that *is* displayed: the barcode chip (`product/[id].tsx:773`,
`review-product/[id].tsx:199`, `edit-product/[id].tsx:307`) and `productToFormValues` reading
nutrition out of `product.packaged` null-safely (`features/products/edit-form.ts:89-102`), each with
a test. That is the right call and nothing is missing — recorded so nobody later reads the acceptance
list and goes looking for a nutrition section that never existed. It first becomes real in P6-007.

**N-6 — Playwright does not reach any product route (follow-up, not a gap in this ticket).**
`e2e/auth.spec.ts` stops at the Home tab and `e2e/scan-tab.spec.ts` at the camera-permission prompt,
so the green row 9 says nothing about the resolver; the on-device Maestro run is what covers it. A
small web spec driving `/(app)/product/gtin/<gtin>` → `product/<id>` would make the Playwright suite
meaningful for this area. Not added here: the guardrails make the reviewer read-only on
`bread-sheet-app/`.

**N-7 — `GET /api/users/me/ratings` does not filter `REJECTED` products out of a user's own history.**
Unchanged from `main` (so not a regression) and arguably correct — it is your own rating. Noting it
only because P6-009's criterion says "every product read"; this one embeds products via
`rating.findMany` and bypasses the helper. The ticket did improve it: it now uses the explicit
five-field `RATING_PRODUCT_SELECT` instead of `include: { product: true }`, so no internal column
leaks through it any more.

### Judgement on the backend's declared divergence

**Accepted.** `GET /api/ratings/product/:barcode` → `/:productId` was not optional: that handler did
`prisma.product.findUnique({ where: { barcode } })`, and `Product.barcode` ceases to exist in this
migration, so the plan's "left alone" instruction was unachievable. Re-keying it with the same
`router.param` UUID guard is the minimal correct action; deleting it would have taken P6-002's scope.
Verified independently that no app code calls it — grep for `ratings/product` across
`bread-sheet-app/{app,components,features,hooks,lib,e2e}` returns nothing, and the only hits for the
*deleted* `/api/ratings/me/` are comments plus `product-screen.test.tsx:460`, which asserts the app
never issues that request. It also goes through `visibleProductWhere` (confirmed live: `404` on a
`REJECTED` product), so re-keying it did not widen anything. P6-002 still owns its removal.

The coordinator also flagged that commit `4943d71` (backend) swept up two frontend file renames and
the frontend's `CLAUDE.md` paragraphs. Content is correct in both cases and the tree is coherent;
history left as-is, as instructed.

### Acceptance criteria, one at a time

| # | Criterion | Verdict |
|---|---|---|
| 1 | `Product` holds no GTIN/nutrition/ingredient columns; `PackagedProduct` holds them 1:1 by `productId`, `gtin` unique | **MET** — executed: post-migration `\d "Product"` has none of the 11 columns, `PackagedProduct_gtin_key` exists, `packaged_without_row 0` |
| 2 | Migration preserves every product, rating, verification and edit; every row ends `kind: PACKAGED` with exactly one `PackagedProduct` | **MET** — reviewer's own before/after run, plus the row-level payload check and a clean `migrate diff` |
| 3 | Creating a packaged product (OFF fetch or submission) writes both rows in one transaction; a failure leaves neither | **MET** — the OFF-fetch half was executed live (one request produced exactly one `Product` + one `PackagedProduct`). "A failure leaves neither" is **structural**, and stated as such: both writes sit inside one `prisma.$transaction` callback (`productController.ts:94-109`, and all five branches of `createSubmittedProduct`), and grep confirms **zero** `prisma.product.create/update` or `prisma.packagedProduct.create/update` outside a transaction anywhere in `server/src`. Rollback is Postgres's atomicity, and the suite mocks Prisma, so it cannot be driven without an integration harness this repo does not have |
| 4 | Every product route keyed by `Product.id`; `GET /products/gtin/:gtin` the only GTIN resolution, keeping `400` / OFF-fetch / `404` | **MET** — all four behaviours executed live (see row 12), including the clean break: a GTIN in the `:productId` slot is a `400`, not a fallback |
| 5 | `ProductEdit` references `productId`, and one-pending-edit-per-product still holds at the DB layer | **MET** — proven at the database, not in a mock: the rebuilt partial index raised a live unique violation, while a second product's `PENDING` edit was accepted |
| 6 | Every product read goes through `productVisibility`; a test asserts `REJECTED` → `404` on every product-reading endpoint, for both kinds | **MET behaviourally, PARTIAL structurally** — `404` confirmed live on all five reachable endpoints; but the rule is re-typed inline in `getProductByGtin` (**N-1**) and three of the asserting tests cannot fail (**N-2**). "Both kinds" rests on the helper being kind-agnostic, which `productVisibility.test.ts:13` does assert |
| 7 | Scanning, manual entry, the add-product 404 path and the P6-006 invalid-code path all work through the GTIN resolver; an offline scan of a cached product paints from cache | **MET** — scanning and manual entry executed on a real emulator, with the two-hop server log above as proof. The `404` → add-product and `400` → pre-filled manual sheet branches are covered by `product-gtin-resolver.test.tsx`, and the offline cache-hit path is genuinely exercised against the real offline store (that test asserts `lookupProductByGtin` was never called, so it fails if `gtinIndex` is not written) |
| 8 | Backend and frontend suites pass; Playwright and Maestro scan flows pass against the new routes | **FAILED on one row** — Playwright 2/2 pass, Maestro 2/2 pass, server suite passes, frontend jest passes; **frontend typecheck exits 2** (**B-1**) |

Seven of eight criteria are met. Criterion 8 fails on B-1 alone, so the `FEATURES.md` boxes are left
**unticked** and **no PR was opened**.

### What has to happen next

1. **(frontend, required — unblocks the merge)** Fix the `PRODUCT` fixture in
   `app/(app)/product/product-screen-offline.test.tsx` so `packaged` is a complete `PackagedDetails`,
   and verify with `npm run typecheck`. Nothing else is needed for a `PASS`: every other row of the
   matrix, including both e2e suites, is green and reproducible with the commands recorded above.
2. **(backend, recommended)** N-1 and N-2 — route `getProductByGtin`'s visibility through
   `visibleProductWhere`, and add the `where`-clause assertion to the three REJECTED tests that
   currently pass regardless of the code.
3. **(frontend, recommended)** N-3 — `CLAUDE.md:102`, `product/[barcode].tsx` → `product/[id].tsx`.
4. **(follow-up ticket)** N-6 — a Playwright spec that drives the resolver on web.

### Open questions for the human

1. **Are N-1/N-2 in scope for this PR or a follow-up?** They are the only places where the
   implementation diverges from the ticket's own wording ("never re-typed", "a test asserts"). Both
   are small; neither changes observable behaviour. My recommendation is to fix them in the same fix
   cycle as B-1, since the implementer is already going back in.
2. **`GET /api/ratings/product/:productId` — keep until P6-002, or delete now?** Kept and accepted
   above. It is an authenticated, UUID-validated, visibility-guarded route that no client calls.
   Deleting it now is a few lines and would shrink the surface; leaving it is P6-002's scope.
3. **How should the e2e prerequisites be made repeatable?** This run only got Maestro and Playwright
   green because the Supabase config was handed over mid-run and passed inline. The next reviewer in
   a fresh worktree will hit the same wall. Worth deciding whether worktree creation should symlink
   the env files, or whether the harness should export the pair from a single place.
