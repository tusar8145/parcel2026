-- CreateEnum
CREATE TYPE "FeedbackSource" AS ENUM ('TRACKING', 'GUEST_LINK', 'SMS_LINK');

-- AlterTable
ALTER TABLE "addresses" ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "deliveryLat" DOUBLE PRECISION,
ADD COLUMN     "deliveryLng" DOUBLE PRECISION,
ADD COLUMN     "pickupLat" DOUBLE PRECISION,
ADD COLUMN     "pickupLng" DOUBLE PRECISION,
ADD COLUMN     "pickupWindowEnd" TIMESTAMP(3),
ADD COLUMN     "pickupWindowStart" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "guest_verifications" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "parcelId" UUID,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parcel_feedback" (
    "id" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "source" "FeedbackSource" NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parcel_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "guest_verifications_phone_createdAt_idx" ON "guest_verifications"("phone", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "parcel_feedback_parcelId_key" ON "parcel_feedback"("parcelId");

-- CreateIndex
CREATE INDEX "parcel_feedback_createdAt_idx" ON "parcel_feedback"("createdAt");

-- CreateIndex
CREATE INDEX "parcel_feedback_rating_createdAt_idx" ON "parcel_feedback"("rating", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_verifications_tokenHash_key" ON "email_verifications"("tokenHash");

-- CreateIndex
CREATE INDEX "email_verifications_userId_createdAt_idx" ON "email_verifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "parcels_pickupWindowStart_idx" ON "parcels"("pickupWindowStart");

-- AddForeignKey
ALTER TABLE "parcel_feedback" ADD CONSTRAINT "parcel_feedback_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verifications" ADD CONSTRAINT "email_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

