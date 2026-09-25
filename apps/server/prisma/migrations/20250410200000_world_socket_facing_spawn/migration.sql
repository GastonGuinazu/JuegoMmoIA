-- AlterTable Character
ALTER TABLE "Character" ADD COLUMN "worldFacingYaw" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Character" ADD COLUMN "currentZoneId" TEXT;

-- AlterTable MobInstance
ALTER TABLE "MobInstance" ADD COLUMN "spawnPosX" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "MobInstance" ADD COLUMN "spawnPosY" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "MobInstance" ADD COLUMN "spawnPosZ" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "MobInstance" ADD COLUMN "worldFacingYaw" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "MobInstance"
SET
  "spawnPosX" = "posX",
  "spawnPosY" = "posY",
  "spawnPosZ" = "posZ"
WHERE "spawnPosX" = 0 AND "spawnPosY" = 0 AND "spawnPosZ" = 0;
