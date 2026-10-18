-- AlterTable
ALTER TABLE "bulk_update_jobs" ADD COLUMN     "options" JSONB;

-- AlterTable
ALTER TABLE "linehaul_bags" ADD COLUMN     "label" TEXT;

-- CreateIndex
CREATE INDEX "linehaul_bags_originHubId_destHubId_label_idx" ON "linehaul_bags"("originHubId", "destHubId", "label");

