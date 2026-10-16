-- CreateEnum
CREATE TYPE "RiderPayMode" AS ENUM ('PER_PARCEL', 'MONTHLY_SALARY', 'BOTH');

-- CreateEnum
CREATE TYPE "RiderEarningType" AS ENUM ('DELIVERY', 'PICKUP', 'SALARY', 'INCENTIVE', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "RiderPayoutStatus" AS ENUM ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CashHandoverRequestStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RiderKycStatus" AS ENUM ('NOT_STARTED', 'DOCUMENTS_PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KycDocumentType" AS ENUM ('NID_FRONT', 'NID_BACK', 'DRIVING_LICENSE', 'PHOTO', 'VEHICLE_PAPERS');

-- CreateEnum
CREATE TYPE "KycDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "delivery_proofs" ADD COLUMN     "accuracy" DOUBLE PRECISION,
ADD COLUMN     "capturedAt" TIMESTAMP(3),
ADD COLUMN     "lat" DOUBLE PRECISION,
ADD COLUMN     "lng" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "rider_locations" (
    "riderId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "heading" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_locations_pkey" PRIMARY KEY ("riderId")
);

-- CreateTable
CREATE TABLE "rider_location_points" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "heading" DOUBLE PRECISION,
    "speed" DOUBLE PRECISION,
    "at" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_location_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_pay_plans" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "RiderPayMode" NOT NULL,
    "ecommerceRate" DECIMAL(12,2) NOT NULL,
    "documentRate" DECIMAL(12,2) NOT NULL,
    "parcelRate" DECIMAL(12,2) NOT NULL,
    "pickupRate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "monthlySalary" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_pay_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_earnings" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "type" "RiderEarningType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "parcelId" UUID,
    "trackingId" TEXT,
    "serviceLine" TEXT,
    "description" TEXT NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "planId" UUID,
    "payoutId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_payouts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "riderId" UUID NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "RiderPayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "paidById" UUID,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rider_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_handover_requests" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "hubId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "collectionIds" UUID[],
    "status" "CashHandoverRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "handoverId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "cash_handover_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_onboarding" (
    "riderId" UUID NOT NULL,
    "status" "RiderKycStatus" NOT NULL DEFAULT 'DOCUMENTS_PENDING',
    "applicationId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rider_onboarding_pkey" PRIMARY KEY ("riderId")
);

-- CreateTable
CREATE TABLE "rider_kyc_documents" (
    "id" UUID NOT NULL,
    "riderId" UUID NOT NULL,
    "type" "KycDocumentType" NOT NULL,
    "fileId" UUID NOT NULL,
    "documentNumber" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" "KycDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_kyc_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rider_location_points_at_idx" ON "rider_location_points"("at");

-- CreateIndex
CREATE UNIQUE INDEX "rider_location_points_riderId_at_key" ON "rider_location_points"("riderId", "at");

-- CreateIndex
CREATE INDEX "rider_pay_plans_riderId_effectiveFrom_idx" ON "rider_pay_plans"("riderId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "rider_earnings_sourceKey_key" ON "rider_earnings"("sourceKey");

-- CreateIndex
CREATE INDEX "rider_earnings_riderId_earnedAt_idx" ON "rider_earnings"("riderId", "earnedAt");

-- CreateIndex
CREATE INDEX "rider_earnings_payoutId_idx" ON "rider_earnings"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "rider_payouts_number_key" ON "rider_payouts"("number");

-- CreateIndex
CREATE INDEX "rider_payouts_riderId_createdAt_idx" ON "rider_payouts"("riderId", "createdAt");

-- CreateIndex
CREATE INDEX "rider_payouts_status_idx" ON "rider_payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_handover_requests_handoverId_key" ON "cash_handover_requests"("handoverId");

-- CreateIndex
CREATE INDEX "cash_handover_requests_hubId_status_idx" ON "cash_handover_requests"("hubId", "status");

-- CreateIndex
CREATE INDEX "cash_handover_requests_riderId_status_idx" ON "cash_handover_requests"("riderId", "status");

-- CreateIndex
CREATE INDEX "rider_onboarding_status_idx" ON "rider_onboarding"("status");

-- CreateIndex
CREATE INDEX "rider_kyc_documents_riderId_type_idx" ON "rider_kyc_documents"("riderId", "type");

-- AddForeignKey
ALTER TABLE "rider_locations" ADD CONSTRAINT "rider_locations_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_location_points" ADD CONSTRAINT "rider_location_points_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_pay_plans" ADD CONSTRAINT "rider_pay_plans_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_earnings" ADD CONSTRAINT "rider_earnings_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_earnings" ADD CONSTRAINT "rider_earnings_planId_fkey" FOREIGN KEY ("planId") REFERENCES "rider_pay_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_earnings" ADD CONSTRAINT "rider_earnings_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "rider_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_payouts" ADD CONSTRAINT "rider_payouts_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handover_requests" ADD CONSTRAINT "cash_handover_requests_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handover_requests" ADD CONSTRAINT "cash_handover_requests_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_handover_requests" ADD CONSTRAINT "cash_handover_requests_handoverId_fkey" FOREIGN KEY ("handoverId") REFERENCES "cash_handovers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_onboarding" ADD CONSTRAINT "rider_onboarding_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_kyc_documents" ADD CONSTRAINT "rider_kyc_documents_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_kyc_documents" ADD CONSTRAINT "rider_kyc_documents_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "stored_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

