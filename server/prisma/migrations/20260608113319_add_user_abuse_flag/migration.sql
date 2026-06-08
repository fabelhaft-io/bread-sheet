-- CreateEnum
CREATE TYPE "AbuseCategory" AS ENUM ('SEXUAL', 'GRAPHIC');

-- CreateTable
CREATE TABLE "UserAbuseFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "AbuseCategory" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAbuseFlag_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "UserAbuseFlag" ADD CONSTRAINT "UserAbuseFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
