-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "successorEnc" TEXT;

-- CreateTable
CREATE TABLE "EmailTombstone" (
    "emailHash" TEXT NOT NULL,
    "referredAt" TIMESTAMP(3),
    "trialClaimedAt" TIMESTAMP(3),
    "rewardPaidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailTombstone_pkey" PRIMARY KEY ("emailHash")
);

-- CreateTable
CREATE TABLE "AuthAttempt" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthAttempt_emailHash_kind_at_idx" ON "AuthAttempt"("emailHash", "kind", "at");
