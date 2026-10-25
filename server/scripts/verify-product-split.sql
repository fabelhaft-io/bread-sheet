-- TICKET-P6-009 verification script (read-only).
--
-- Run against local Postgres BEFORE and AFTER the `product_model_split`
-- migration (`prisma/migrations/20261025150342_product_model_split`), with
-- some seeded products, ratings, verifications and a pending edit in place.
-- Server tests mock Prisma, so this script — not a test suite — is what
-- proves the data-preserving migration actually preserves data.
--
-- Before the migration, `PackagedProduct` and `ProductEdit.productId` do not
-- exist yet, so the later sections intentionally error out (ON_ERROR_STOP is
-- off) — only the "Baseline row counts" section is meaningful pre-migration.
-- After the migration every section should report zero violations and the
-- final transaction should raise a unique-violation on the partial index
-- before rolling back.
--
-- Usage:
--   psql "$DATABASE_URL" -f server/scripts/verify-product-split.sql

\set ON_ERROR_STOP off
\pset format aligned

\echo '=== Baseline row counts (meaningful both before and after) ==='
SELECT count(*) AS product_count FROM "Product";
SELECT count(*) AS product_edit_count FROM "ProductEdit";
SELECT count(*) AS rating_count FROM "Rating";
SELECT count(*) AS product_verification_count FROM "ProductVerification";

\echo '=== Post-migration: Product <-> PackagedProduct 1:1 for every PACKAGED row ==='
-- Expect: packaged_product_count == product_count (every existing row is PACKAGED).
SELECT count(*) AS packaged_product_count FROM "PackagedProduct";

-- Expect: 0. Every Product row backfilled as kind = 'PACKAGED' must have
-- exactly one PackagedProduct row.
SELECT count(*) AS packaged_without_row
FROM "Product" p
WHERE p.kind = 'PACKAGED'
  AND NOT EXISTS (SELECT 1 FROM "PackagedProduct" pp WHERE pp."productId" = p.id);

-- Expect: 0. No row should exist outside the PACKAGED/CUSTOM enum, and the
-- migration backfills every existing row as PACKAGED.
SELECT count(*) AS non_packaged_count FROM "Product" WHERE kind <> 'PACKAGED';

\echo '=== Post-migration: ProductEdit re-keyed with no data loss ==='
-- Expect: 0. Every ProductEdit must have been backfilled from its barcode join.
SELECT count(*) AS product_edit_null_product_id FROM "ProductEdit" WHERE "productId" IS NULL;

-- Expect: 0. Every ProductEdit.productId must resolve to a real Product.
SELECT count(*) AS product_edit_dangling_fk
FROM "ProductEdit" e
WHERE NOT EXISTS (SELECT 1 FROM "Product" p WHERE p.id = e."productId");

\echo '=== Post-migration: one_pending_edit_per_product rejects a second PENDING row (expect an ERROR below, then ROLLBACK) ==='
BEGIN;
INSERT INTO "ProductEdit" (
  id, "productId", "authorUserId", "originalValues", "proposedChanges", status, "expiresAt"
)
SELECT
  gen_random_uuid(), e."productId", e."authorUserId", '{}'::jsonb, '{}'::jsonb, 'PENDING', now() + interval '2 years'
FROM "ProductEdit" e
WHERE e.status = 'PENDING'
LIMIT 1;
ROLLBACK;

\echo '=== Done ==='
