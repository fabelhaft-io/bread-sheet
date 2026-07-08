-- CreateEnum
CREATE TYPE "ProductEditStatus" AS ENUM ('PENDING', 'APPLIED', 'REJECTED', 'EXPIRED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "lastModifiedByUserId" TEXT;

-- CreateTable
CREATE TABLE "ProductEdit" (
    "id" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "originalValues" JSONB NOT NULL,
    "proposedChanges" JSONB NOT NULL,
    "status" "ProductEditStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductEdit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEditVote" (
    "id" TEXT NOT NULL,
    "editId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vote" "VerificationVote" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEditVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEditDismissal" (
    "id" TEXT NOT NULL,
    "editId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEditDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductEdit_barcode_status_idx" ON "ProductEdit"("barcode", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEditVote_editId_userId_key" ON "ProductEditVote"("editId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEditDismissal_editId_userId_key" ON "ProductEditDismissal"("editId", "userId");

-- Hand-written: DB-level "one pending edit per barcode" rule (TICKET-P5-006).
-- Prisma's schema DSL cannot express partial unique indexes, so this lives only
-- in the migration. The API's 409 response is a friendly mirror of this
-- constraint — the database refuses a second PENDING insert even if two
-- requests race.
CREATE UNIQUE INDEX "one_pending_edit_per_product" ON "ProductEdit"("barcode") WHERE "status" = 'PENDING';

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_lastModifiedByUserId_fkey" FOREIGN KEY ("lastModifiedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEdit" ADD CONSTRAINT "ProductEdit_barcode_fkey" FOREIGN KEY ("barcode") REFERENCES "Product"("barcode") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEdit" ADD CONSTRAINT "ProductEdit_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEditVote" ADD CONSTRAINT "ProductEditVote_editId_fkey" FOREIGN KEY ("editId") REFERENCES "ProductEdit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEditVote" ADD CONSTRAINT "ProductEditVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEditDismissal" ADD CONSTRAINT "ProductEditDismissal_editId_fkey" FOREIGN KEY ("editId") REFERENCES "ProductEdit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEditDismissal" ADD CONSTRAINT "ProductEditDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
