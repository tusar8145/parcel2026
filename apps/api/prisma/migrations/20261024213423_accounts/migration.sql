-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('ECOMMERCE', 'FINANCIAL', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "AccountEntryType" AS ENUM ('COD', 'DELIVERY_CHARGE', 'RETURN_CHARGE', 'ADJUSTMENT', 'PAYOUT', 'PAYMENT');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('UNPAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('ISSUED', 'PARTLY_PAID', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "AccountPaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CashSlipStatus" AS ENUM ('OPEN', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HubTransferStatus" AS ENUM ('IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CodState" ADD VALUE 'IN_TRANSIT';
ALTER TYPE "CodState" ADD VALUE 'AT_CENTRAL';

-- AlterTable
ALTER TABLE "cod_collections" ADD COLUMN     "cashHubId" UUID,
ADD COLUMN     "centralAt" TIMESTAMP(3),
ADD COLUMN     "slipId" UUID,
ADD COLUMN     "transferId" UUID;

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "merchantId" UUID,
    "phone" TEXT,
    "customerId" UUID,
    "name" TEXT NOT NULL,
    "payTo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_entries" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "type" "AccountEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "parcelId" UUID,
    "trackingId" TEXT,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "payoutId" UUID,
    "billId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_payouts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "codTotal" DECIMAL(12,2) NOT NULL,
    "chargesTotal" DECIMAL(12,2) NOT NULL,
    "adjustmentsTotal" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'UNPAID',
    "payTo" JSONB,
    "method" TEXT,
    "reference" TEXT,
    "proofFileId" UUID,
    "paidAt" TIMESTAMP(3),
    "paidById" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "account_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_bills" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "paid" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "BillStatus" NOT NULL DEFAULT 'ISSUED',
    "createdById" UUID,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "account_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_payments" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "proofFileId" UUID,
    "status" "AccountPaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "submittedById" UUID,
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_bill_allocations" (
    "id" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_bill_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_slips" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "riderId" UUID NOT NULL,
    "hubId" UUID NOT NULL,
    "codAmount" DECIMAL(12,2) NOT NULL,
    "dueAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "expected" DECIMAL(12,2) NOT NULL,
    "received" DECIMAL(12,2),
    "short" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "CashSlipStatus" NOT NULL DEFAULT 'OPEN',
    "receivedHubId" UUID,
    "receivedById" UUID,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "transferId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hub_transfers" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "fromHubId" UUID NOT NULL,
    "toHubId" UUID NOT NULL,
    "codAmount" DECIMAL(12,2) NOT NULL,
    "dueAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "proofFileId" UUID,
    "status" "HubTransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
    "sentById" UUID,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received" DECIMAL(12,2),
    "short" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "receivedById" UUID,
    "receivedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "hub_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_dues" (
    "id" UUID NOT NULL,
    "riderId" UUID,
    "hubId" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedBy" TEXT,

    CONSTRAINT "cash_dues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_merchantId_key" ON "accounts"("merchantId");

-- CreateIndex
CREATE INDEX "accounts_kind_name_idx" ON "accounts"("kind", "name");

-- CreateIndex
CREATE INDEX "accounts_customerId_idx" ON "accounts"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_kind_phone_key" ON "accounts"("kind", "phone");

-- CreateIndex
CREATE INDEX "account_entries_accountId_createdAt_idx" ON "account_entries"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "account_entries_payoutId_idx" ON "account_entries"("payoutId");

-- CreateIndex
CREATE INDEX "account_entries_billId_idx" ON "account_entries"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "account_entries_parcelId_type_key" ON "account_entries"("parcelId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "account_payouts_number_key" ON "account_payouts"("number");

-- CreateIndex
CREATE INDEX "account_payouts_accountId_createdAt_idx" ON "account_payouts"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "account_payouts_status_idx" ON "account_payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "account_bills_number_key" ON "account_bills"("number");

-- CreateIndex
CREATE INDEX "account_bills_accountId_issuedAt_idx" ON "account_bills"("accountId", "issuedAt");

-- CreateIndex
CREATE INDEX "account_bills_status_idx" ON "account_bills"("status");

-- CreateIndex
CREATE UNIQUE INDEX "account_payments_number_key" ON "account_payments"("number");

-- CreateIndex
CREATE INDEX "account_payments_accountId_createdAt_idx" ON "account_payments"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "account_payments_status_idx" ON "account_payments"("status");

-- CreateIndex
CREATE INDEX "account_bill_allocations_billId_idx" ON "account_bill_allocations"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "account_bill_allocations_paymentId_billId_key" ON "account_bill_allocations"("paymentId", "billId");

-- CreateIndex
CREATE UNIQUE INDEX "cash_slips_number_key" ON "cash_slips"("number");

-- CreateIndex
CREATE INDEX "cash_slips_riderId_status_idx" ON "cash_slips"("riderId", "status");

-- CreateIndex
CREATE INDEX "cash_slips_receivedHubId_status_idx" ON "cash_slips"("receivedHubId", "status");

-- CreateIndex
CREATE INDEX "cash_slips_transferId_idx" ON "cash_slips"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "hub_transfers_number_key" ON "hub_transfers"("number");

-- CreateIndex
CREATE INDEX "hub_transfers_fromHubId_status_idx" ON "hub_transfers"("fromHubId", "status");

-- CreateIndex
CREATE INDEX "hub_transfers_toHubId_status_idx" ON "hub_transfers"("toHubId", "status");

-- CreateIndex
CREATE INDEX "cash_dues_riderId_clearedAt_idx" ON "cash_dues"("riderId", "clearedAt");

-- CreateIndex
CREATE INDEX "cash_dues_hubId_clearedAt_idx" ON "cash_dues"("hubId", "clearedAt");

-- CreateIndex
CREATE INDEX "cod_collections_cashHubId_state_idx" ON "cod_collections"("cashHubId", "state");

-- CreateIndex
CREATE INDEX "cod_collections_slipId_idx" ON "cod_collections"("slipId");

-- CreateIndex
CREATE INDEX "cod_collections_transferId_idx" ON "cod_collections"("transferId");

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "account_payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_billId_fkey" FOREIGN KEY ("billId") REFERENCES "account_bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_payouts" ADD CONSTRAINT "account_payouts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_bills" ADD CONSTRAINT "account_bills_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_payments" ADD CONSTRAINT "account_payments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_bill_allocations" ADD CONSTRAINT "account_bill_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "account_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_bill_allocations" ADD CONSTRAINT "account_bill_allocations_billId_fkey" FOREIGN KEY ("billId") REFERENCES "account_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_slips" ADD CONSTRAINT "cash_slips_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "hub_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

