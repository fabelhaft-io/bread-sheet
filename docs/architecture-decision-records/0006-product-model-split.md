# Product Model: Slim Rateable Product + Packaged-Product Details

* Status: **Accepted — not yet implemented** (implemented by [TICKET-P6-009], which is scheduled before P6-001)
* Date: 2026-10-25
* Supersedes: Decision 1 of [TICKET-P6-007] as drafted on 2026-07-30 (synthetic `x-` id in `Product.barcode`)

## Context and Problem Statement

Today `Product` is one table keyed, for every client-facing purpose, by `barcode` (`String @unique`,
validated `^\d{8,13}$`). Every product route is `/api/products/:barcode`, `ProductEdit` holds a foreign key
to `Product.barcode`, and the app's `products` offline cache, rating outbox and `use-my-rating` all index
by barcode. `Rating` and `ProductVerification` already reference `Product.id` (a server-generated UUID).

Phase 6 adds two things that don't fit this shape:

1. **Barcode-less custom items** (P6-007): cocktails, restaurant dishes, loose-leaf tea. These have no
   GTIN, they are private to their owner until shared into a group, and they skip peer review.
2. **More packaged-only data.** P6-001 adds `allergens`, `traces` and `allergensDeclared`. P6-005 adds
   four OFF-sync columns. That comes on top of the nine nutrition and ingredient columns already there.

The P6-007 draft put custom items in the same table, with a server-generated `x-<ULID>` stored in the
`barcode` column and an `identifierType GTIN | INTERNAL` discriminator. That avoided re-keying anything,
but it left three problems:

* **Fields that mean nothing for a custom item.** A cocktail's nutrition and allergens can't be known,
  because nobody knows the exact ingredients or quantities a bar used. A `barcode` column holding a
  non-barcode is a misleading name that every future reader has to learn about.
* **Allergens are safety data.** P6-001 is careful to tell "nobody has said" apart from "declared none".
  On a custom item, any allergen statement would be a guess by the owner, made without peer review, and
  shared with a group. The right amount of allergen data for a cocktail is none, and the schema should
  make that impossible to get wrong rather than leave it to UI discipline.
* **Public and private rows in one table, told apart only by a filter column.** Barcoded products are a
  public catalogue. Custom items are private. Every query over the table (P6-008 slice B's name search,
  P6-002 and P6-004 aggregates) has to remember the filter, or it leaks one household's items to everyone.

The question: should rateable things share one model, use two independent models, or use something in
between?

## Decision Drivers

* **One foreign-key target for everything rating-shaped.** `Rating`, `RatingShare` (P6-002), user
  categories (P6-003, which hang off the rating), the outbox, the caches and "my rating" should not need
  to know which kind of thing was rated.
* **Packaged-only data should be impossible to store on a custom item**, not just hidden on screen.
  This applies to allergens above all.
* **A barcode is an attribute of a manufactured article, not the identity of a rateable thing.** The
  identifier should be ours, so it exists for everything we can rate.
* **The visibility rule for private items lives in one place**, not in a filter every query has to
  remember.
* **Cost grows with every ticket that adds packaged-only columns.** Doing the split before P6-001 and
  P6-005 is the cheapest time it will ever be.

## Considered Options

1. **One wide table with a synthetic id in `barcode`** (the P6-007 draft, 2026-07-30).
2. **Two independent models**: `Product` and `CustomItem`, each with its own ratings.
3. **A slim `Product` plus a 1:1 `PackagedProduct` details table** (class-table inheritance).

## Decision Outcome

Chosen option: **3, a slim `Product` plus a 1:1 `PackagedProduct`**. It is the only option that keeps a
single rating target and also makes packaged-only data impossible to put on a custom item.

### Shape

```prisma
enum ProductKind { PACKAGED CUSTOM }

// Everything that can be rated. Identity is `id` — server-generated, the only key the API and app use.
model Product {
  id                   String        @id @default(uuid())
  kind                 ProductKind
  name                 String
  brand                String?       // for CUSTOM: the free-text "where / producer" line
  image                String?
  description          String?
  status               ProductStatus @default(VERIFIED)  // peer review is about the public row; CUSTOM is always VERIFIED
  plausibilityFlag     Boolean       @default(false)
  suggestedCategory    String?       // P6-003
  submittedByUserId    String?       // attribution on public products
  lastModifiedByUserId String?
  ownerUserId          String?       // authorization; set iff kind = CUSTOM (P6-007)

  packaged             PackagedProduct?
  ratings              Rating[]
  verifications        ProductVerification[]
  edits                ProductEdit[]

  @@index([ownerUserId])
}

// The manufactured article behind a PACKAGED product: what the label and the GS1 registry say.
model PackagedProduct {
  productId         String     @id
  product           Product    @relation(fields: [productId], references: [id], onDelete: Cascade)
  gtin              String     @unique   // EAN-8 / UPC-A / EAN-13 (incl. ISBN-13); ^\d{8,13}$ today

  genericName       String?
  energyKcal        Float?
  fat               Float?
  saturatedFat      Float?
  carbohydrates     Float?
  sugars            Float?
  protein           Float?
  salt              Float?
  servingSize       String?
  ingredients       String?

  allergens         Allergen[]          // P6-001
  traces            Allergen[]          // P6-001
  allergensDeclared Boolean @default(false)

  // P6-005 OFF sync state — offSyncStatus, offSyncAttempts, offRetryAt, offProductUrl
}
```

### Rules that come with it

* **Identity is `Product.id`.** Every product route is keyed by it (`/api/products/:productId/...`),
  and so are `ProductEdit` (FK moves from `barcode` to `productId`; the `one_pending_edit_per_product`
  partial index is rebuilt on `productId`), the `products` offline cache, the outbox payload and
  `POST /api/ratings`. A UUID v4 can't be guessed, which P6-007's "404, not 403" rule for private items
  depends on.
* **A GTIN is a lookup, not a key.** `GET /api/products/gtin/:gtin` resolves a scanned or typed code to a
  product. On a miss it fetches from Open Food Facts, as `GET /api/products/:barcode` does today, and
  creates the `Product` and `PackagedProduct` rows in one transaction. Scan, manual entry (P6-006) and
  the add-product 404 branch all go through it.
* **Invariants.** `kind = CUSTOM ⇔ ownerUserId IS NOT NULL` is a `CHECK` constraint in hand-written
  migration SQL. `kind = PACKAGED ⇔ exactly one PackagedProduct row` can't be expressed as a `CHECK`.
  The creation service enforces it by writing both rows in one transaction, and a test covers it.
* **Custom items carry no nutrition and no allergens.** They have no `PackagedProduct` row, so there is
  nothing to store and nothing to display. The product screen renders **no** nutrition section and
  **no** allergen section for them. That means not even "No allergen information yet", because that copy
  invites an edit that can't be made honestly. The P6-001 watchlist check only ever evaluates
  `PackagedProduct.allergens`.
* **One visibility helper.** Every read of `Product` goes through `server/src/services/productVisibility.ts`
  (`visibleProductWhere(user)`). For `PACKAGED` rows the helper excludes `REJECTED`. For `CUSTOM` rows it
  applies P6-007's three-rule test (owner, holds a share, has rated it). Queries that are
  catalogue-only by construction (OFF sync, OFF backfill) filter on `kind: PACKAGED` explicitly. Each
  endpoint that reads products gets a leak test: create another user's custom item, then assert it
  never appears.

### Why not option 1

It needs no re-keying, which is a real saving. But it keeps every problem listed above: nutrition and
allergen columns that can be written for a cocktail, a `barcode` column whose contents are sometimes not
barcodes, and an `identifierType` filter that every catalogue query has to remember. The saving also
shrinks with time: by P6-005 there would be about sixteen packaged-only columns on the shared table, and
the split would cost more than it does now.

### Why not option 2

A rating, a share, a category label and a queued offline rating would each need to point at one of two
tables: either two nullable FKs plus a `CHECK`, or a polymorphic key with no referential integrity. The
sharing machinery that is the whole reason custom items exist (P6-002 / P6-007) would be built twice.
The declined public barcode-less catalogue (see P6-007) gives no reason to make custom items a parallel
universe.

### Positive Consequences

* A custom item *cannot* hold allergen or nutrition data. Safety-relevant data is constrained by the
  schema, not by remembering to hide a section.
* `Rating`, `RatingShare`, categories, the outbox and the caches see one kind of thing, keyed by one id.
* P6-001 and P6-005 add their columns to a table that only ever describes manufactured articles.
* P6-007 shrinks. There is no synthetic id format, no `BARCODE_RE` alternation, and no "nutrition
  collapsed for items" UI.
* The private-item visibility rule has one implementation and a test per reader.

### Negative Consequences

* **A wide mechanical re-key, done up front** ([TICKET-P6-009]). Server routes, `ProductEdit` FK,
  the frontend product route (`product/[barcode]` → `product/[id]`, with a `product/gtin/[gtin]` resolver
  screen for scans), the `products` cache (keyed by id, with a GTIN → id index so an offline scan of a
  known product still paints), the outbox and `use-my-rating`. It ships no user-visible feature. The
  breaking API change is cheap only because there are no users yet: server and app ship together, with
  no compatibility layer, and the offline-cache version bump simply wipes local caches, queued ratings
  included. This ADR is easy to act on now and would not be later.
* Reads of a packaged product's details need a join (`include: { packaged: true }`). That cost is
  negligible at this scale.
* A P5-005 edit can change fields on both tables, so applying it writes both in one transaction.
* An allergy sufferer gets no warning card on a custom item, even if its name is "Whisky Sour". This is
  accepted. A custom item makes no statement about its contents, the app never shows one, and anyone with
  a serious allergy already knows a bar's drink has no declared ingredient list.

[TICKET-P6-007]: ../../FEATURES.md
[TICKET-P6-009]: ../../FEATURES.md
