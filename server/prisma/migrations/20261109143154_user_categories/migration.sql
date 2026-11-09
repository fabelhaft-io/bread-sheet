-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "suggestedCategory" TEXT;

-- AlterTable
ALTER TABLE "Rating" ADD COLUMN     "categoryId" TEXT;

-- CreateTable
CREATE TABLE "UserCategory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserCategory_userId_slug_key" ON "UserCategory"("userId", "slug");

-- CreateIndex
CREATE INDEX "Rating_categoryId_idx" ON "Rating"("categoryId");

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "UserCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCategory" ADD CONSTRAINT "UserCategory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
