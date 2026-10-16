-- AlterTable
ALTER TABLE "bank_statement_lines" ADD COLUMN     "riderPayoutId" UUID;

-- CreateIndex
CREATE INDEX "bank_statement_lines_riderPayoutId_idx" ON "bank_statement_lines"("riderPayoutId");

