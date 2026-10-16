-- AlterTable
ALTER TABLE "outbox_messages" ADD COLUMN     "html" TEXT,
ADD COLUMN     "notBefore" TIMESTAMP(3),
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "providerResponse" TEXT,
ADD COLUMN     "subject" TEXT,
ADD COLUMN     "userId" UUID;

-- CreateTable
CREATE TABLE "notification_templates" (
    "event" TEXT NOT NULL,
    "channel" "OutboxChannel" NOT NULL,
    "enabled" BOOLEAN,
    "subject" TEXT,
    "body" TEXT,
    "html" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("event","channel")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "userId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "channel" "OutboxChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("userId","event","channel")
);

-- CreateTable
CREATE TABLE "notification_gateways" (
    "channel" "OutboxChannel" NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretsEncrypted" TEXT,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_gateways_pkey" PRIMARY KEY ("channel")
);

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

