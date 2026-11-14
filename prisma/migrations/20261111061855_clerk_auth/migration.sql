-- Switch authentication to Clerk.
--
-- Clerk owns credentials, sessions, and email verification, so Session,
-- VerificationToken and User.passwordHash are dropped rather than mirrored.
-- User gains clerkUserId (join key to Clerk) and username (auto-assigned at
-- signup, since we only collect an email). displayName becomes nullable for
-- the same reason.
--
-- Safe to add NOT NULL columns without defaults: "User" is empty (verified 0 rows).


-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";

-- DropForeignKey
ALTER TABLE "VerificationToken" DROP CONSTRAINT "VerificationToken_userId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "passwordHash",
ADD COLUMN     "clerkUserId" TEXT NOT NULL,
ADD COLUMN     "username" TEXT NOT NULL,
ADD COLUMN     "usernameUpdatedAt" TIMESTAMP(3),
ALTER COLUMN "displayName" DROP NOT NULL;

-- DropTable
DROP TABLE "Session";

-- DropTable
DROP TABLE "VerificationToken";

-- DropEnum
DROP TYPE "VerificationTokenType";

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

