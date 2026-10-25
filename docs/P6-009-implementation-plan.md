# P6-009 Implementation Plan — Product Model Split (Slim `Product` + `PackagedProduct`)

**Date:** 2026-10-25
**Branch:** `docs/adr-0006-product-model-split` (ADR, ticket and plan; the implementation lands on the same branch, one PR)
**Ticket:** [TICKET-P6-009] in `FEATURES.md` · **Decision:** `docs/architecture-decision-records/0006-product-model-split.md`

---

## Background

`Product.barcode` is the client-facing key everywhere today. A code survey (2026-10-25) found it in:

- **Server:** 31 references in `productService.ts`, 32 in `productEditService.ts`, 16 in
  `productController.ts`, 13 in `ratingController.ts`, plus `productVerificationService.ts`, both validators,
  both route files, and the `ProductEdit.barcode → Product.barcode` FK with its hand-written partial index
  (`20260703120000_product_edits_peer_review/migration.sql:56`).
- **App:** every `(app)` route (`product/[barcode]`, `edit-product/[barcode]`, `review-product/[barcode]`,
  `review-edit/[editId]` via a `barcode` param), `features/products/api.ts` (6 call sites),
  `lib/offline/caches.ts` (products map keyed by barcode, `findCachedRating`, `upsertCachedRating`),
  `lib/offline/outbox.ts` + `hooks/use-outbox.tsx`, `hooks/use-recent-products.tsx`,
  `hooks/use-my-rating.ts`, the Home tab, the scan tab, `manual-barcode-sheet.tsx`, and both Maestro flows.

`Rating` and `ProductVerification` already reference `Product.id`, so no rating or vote is re-pointed.

Server tests mock Prisma (`vi.mock('../db.js')`, colocated `*.test.ts`), and **no test runs against a real
database**. The migration is therefore verified with a SQL script against local
Postgres (see step B1). That is a deliberate scope choice, not an oversight.

---

## Key Decisions (open points the ticket left to implementation)

### 1. Deployment: clean break, no compatibility layer

There are no users and no app-store build, so there is no install base to protect. Server and app ship
together from one PR, and the old API shapes go away in it: no digits-only alias on `GET
/api/products/:productId`, no legacy `{ barcode }` rating payload, and no client-side redirect for stale
`/product/<gtin>` paths. A developer device with an older build simply gets reinstalled. The migration is
still data-preserving, because `dev` runs it on deploy and keeping the existing rows costs nothing extra.

### 2. Product serialisation becomes an explicit allowlist

`getProductByBarcode` currently spreads the whole row (`...cached`), so every new column is public by
default. That means internal columns, such as P6-007's `nameKey` or P6-005's sync state, reach clients
by accident and then become an API contract nobody chose. A new `serializeProduct(product, user)` in
`services/productSerializer.ts` emits:

```ts
{ id, kind, name, brand, image /* resolved */, description, status, unverified,
  submittedByUserId /* registered callers only, as today */,
  packaged: { gtin, genericName, energyKcal, fat, saturatedFat, carbohydrates, sugars,
              protein, salt, servingSize, ingredients } | null,
  submission?: { …flat, as today: name, brand + packaged fields }   // unverified only
}
```

`submission` stays flat on purpose, because the reviewer screen and the P5-006 diff are keyed by flat field
names. Rating responses (`withResolvedProductImage`) embed `{ id, kind, name, brand, image }`. The GTIN is
not needed there.

### 3. The GTIN resolver screen owns the "no product yet" states

The 1,148-line `product/[barcode].tsx` currently renders five states: found, invalid code (`400`), not found
(`404` → add product), offline with nothing cached, and the success card. After the split, the
*code-shaped* states move to a new `app/(app)/product/gtin/[gtin].tsx`:

| State | Owner after P6-009 |
|---|---|
| Invalid code (`400`) → pre-filled `ManualBarcodeSheet` | resolver |
| Not found (`404`) → "add this product" / guest sign-up gate | resolver |
| Offline, GTIN not in the local index | resolver |
| Found → `router.replace('/(app)/product/<id>')` | resolver (redirect only) |
| Found / pending / rated / success card | `product/[id].tsx` |
| `404` by id (rejected or deleted) | `product/[id].tsx`, plain "not found" with **no** add-product action (an id has no GTIN to add) |

The resolver uses `router.replace`, so the stack is the same as today: back from the product goes to
wherever the scan came from. The `RESCAN_GAP_MS` suppression in `scan.tsx` is keyed on the scanned code
and is unaffected.


### 4. Edit fields are partitioned; stored JSON stays flat

`EDITABLE_FIELDS` splits into `PRODUCT_EDIT_FIELDS` (`name`, `brand`, `image`) and `PACKAGED_EDIT_FIELDS`
(`genericName`, nutrition, `servingSize`, `ingredients`). `snapshotEditableFields`, `effectiveDiff` and
`changesToProductUpdate` read from and write to both tables. Applying an edit or a `PATCH` correction does
a `tx.product.update` and a `tx.packagedProduct.update` in the same transaction.
`originalValues`/`proposedChanges` stay flat JSON keyed by field name, so already-stored edits remain valid
with no data migration.

### 5. The cache-version bump just wipes

Bump `CACHE_SCHEMA_VERSION` and let the existing wipe-on-mismatch behaviour drop every cached document,
the outbox included. With no users, nobody can lose a queued rating that matters. `OutboxItem.barcode`
becomes `productId`, with no union type and no legacy replay path.

### 6. `productVisibility` lands now

`visibleProductWhere(user)` returns `{ status: { not: REJECTED } }`, the P5-007 rule, for both kinds
(custom products are public, see the revised P6-007). `assertProductVisible(user, id)` throws the existing
`ProductNotFoundError` (→ `404`). Every read in `productController`, `productEditController`,
`productVerificationService`, `productEditService` and `ratingController` goes through it. The rule is
trivial today. The point is that it has exactly one implementation, and P6-008's search reuses it instead
of re-typing a `where` clause.

---

## Migration SQL (sketch, one migration `YYYYMMDDhhmmss_product_model_split`)

Generated by `prisma migrate dev --create-only`, then hand-edited. Prisma would otherwise drop and re-add
columns and lose data.

```sql
CREATE TYPE "ProductKind" AS ENUM ('PACKAGED', 'CUSTOM');
ALTER TABLE "Product" ADD COLUMN "kind" "ProductKind";
UPDATE "Product" SET "kind" = 'PACKAGED';
ALTER TABLE "Product" ALTER COLUMN "kind" SET NOT NULL;

CREATE TABLE "PackagedProduct" (
  "productId" TEXT PRIMARY KEY REFERENCES "Product"("id") ON DELETE CASCADE,
  "gtin" TEXT NOT NULL UNIQUE,
  "genericName" TEXT, "energyKcal" DOUBLE PRECISION, …, "ingredients" TEXT);
INSERT INTO "PackagedProduct" ("productId", "gtin", "genericName", …)
  SELECT "id", "barcode", "genericName", … FROM "Product";

-- ProductEdit: barcode FK → productId FK
ALTER TABLE "ProductEdit" ADD COLUMN "productId" TEXT;
UPDATE "ProductEdit" e SET "productId" = p."id" FROM "Product" p WHERE p."barcode" = e."barcode";
ALTER TABLE "ProductEdit" ALTER COLUMN "productId" SET NOT NULL;
DROP INDEX "one_pending_edit_per_product";
DROP INDEX "ProductEdit_barcode_status_idx";
ALTER TABLE "ProductEdit" DROP CONSTRAINT "ProductEdit_barcode_fkey", DROP COLUMN "barcode";
ALTER TABLE "ProductEdit" ADD CONSTRAINT "ProductEdit_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE;
CREATE INDEX "ProductEdit_productId_status_idx" ON "ProductEdit"("productId", "status");
CREATE UNIQUE INDEX "one_pending_edit_per_product" ON "ProductEdit"("productId")
  WHERE "status" = 'PENDING';                                          -- hand-written

ALTER TABLE "Product" DROP COLUMN "barcode", DROP COLUMN "genericName", …, DROP COLUMN "ingredients";
```

`description` stays on `Product`. It holds OFF's `generic_name` for OFF-sourced rows, which is a
pre-existing duplication with `genericName`. Leave it alone; it is out of scope.

---

## Work Breakdown

Order matters: each step leaves the server compiling and its tests green before the next starts.

### Backend (`server/`)

**B1 — Schema + migration.** Prisma schema per ADR 0006. Hand-edit the migration as above. Add
`server/scripts/verify-product-split.sql`, a read-only script run against local Postgres before and after
`migrate dev`. It asserts row counts match (`Product` = `PackagedProduct`, `ProductEdit` unchanged, zero
`ProductEdit.productId` nulls, every `Product` is `PACKAGED`, and the rebuilt
`one_pending_edit_per_product` index rejects a second pending edit inside a rolled-back transaction). Run
it against the local database (podman:
`podman compose up -d`) with some seeded products, ratings, verifications and a pending edit.

**B2 — `productSerializer.ts` + `productVisibility.ts`** (new), each with unit tests. The serializer
tests cover: anonymous caller has no `submittedByUserId`; `packaged: null` for a `CUSTOM` row; image
resolved; `submission` present only when unverified; and **no field outside the allowlist leaks** (assert
on `Object.keys`).

**B3 — `productService.ts`.** `fetchFromOpenFoodFacts(gtin)` returns `{ product, packaged }`.
`createSubmittedProduct` looks up via `packagedProduct.findUnique({ where: { gtin }, include: { product:
true } })`. All four branches (verified / rejected-resubmit / pending-other / pending-own) keep their
semantics. Create and resubmit write both rows in the transaction. `mapPayloadToProduct` splits into
`toProductData` / `toPackagedData`. The result becomes `{ action, product: { id, gtin, status } }`. Error
classes keep a `gtin` field for log messages.

**B4 — `productEditService.ts` + `productVerificationService.ts`.** Re-key every function from `barcode`
to `productId`. Partition the edit fields (decision 4). `castVote(productId, …)`. `createEdit`,
`getPendingEdit`, `correctPendingProduct` and `castEditVote` read through `include: { packaged: true }`.
`PendingEditView.barcode` → `productId`. Verification and editing stay kind-agnostic: custom products go
through the same flows (P6-007), and only P6-007 adds the `CUSTOM` field set.

**B5 — Controllers + routes.**
- `productRoutes.ts`: add `router.param('productId', validateProductId)` (UUID → else `400 { code:
  'invalid_product_id' }`). Register `GET /gtin/:gtin` **before** `/:productId`, then re-key `GET`,
  `PATCH`, `/verify`, `/edits`, `/edits/pending`. The existing `/edits/:editId/...` routes are unchanged.
  Update the line-85 comment about route collisions.
- `getProductByGtin` (renamed from `getProductByBarcode`, same `BARCODE_RE`, OFF fetch, `404`) writes both
  rows in one `$transaction`. A concurrent first scan of the same GTIN hits `P2002` on `gtin`; catch it and
  re-read instead of returning `409`, because two people scanning the same new product is normal.
- `getProductById`: visibility check → serialize.
- `submitProduct`: the validator field `barcode` → `gtin` (`productSubmissionValidator.ts` + its 46 test
  references).
- `ratingController.createRating`: `{ productId, taste, comment? }`, plus the visibility check. **Delete** `getMyRatingForProduct` and its
  `/me/:barcode` route (unused since Phase 8). Leave `getRatingsForProduct` for P6-002 to delete.
- `productEditController`: `req.params.productId`.

**B6 — Tests.** Update `productController`, `productService`, `productEditController`,
`productEditService`, `verifyProduct`, `productVerificationService`, `ratingController` and
`productSubmissionValidator` tests to the new keys and shapes. New cases:
- GTIN lookup concurrent-create race (`P2002` → re-read → `200`)
- a rating without `productId` → `400`
- non-UUID `:productId` → `400`
- **visibility test:** a `REJECTED` product → `404` on `GET /:productId`, `POST /ratings`, `/verify`,
  `/edits`, `/edits/pending`, for both kinds
- an edit spanning both tables applies both updates in one transaction

**B7 — Bruno.** Re-key `docs/bruno/` product requests. Add **Products › Lookup by GTIN**, and update
post-response scripts to store `productId` from the lookup so the chained requests use it.

### Frontend (`bread-sheet-app/`)

**F1 — Types.** `ProductDetail`: drop `barcode` and the top-level nutrition fields; add `kind:
'PACKAGED' | 'CUSTOM'` and `packaged: PackagedDetails | null`. `ProductSubmission.barcode` → `gtin`.
`PendingEdit.barcode` → `productId`. `RatedProduct`: drop `barcode`, add `kind`.

**F2 — `features/products/api.ts`.** New `lookupProductByGtin(gtin)`, plus `getProduct(id)`. Re-key
`approveProduct`, `rejectProduct`, `correctProduct`, `proposeProductEdit` and `getPendingEdit` to `id`.
`submitProduct` returns `{ id, gtin, status }`. Move the inline `api.get('/api/products/${barcode}')`
calls in the product, edit and review screens to these helpers.

**F3 — `features/products/edit-form.ts`.** Pre-population reads nutrition from `product.packaged`, and
the changed-fields diff and correction payload stay flat (they match the server's flat edit JSON).
Update `edit-form.test.ts`.

**F4 — Offline layer.**
- `caches.ts`: `productCache(id)`. The products document becomes `{ byId: Record<id, Entry>, gtinIndex:
  Record<gtin, id> }`, and LRU eviction drops index entries pointing at evicted ids. New
  `peekProductIdByGtin(gtin)` / `readProductIdByGtin(gtin)`. `findCachedRating(ratings, productId)` and
  `upsertCachedRating` compare `product.id`. Recents store `{ id, name, brand, image }`.
- `store.ts`: bump `CACHE_SCHEMA_VERSION` to 2 (decision 5); no other change.
- `outbox.ts` / `use-outbox.tsx`: `enqueue({ productId, … })`, `isQueued(productId)`, and the
  `upsertCachedRating(saved)` guard checks `saved?.product?.id`.
- `use-my-rating.ts`: `useMyRating(userId, productId)`.

**F5 — GTIN resolver `app/(app)/product/gtin/[gtin].tsx`** (new, decision 3). Flow on mount:
1. If `peekProductIdByGtin(gtin)` hits, `replace` to `product/<id>` in the first frame. The product screen
   paints from cache, so an offline scan of a known product works.
2. Otherwise call `lookupProductByGtin`. On success, write the product to `productCache(id)`, which also
   updates the index, then `replace`.
3. `400` → the invalid-code state with a pre-filled `ManualBarcodeSheet` (`onSubmit` replaces to
   `product/gtin/<code>`).
4. `404` → the not-found state: "add this product" → `add-product?gtin=…`, or the guest sign-up gate
   with `returnTo: /product/gtin/<gtin>`.
5. `NetworkError` with no index hit → the existing offline-uncached state.

Move these states' JSX, styles and `testID`s (`product-invalid-barcode`, `product-not-found`, etc.)
**verbatim** from the product screen, so the Maestro flows' landing assertions keep matching. Register the
route in `app/(app)/_layout.tsx`.

**F6 — `product/[barcode].tsx` → `product/[id].tsx`.**
- Fetch by id.
- Remove the states moved to the resolver.
- An id-`404` renders a plain not-found screen with a "Back to Home" action.
- The barcode chip shows `product.packaged?.gtin` and is hidden when `packaged` is null.
- The nutrition section reads `product.packaged`, and is not rendered at all when `packaged` is null.
- `addRecentProduct`, `enqueue`, `isQueued`, `getPendingEdit` and the navigation to edit/review screens
  all switch to `product.id`.
- The rating-submitted card, `router.navigate('/(tabs)')` and the focus-effect cleanup are unchanged.

**F7 — Navigation entry points.**
- `scan.tsx` (camera callback + `__DEV__` inject seam) and `manual-barcode-sheet.tsx` default `onSubmit`
  → `/(app)/product/gtin/<code>`.
- Home tab: rating cards and recents → `/(app)/product/<id>`; `testID` `rating-pending-sync-<id>`.
- `add-product.tsx`: the param `barcode` → `gtin`, the submission sends `gtin`, and `onSubmitted(id)`
  replaces to `product/<id>`. The `field-barcode` testID is kept (the label stays "Barcode", which is
  what users see).
- `returnTo` strings in add-product, review-product and edit-product use `/product/<id>`, or
  `/product/gtin/<gtin>` before a product exists.

**F8 — Edit and review routes.** `edit-product/[barcode].tsx` → `edit-product/[id].tsx`, and
`review-product/[barcode].tsx` → `review-product/[id].tsx`. Both use `getProduct(id)`. The read-only
barcode field shows `product.packaged.gtin`. `review-edit/[editId].tsx` takes the param `productId`.
Update `_layout.tsx` registrations and the CLAUDE.md route list.

**F9 — Tests.**
- Rename and move test files with their screens.
- New `product-gtin-resolver.test.tsx` covers: cached-index hit replaces without a request; network hit
  writes the cache and index; `400`/`404`/offline states; guest gate `returnTo`.
- `product-screen.test.tsx` loses the 400/404 cases (they move to the resolver) and gains id-`404` and
  "no nutrition section when `packaged` is null".
- `caches.test.ts`: the GTIN index is written with the product and evicted with it under LRU.
- `outbox.test.ts`: re-keyed to `productId`; repeated ratings of one product still collapse.
- Mocks in `lib/__mocks__/api.ts` are unchanged, because `ApiError`/`NetworkError` stay real classes.

**F10 — E2E.** `barcode-scan.yaml` and `manual-entry.yaml` go through the resolver. Their landing
assertions are on `testID`s that move verbatim (F5), so the expected change is limited to comments
mentioning `/(app)/product/<barcode>`. Run `npm run test:maestro` and `npm run test:e2e`.

### Docs (same PR)

- `CLAUDE.md`: data model (`Product` / `PackagedProduct`, `ProductEdit.productId`), `(app)` route list,
  offline cache section (id-keyed products + GTIN index), the "Manual barcode entry"
  and "Leaving the rating flow" paragraphs (destination is now the resolver), and the ADR 0006 status line.
- `docs/architecture/backend.md` (endpoints, serializer allowlist, visibility helper), `frontend.md`
  (resolver, route table, offline cache), `data.md` (where label data lives).
- ADR 0006 status → *Accepted — implemented*.
- Tick the P6-009 acceptance boxes in `FEATURES.md`.

---

## Risks

| Risk | Mitigation |
|---|---|
| Hand-edited migration loses or mismatches data on `dev` | B1 verification script run locally before merging; `migrate deploy` runs in `start.sh`, so a failed migration stops the task from starting rather than serving half-migrated data |
| A product read path skips `productVisibility` | B6 visibility test hits every product-reading route; P6-008's search reuses the helper |
| Moving the not-found UI breaks Maestro landing assertions | Move JSX and `testID`s verbatim; run both flows before merging |
| Two users scanning the same new GTIN at once | `P2002` on `gtin` → re-read, tested |

## Follow-ups (not in this PR)

- `Product.description` vs `PackagedProduct.genericName` duplication for OFF-sourced rows.
