/*
  Warnings:

  - You are about to drop the column `category` on the `UserAbuseFlag` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "UserAbuseFlag" DROP COLUMN "category";

-- DropEnum
DROP TYPE "AbuseCategory";
