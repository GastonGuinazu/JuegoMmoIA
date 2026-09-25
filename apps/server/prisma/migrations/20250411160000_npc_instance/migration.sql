-- Instancias de NPC en mundo (mercaderes, etc.). Precios y stock: `config/npc-shops.json`.

CREATE TABLE "NpcInstance" (
    "id" UUID NOT NULL,
    "npcTemplateKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "posX" DOUBLE PRECISION NOT NULL,
    "posY" DOUBLE PRECISION NOT NULL,
    "posZ" DOUBLE PRECISION NOT NULL,
    "zoneId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NpcInstance_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NpcInstance_zoneId_idx" ON "NpcInstance"("zoneId");
CREATE INDEX "NpcInstance_npcTemplateKey_idx" ON "NpcInstance"("npcTemplateKey");
