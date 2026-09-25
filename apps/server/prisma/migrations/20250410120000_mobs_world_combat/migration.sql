-- AlterTable
ALTER TABLE "Character" ADD COLUMN "experience" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Character" ADD COLUMN "worldPosX" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Character" ADD COLUMN "worldPosY" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Character" ADD COLUMN "worldPosZ" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ItemTemplate" ADD COLUMN "catalogKey" TEXT;

CREATE UNIQUE INDEX "ItemTemplate_catalogKey_key" ON "ItemTemplate"("catalogKey");

-- CreateTable
CREATE TABLE "MobTemplate" (
    "id" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "maxHp" INTEGER NOT NULL,
    "pDef" DOUBLE PRECISION NOT NULL,
    "mDef" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expReward" INTEGER NOT NULL,
    "attackRange" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "dropTable" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MobTemplate_templateKey_key" ON "MobTemplate"("templateKey");

-- CreateTable
CREATE TABLE "MobInstance" (
    "id" UUID NOT NULL,
    "mobTemplateId" UUID NOT NULL,
    "currentHp" INTEGER NOT NULL,
    "posX" DOUBLE PRECISION NOT NULL,
    "posY" DOUBLE PRECISION NOT NULL,
    "posZ" DOUBLE PRECISION NOT NULL,
    "zoneId" TEXT,
    "isAlive" BOOLEAN NOT NULL DEFAULT true,
    "diedAt" TIMESTAMP(3),
    "spawnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobInstance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MobInstance_zoneId_isAlive_idx" ON "MobInstance"("zoneId", "isAlive");

CREATE INDEX "MobInstance_mobTemplateId_idx" ON "MobInstance"("mobTemplateId");

ALTER TABLE "MobInstance" ADD CONSTRAINT "MobInstance_mobTemplateId_fkey" FOREIGN KEY ("mobTemplateId") REFERENCES "MobTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
