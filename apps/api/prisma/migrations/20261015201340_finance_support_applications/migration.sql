-- CreateEnum
CREATE TYPE "ApplicationKind" AS ENUM ('RIDER', 'FRANCHISE');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE');

-- CreateEnum
CREATE TYPE "MerchantAdjustmentKind" AS ENUM ('CARRY_FORWARD', 'WEIGHT_ADJUSTMENT', 'REFUND', 'CLAIM', 'MANUAL');

-- CreateEnum
CREATE TYPE "SettlementCycle" AS ENUM ('MANUAL', 'DAILY', 'WEEKLY', 'BIWEEKLY');

-- CreateEnum
CREATE TYPE "StatementSource" AS ENUM ('BANK', 'BKASH');

-- CreateEnum
CREATE TYPE "StatementLineStatus" AS ENUM ('UNMATCHED', 'MATCHED', 'IGNORED');

-- CreateEnum
CREATE TYPE "DisputeKind" AS ENUM ('DAMAGED', 'LOST', 'OVERCHARGE', 'WEIGHT_DISCREPANCY', 'OTHER');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DisputePayout" AS ENUM ('MERCHANT_BALANCE', 'BANK', 'BKASH', 'CASH');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "createdById" UUID,
ADD COLUMN     "paidById" UUID,
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "seller" JSONB,
ADD COLUMN     "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "merchant_settlements" ADD COLUMN     "adjustmentsTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "autoDrafted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "carriedForward" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "paidById" UUID;

-- AlterTable
ALTER TABLE "stored_files" ADD COLUMN     "disputeId" UUID;

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "escalationLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firstResponseAt" TIMESTAMP(3),
ADD COLUMN     "firstResponseBreachedAt" TIMESTAMP(3),
ADD COLUMN     "firstResponseDueAt" TIMESTAMP(3),
ADD COLUMN     "resolutionBreachedAt" TIMESTAMP(3),
ADD COLUMN     "resolutionDueAt" TIMESTAMP(3),
ADD COLUMN     "slaPausedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "partner_applications" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "ApplicationKind" NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "applicantId" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "details" JSONB NOT NULL,
    "reviewerId" UUID,
    "decisionNote" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "riderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "systemKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "memo" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "period" TEXT NOT NULL,
    "merchantId" UUID,
    "riderId" UUID,
    "hubId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "merchantId" UUID,
    "riderId" UUID,
    "hubId" UUID,
    "memo" TEXT,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_periods" (
    "period" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" UUID,
    "snapshot" JSONB NOT NULL,
    "note" TEXT,

    CONSTRAINT "ledger_periods_pkey" PRIMARY KEY ("period")
);

-- CreateTable
CREATE TABLE "merchant_adjustments" (
    "id" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "kind" "MerchantAdjustmentKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "disputeId" UUID,
    "sourceSettlementId" UUID,
    "settlementId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_schedules" (
    "merchantId" UUID NOT NULL,
    "cycle" "SettlementCycle" NOT NULL DEFAULT 'MANUAL',
    "weekday" INTEGER,
    "minimumAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_schedules_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" UUID NOT NULL,
    "source" "StatementSource" NOT NULL,
    "accountLabel" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedById" UUID,
    "lineCount" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" UUID NOT NULL,
    "statementId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "StatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchMethod" TEXT,
    "settlementId" UUID,
    "invoiceId" UUID,
    "matchedById" UUID,
    "matchedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "DisputeKind" NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "parcelId" UUID NOT NULL,
    "merchantId" UUID,
    "raisedById" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "claimedAmount" DECIMAL(12,2),
    "approvedAmount" DECIMAL(12,2),
    "bookedWeightKg" DECIMAL(8,2),
    "actualWeightKg" DECIMAL(8,2),
    "originalCharge" DECIMAL(12,2),
    "repricedCharge" DECIMAL(12,2),
    "payout" "DisputePayout",
    "payoutReference" TEXT,
    "resolution" TEXT,
    "reviewerId" UUID,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_notes" (
    "id" UUID NOT NULL,
    "disputeId" UUID NOT NULL,
    "authorId" UUID,
    "authorLabel" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_responses" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "shortcut" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_surveys" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "agentId" UUID,
    "rating" INTEGER,
    "comment" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "ticket_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_applications_number_key" ON "partner_applications"("number");

-- CreateIndex
CREATE UNIQUE INDEX "partner_applications_ticketId_key" ON "partner_applications"("ticketId");

-- CreateIndex
CREATE INDEX "partner_applications_kind_status_createdAt_idx" ON "partner_applications"("kind", "status", "createdAt");

-- CreateIndex
CREATE INDEX "partner_applications_applicantId_kind_status_idx" ON "partner_applications"("applicantId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_code_key" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_systemKey_key" ON "ledger_accounts"("systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_number_key" ON "journal_entries"("number");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_idempotencyKey_key" ON "journal_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "journal_entries_period_idx" ON "journal_entries"("period");

-- CreateIndex
CREATE INDEX "journal_entries_eventType_occurredAt_idx" ON "journal_entries"("eventType", "occurredAt");

-- CreateIndex
CREATE INDEX "journal_entries_reference_idx" ON "journal_entries"("reference");

-- CreateIndex
CREATE INDEX "journal_entries_merchantId_occurredAt_idx" ON "journal_entries"("merchantId", "occurredAt");

-- CreateIndex
CREATE INDEX "journal_lines_entryId_idx" ON "journal_lines"("entryId");

-- CreateIndex
CREATE INDEX "journal_lines_accountId_entryId_idx" ON "journal_lines"("accountId", "entryId");

-- CreateIndex
CREATE INDEX "journal_lines_merchantId_accountId_idx" ON "journal_lines"("merchantId", "accountId");

-- CreateIndex
CREATE INDEX "journal_lines_riderId_accountId_idx" ON "journal_lines"("riderId", "accountId");

-- CreateIndex
CREATE INDEX "journal_lines_hubId_accountId_idx" ON "journal_lines"("hubId", "accountId");

-- CreateIndex
CREATE INDEX "merchant_adjustments_merchantId_settlementId_idx" ON "merchant_adjustments"("merchantId", "settlementId");

-- CreateIndex
CREATE INDEX "settlement_schedules_cycle_nextRunAt_idx" ON "settlement_schedules"("cycle", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_fingerprint_key" ON "bank_statement_lines"("fingerprint");

-- CreateIndex
CREATE INDEX "bank_statement_lines_status_postedAt_idx" ON "bank_statement_lines"("status", "postedAt");

-- CreateIndex
CREATE INDEX "bank_statement_lines_settlementId_idx" ON "bank_statement_lines"("settlementId");

-- CreateIndex
CREATE INDEX "bank_statement_lines_invoiceId_idx" ON "bank_statement_lines"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_lines_statementId_lineNo_key" ON "bank_statement_lines"("statementId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_number_key" ON "disputes"("number");

-- CreateIndex
CREATE INDEX "disputes_status_createdAt_idx" ON "disputes"("status", "createdAt");

-- CreateIndex
CREATE INDEX "disputes_merchantId_createdAt_idx" ON "disputes"("merchantId", "createdAt");

-- CreateIndex
CREATE INDEX "disputes_raisedById_createdAt_idx" ON "disputes"("raisedById", "createdAt");

-- CreateIndex
CREATE INDEX "disputes_parcelId_idx" ON "disputes"("parcelId");

-- CreateIndex
CREATE INDEX "dispute_notes_disputeId_createdAt_idx" ON "dispute_notes"("disputeId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "canned_responses_shortcut_key" ON "canned_responses"("shortcut");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_surveys_ticketId_key" ON "ticket_surveys"("ticketId");

-- CreateIndex
CREATE INDEX "ticket_surveys_respondedAt_idx" ON "ticket_surveys"("respondedAt");

-- CreateIndex
CREATE INDEX "support_tickets_status_resolutionDueAt_idx" ON "support_tickets"("status", "resolutionDueAt");

-- AddForeignKey
ALTER TABLE "partner_applications" ADD CONSTRAINT "partner_applications_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_adjustments" ADD CONSTRAINT "merchant_adjustments_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_adjustments" ADD CONSTRAINT "merchant_adjustments_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "merchant_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_schedules" ADD CONSTRAINT "settlement_schedules_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "merchant_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_parcelId_fkey" FOREIGN KEY ("parcelId") REFERENCES "parcels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_notes" ADD CONSTRAINT "dispute_notes_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_surveys" ADD CONSTRAINT "ticket_surveys_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

