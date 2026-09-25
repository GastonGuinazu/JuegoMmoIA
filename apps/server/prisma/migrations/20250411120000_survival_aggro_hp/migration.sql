-- Persistencia de vida del jugador, aggro de mobs y cooldown de golpes mob→player.

ALTER TABLE "Character" ADD COLUMN "currentHp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Character" ADD COLUMN "lastCombatAt" TIMESTAMP(3);

ALTER TABLE "MobTemplate" ADD COLUMN "aggroRange" DOUBLE PRECISION NOT NULL DEFAULT 10;
ALTER TABLE "MobTemplate" ADD COLUMN "pAtk" DOUBLE PRECISION NOT NULL DEFAULT 12;

ALTER TABLE "MobInstance" ADD COLUMN "aggroTargetCharacterId" UUID;
ALTER TABLE "MobInstance" ADD COLUMN "lastMobMeleeAt" TIMESTAMP(3);

ALTER TABLE "MobInstance" ADD CONSTRAINT "MobInstance_aggroTargetCharacterId_fkey" FOREIGN KEY ("aggroTargetCharacterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "MobInstance_aggroTargetCharacterId_idx" ON "MobInstance"("aggroTargetCharacterId");
