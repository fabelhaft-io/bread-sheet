-- TICKET-P6-009 / ADR 0006 — Product Model Split.
--
-- Hand-edited (per docs/P6-009-implementation-plan.md): `prisma migrate dev
-- --create-only` generated a version that drops and re-adds columns, which
-- loses data. This version backfills PackagedProduct and
-- ProductEdit.productId from the existing rows BEFORE dropping anything, so
-- every existing Product/Rating/ProductVerification/ProductEdit row is
-- preserved across the migration.

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('PACKAGED', 'CUSTOM');

-- Product.kind: add nullable, backfill every existing row as PACKAGED (they
-- all came from OFF or a user submission of a barcoded item), then enforce.
ALTER TABLE "Product" ADD COLUMN "kind" "ProductKind";
UPDATE "Product" SET "kind" = 'PACKAGED';
ALTER TABLE "Product" ALTER COLUMN "kind" SET NOT NULL;

-- CreateTable: PackagedProduct holds the manufactured-article data that used
-- to live on Product.
CREATE TABLE "PackagedProduct" (
    "productId" TEXT NOT NULL,
    "gtin" TEXT NOT NULL,
    "genericName" TEXT,
    "energyKcal" DOUBLE PRECISION,
    "fat" DOUBLE PRECISION,
    "saturatedFat" DOUBLE PRECISION,
    "carbohydrates" DOUBLE PRECISION,
    "sugars" DOUBLE PRECISION,
    "protein" DOUBLE PRECISION,
    "salt" DOUBLE PRECISION,
    "servingSize" TEXT,
    "ingredients" TEXT,

    CONSTRAINT "PackagedProduct_pkey" PRIMARY KEY ("productId")
);

-- Backfill: one PackagedProduct row per existing Product row (every existing
-- row is PACKAGED at this point in history).
INSERT INTO "PackagedProduct" (
    "productId", "gtin", "genericName", "energyKcal", "fat", "saturatedFat",
    "carbohydrates", "sugars", "protein", "salt", "servingSize", "ingredients"
)
SELECT
    "id", "barcode", "genericName", "energyKcal", "fat", "saturatedFat",
    "carbohydrates", "sugars", "protein", "salt", "servingSize", "ingredients"
FROM "Product";

-- CreateIndex
CREATE UNIQUE INDEX "PackagedProduct_gtin_key" ON "PackagedProduct"("gtin");

-- AddForeignKey
ALTER TABLE "PackagedProduct" ADD CONSTRAINT "PackagedProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ProductEdit: barcode FK -> productId FK. Backfill productId via the
-- barcode join BEFORE dropping the barcode column or its indexes/FK.
ALTER TABLE "ProductEdit" ADD COLUMN "productId" TEXT;
UPDATE "ProductEdit" e SET "productId" = p."id" FROM "Product" p WHERE p."barcode" = e."barcode";
ALTER TABLE "ProductEdit" ALTER COLUMN "productId" SET NOT NULL;

-- Drop the old barcode-keyed constraints/indexes on ProductEdit, including the
-- hand-written partial unique index from 20260703120000_product_edits_peer_review
-- (not representable in the Prisma schema DSL, so `migrate diff` never saw it).
DROP INDEX "one_pending_edit_per_product";
DROP INDEX "ProductEdit_barcode_status_idx";
ALTER TABLE "ProductEdit" DROP CONSTRAINT "ProductEdit_barcode_fkey";
ALTER TABLE "ProductEdit" DROP COLUMN "barcode";

-- AddForeignKey
ALTER TABLE "ProductEdit" ADD CONSTRAINT "ProductEdit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "ProductEdit_productId_status_idx" ON "ProductEdit"("productId", "status");

-- Rebuild the one-pending-edit-per-product invariant on productId (hand-written;
-- Prisma's schema DSL cannot express a partial unique index).
CREATE UNIQUE INDEX "one_pending_edit_per_product" ON "ProductEdit"("productId") WHERE "status" = 'PENDING';

-- Now that PackagedProduct holds the data, drop the moved columns from Product.
DROP INDEX "Product_barcode_key";
ALTER TABLE "Product" DROP COLUMN "barcode",
DROP COLUMN "genericName",
DROP COLUMN "energyKcal",
DROP COLUMN "fat",
DROP COLUMN "saturatedFat",
DROP COLUMN "carbohydrates",
DROP COLUMN "sugars",
DROP COLUMN "protein",
DROP COLUMN "salt",
DROP COLUMN "servingSize",
DROP COLUMN "ingredients";
