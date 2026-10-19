-- AlterEnum
-- Agrega 9 valores de tier (3 tipos x 3 niveles) a DungeonChamberType. Los valores legacy
-- (GOLD/EXPERIENCE/DROP) quedan en el tipo sin uso nuevo: Postgres no permite borrar valores
-- de enum sin recrear el tipo completo, y no vale el riesgo para datos ya existentes.
ALTER TYPE "DungeonChamberType" ADD VALUE 'GOLD_LOW';
ALTER TYPE "DungeonChamberType" ADD VALUE 'GOLD_MEDIUM';
ALTER TYPE "DungeonChamberType" ADD VALUE 'GOLD_HIGH';
ALTER TYPE "DungeonChamberType" ADD VALUE 'EXPERIENCE_LOW';
ALTER TYPE "DungeonChamberType" ADD VALUE 'EXPERIENCE_MEDIUM';
ALTER TYPE "DungeonChamberType" ADD VALUE 'EXPERIENCE_HIGH';
ALTER TYPE "DungeonChamberType" ADD VALUE 'DROP_LOW';
ALTER TYPE "DungeonChamberType" ADD VALUE 'DROP_MEDIUM';
ALTER TYPE "DungeonChamberType" ADD VALUE 'DROP_HIGH';
