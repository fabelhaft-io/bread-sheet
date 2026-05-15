-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('VERIFIED', 'PENDING_REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "VerificationVote" AS ENUM ('APPROVE', 'REJECT');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "carbohydrates" DOUBLE PRECISION,
ADD COLUMN     "energyKcal" DOUBLE PRECISION,
ADD COLUMN     "fat" DOUBLE PRECISION,
ADD COLUMN     "genericName" TEXT,
ADD COLUMN     "ingredients" TEXT,
ADD COLUMN     "protein" DOUBLE PRECISION,
ADD COLUMN     "salt" DOUBLE PRECISION,
ADD COLUMN     "servingSize" TEXT,
ADD COLUMN     "status" "ProductStatus" NOT NULL DEFAULT 'VERIFIED',
ADD COLUMN     "submittedByUserId" TEXT;

-- CreateTable
CREATE TABLE "ProductVerification" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vote" "VerificationVote" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductVerification_productId_userId_key" ON "ProductVerification"("productId", "userId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVerification" ADD CONSTRAINT "ProductVerification_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVerification" ADD CONSTRAINT "ProductVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
