-- CreateEnum
CREATE TYPE "HubType" AS ENUM ('COMPANY', 'FRANCHISE');

-- CreateEnum
CREATE TYPE "FranchiseStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "FranchiseCommissionType" AS ENUM ('PICKUP', 'DELIVERY', 'RETURN');

-- CreateEnum
CREATE TYPE "FranchiseRemittanceStatus" AS ENUM ('PENDING', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FranchiseInvoiceSettlement" AS ENUM ('DEDUCTED', 'PAYABLE');

-- CreateEnum
CREATE TYPE "FranchiseInvoiceStatus" AS ENUM ('ISSUED', 'APPROVED', 'PAID', 'VOID');

-- AlterEnum
ALTER TYPE "RiderEarningType" ADD VALUE 'RETURN';

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'FRANCHISE';

-- AlterTable
ALTER TABLE "hubs" ADD COLUMN     "type" "HubType" NOT NULL DEFAULT 'COMPANY';

-- AlterTable
ALTER TABLE "parcels" ADD COLUMN     "pickupHubId" UUID;

-- AlterTable
ALTER TABLE "rider_payouts" ADD COLUMN     "franchiseId" UUID;

-- CreateTable
CREATE TABLE "franchises" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "hubId" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "contactEmail" TEXT,
    "status" "FranchiseStatus" NOT NULL DEFAULT 'ACTIVE',
    "applicationId" UUID,
    "pickupPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "pickupMin" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveryPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "deliveryMin" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "returnPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "returnMin" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "franchises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "franchise_commissions" (
    "id" UUID NOT NULL,
    "franchiseId" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "type" "FranchiseCommissionType" NOT NULL,
    "base" DECIMAL(12,2) NOT NULL,
    "percent" DECIMAL(5,2) NOT NULL,
    "minimum" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "invoiceId" UUID,
    "remittanceId" UUID,
    "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "franchise_commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "franchise_counter_charges" (
    "id" UUID NOT NULL,
    "franchiseId" UUID NOT NULL,
    "parcelId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "remittanceId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "franchise_counter_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "franchise_remittances" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "franchiseId" UUID NOT NULL,
    "hubId" UUID NOT NULL,
    "gross" DECIMAL(12,2) NOT NULL,
    "commissionDeducted" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "net" DECIMAL(12,2) NOT NULL,
    "status" "FranchiseRemittanceStatus" NOT NULL DEFAULT 'PENDING',
    "collectionIds" UUID[],
    "note" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedById" UUID,
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "franchise_remittances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "franchise_invoices" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "franchiseId" UUID NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "settlement" "FranchiseInvoiceSettlement" NOT NULL,
    "status" "FranchiseInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "createdById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "paidById" UUID,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "franchise_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "franchises_code_key" ON "franchises"("code");

-- CreateIndex
CREATE UNIQUE INDEX "franchises_hubId_key" ON "franchises"("hubId");

-- CreateIndex
CREATE UNIQUE INDEX "franchises_ownerId_key" ON "franchises"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "franchises_applicationId_key" ON "franchises"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "franchise_commissions_sourceKey_key" ON "franchise_commissions"("sourceKey");

-- CreateIndex
CREATE INDEX "franchise_commissions_franchiseId_earnedAt_idx" ON "franchise_commissions"("franchiseId", "earnedAt");

-- CreateIndex
CREATE INDEX "franchise_commissions_invoiceId_idx" ON "franchise_commissions"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "franchise_counter_charges_parcelId_key" ON "franchise_counter_charges"("parcelId");

-- CreateIndex
CREATE INDEX "franchise_counter_charges_franchiseId_remittanceId_idx" ON "franchise_counter_charges"("franchiseId", "remittanceId");

-- CreateIndex
CREATE UNIQUE INDEX "franchise_remittances_number_key" ON "franchise_remittances"("number");

-- CreateIndex
CREATE INDEX "franchise_remittances_franchiseId_status_idx" ON "franchise_remittances"("franchiseId", "status");

-- CreateIndex
CREATE INDEX "franchise_remittances_hubId_status_idx" ON "franchise_remittances"("hubId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "franchise_invoices_number_key" ON "franchise_invoices"("number");

-- CreateIndex
CREATE INDEX "franchise_invoices_franchiseId_createdAt_idx" ON "franchise_invoices"("franchiseId", "createdAt");

-- CreateIndex
CREATE INDEX "franchise_invoices_status_idx" ON "franchise_invoices"("status");

-- CreateIndex
CREATE INDEX "parcels_pickupHubId_idx" ON "parcels"("pickupHubId");

-- AddForeignKey
ALTER TABLE "parcels" ADD CONSTRAINT "parcels_pickupHubId_fkey" FOREIGN KEY ("pickupHubId") REFERENCES "hubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchises" ADD CONSTRAINT "franchises_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchises" ADD CONSTRAINT "franchises_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_commissions" ADD CONSTRAINT "franchise_commissions_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "franchises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_commissions" ADD CONSTRAINT "franchise_commissions_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_commissions" ADD CONSTRAINT "franchise_commissions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "franchise_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_commissions" ADD CONSTRAINT "franchise_commissions_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "franchise_remittances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_counter_charges" ADD CONSTRAINT "franchise_counter_charges_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "franchises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_counter_charges" ADD CONSTRAINT "franchise_counter_charges_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_counter_charges" ADD CONSTRAINT "franchise_counter_charges_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "franchise_remittances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_remittances" ADD CONSTRAINT "franchise_remittances_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "franchises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_remittances" ADD CONSTRAINT "franchise_remittances_hubId_fkey" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "franchise_invoices" ADD CONSTRAINT "franchise_invoices_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "franchises"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

