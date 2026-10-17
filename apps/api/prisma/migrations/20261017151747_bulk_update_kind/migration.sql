-- AlterTable
ALTER TABLE "bulk_update_jobs" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'all';

-- CreateIndex
CREATE INDEX "bulk_update_jobs_kind_createdAt_idx" ON "bulk_update_jobs"("kind", "createdAt");

