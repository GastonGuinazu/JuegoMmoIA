-- Nested equipment and sub-slots (bracelet / talismans)
ALTER TYPE "GearSlot" ADD VALUE IF NOT EXISTS 'CLOAK';
ALTER TYPE "GearSlot" ADD VALUE IF NOT EXISTS 'BRACELET_1';
ALTER TYPE "GearSlot" ADD VALUE IF NOT EXISTS 'BRACELET_2';

ALTER TABLE "ItemTemplate"
ADD COLUMN "hasSubSlots" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "maxSubSlots" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "subSlotType" TEXT,
ADD COLUMN "parentSlotType" TEXT;

ALTER TABLE "ItemInstance"
ADD COLUMN "parentItemInstanceId" UUID,
ADD COLUMN "parentSubSlotIndex" INTEGER;

ALTER TABLE "ItemInstance"
ADD CONSTRAINT "ItemInstance_parentItemInstanceId_fkey"
FOREIGN KEY ("parentItemInstanceId") REFERENCES "ItemInstance"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ItemInstance_parentItemInstanceId_idx" ON "ItemInstance"("parentItemInstanceId");
CREATE UNIQUE INDEX "ItemInstance_parentItemInstanceId_parentSubSlotIndex_key"
ON "ItemInstance"("parentItemInstanceId", "parentSubSlotIndex");
