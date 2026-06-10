-- Deduplicate any (userId, productId) pairs that have multiple ratings,
-- keeping the most recent row. Without this, the unique index below would
-- fail to create on databases where the bug already produced duplicates.
DELETE FROM "Rating" r1
USING "Rating" r2
WHERE r1."userId" = r2."userId"
  AND r1."productId" = r2."productId"
  AND (
    r1."createdAt" < r2."createdAt"
    OR (r1."createdAt" = r2."createdAt" AND r1."id" < r2."id")
  );

-- AlterTable: add updatedAt (Prisma @updatedAt). Backfill with createdAt so
-- existing rows have a sane value before the NOT NULL constraint is enforced.
ALTER TABLE "Rating" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "Rating" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "Rating" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Rating_userId_productId_key" ON "Rating"("userId", "productId");