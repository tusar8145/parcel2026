-- CreateEnum
CREATE TYPE "MerchantKycStatus" AS ENUM ('NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MerchantKycDocumentType" AS ENUM ('TRADE_LICENSE', 'NID_FRONT', 'NID_BACK', 'TIN_BIN', 'PAYOUT_PROOF');

-- CreateEnum
CREATE TYPE "MerchantNoteKind" AS ENUM ('NOTE', 'INFO_REQUEST', 'APPLICANT_RESPONSE', 'STATUS_CHANGE', 'KYC');

-- CreateEnum
CREATE TYPE "BulkBookingStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PickupRequestStatus" AS ENUM ('REQUESTED', 'ASSIGNED', 'COMPLETED', 'CANCELLED', 'MISSED');

-- CreateEnum
CREATE TYPE "ReturnRunStatus" AS ENUM ('PLANNED', 'OUT_FOR_RETURN', 'COMPLETED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MerchantStatus" ADD VALUE 'INFO_REQUESTED';
ALTER TYPE "MerchantStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "kycRejectionReason" TEXT,
ADD COLUMN     "kycReviewedAt" TIMESTAMP(3),
ADD COLUMN     "kycReviewedById" UUID,
ADD COLUMN     "kycStatus" "MerchantKycStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
ADD COLUMN     "kycSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "rejectionReason" TEXT;

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "originBranchCode" TEXT,
ADD COLUMN     "receiverRelation" TEXT,
ADD COLUMN     "returnCharge" DECIMAL(12,2),
ADD COLUMN     "returnReason" TEXT,
ADD COLUMN     "returnReceivedAt" TIMESTAMP(3),
ADD COLUMN     "returnRequestedAt" TIMESTAMP(3),
ADD COLUMN     "returnRequestedBy" TEXT,
ADD COLUMN     "returnRunId" UUID;

-- CreateTable
CREATE TABLE "merchant_kyc_documents" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "type" "MerchantKycDocumentType" NOT NULL,
    "fileId" UUID NOT NULL,
    "uploadedById" UUID,
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_notes" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "kind" "MerchantNoteKind" NOT NULL DEFAULT 'NOTE',
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT true,
    "authorId" UUID,
    "authorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_invites" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "businessName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "type" "MerchantType",
    "message" TEXT,
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID,
    "invitedByName" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "merchantId" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "weightKg" DECIMAL(8,2),
    "packaging" TEXT,
    "price" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_bookings" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "status" "BulkBookingStatus" NOT NULL DEFAULT 'QUEUED',
    "total" INTEGER NOT NULL,
    "created" INTEGER NOT NULL DEFAULT 0,
    "existing" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "rows" JSONB NOT NULL,
    "results" JSONB,
    "actor" JSONB NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "bulk_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_schedules" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "days" INTEGER[],
    "windowStart" TEXT NOT NULL,
    "windowEnd" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "area" TEXT,
    "zone" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "expectedParcels" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pickup_requests" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "merchantId" UUID NOT NULL,
    "scheduleId" UUID,
    "date" DATE NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "street" TEXT NOT NULL,
    "area" TEXT,
    "zone" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "expectedParcels" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "status" "PickupRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "riderId" UUID,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pickup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_runs" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "merchantId" UUID NOT NULL,
    "hubId" UUID,
    "riderId" UUID,
    "status" "ReturnRunStatus" NOT NULL DEFAULT 'PLANNED',
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "return_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_kyc_documents_merchantId_type_createdAt_idx" ON "merchant_kyc_documents"("merchantId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "merchant_notes_merchantId_createdAt_idx" ON "merchant_notes"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_invites_tokenHash_key" ON "merchant_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "merchant_invites_createdAt_idx" ON "merchant_invites"("createdAt");

-- CreateIndex
CREATE INDEX "products_merchantId_name_idx" ON "products"("merchantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_merchantId_sku_key" ON "products"("merchantId", "sku");

-- CreateIndex
CREATE INDEX "bulk_bookings_merchantId_createdAt_idx" ON "bulk_bookings"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "pickup_schedules_merchantId_idx" ON "pickup_schedules"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_requests_number_key" ON "pickup_requests"("number");

-- CreateIndex
CREATE INDEX "pickup_requests_date_status_idx" ON "pickup_requests"("date", "status");

-- CreateIndex
CREATE INDEX "pickup_requests_merchantId_date_idx" ON "pickup_requests"("merchantId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "pickup_requests_scheduleId_date_key" ON "pickup_requests"("scheduleId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "return_runs_number_key" ON "return_runs"("number");

-- CreateIndex
CREATE INDEX "return_runs_merchantId_createdAt_idx" ON "return_runs"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "return_runs_status_createdAt_idx" ON "return_runs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "parcels_returnRunId_idx" ON "parcels"("returnRunId");

-- CreateIndex
CREATE INDEX "parcels_merchantId_returnRequestedAt_idx" ON "parcels"("merchantId", "returnRequestedAt");

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_returnRunId_fkey" FOREIGN KEY ("returnRunId") REFERENCES "return_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_kyc_documents" ADD CONSTRAINT "merchant_kyc_documents_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_kyc_documents" ADD CONSTRAINT "merchant_kyc_documents_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_notes" ADD CONSTRAINT "merchant_notes_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_bookings" ADD CONSTRAINT "bulk_bookings_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_schedules" ADD CONSTRAINT "pickup_schedules_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pickup_requests" ADD CONSTRAINT "pickup_requests_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "pickup_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_runs" ADD CONSTRAINT "return_runs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

