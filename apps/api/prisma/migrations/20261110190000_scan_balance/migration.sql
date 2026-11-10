-- CreateTable
CREATE TABLE "scan_balance" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "limited" BOOLEAN NOT NULL DEFAULT false,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scan_balance_pkey" PRIMARY KEY ("id")
);
