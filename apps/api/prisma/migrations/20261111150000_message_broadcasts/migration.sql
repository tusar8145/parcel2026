-- CreateTable
CREATE TABLE "message_broadcasts" (
    "id" UUID NOT NULL,
    "channel" "OutboxChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "userIds" UUID[],
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "message_broadcasts_channel_createdAt_idx" ON "message_broadcasts"("channel", "createdAt");
