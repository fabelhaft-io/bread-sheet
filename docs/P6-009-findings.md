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
