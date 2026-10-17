-- AlterTable
ALTER TABLE "outbox_messages" ADD COLUMN     "trackingId" TEXT;

-- CreateIndex
CREATE INDEX "outbox_messages_trackingId_idx" ON "outbox_messages"("trackingId");

