-- AlterTable
ALTER TABLE "bulk_update_jobs" ADD COLUMN     "action" TEXT;

-- CreateIndex
CREATE INDEX "bulk_update_jobs_action_createdAt_idx" ON "bulk_update_jobs"("action", "createdAt");

