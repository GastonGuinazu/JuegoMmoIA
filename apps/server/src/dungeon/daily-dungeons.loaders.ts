import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DungeonChamberType } from '@prisma/client';

export interface DailyDungeonChamberDefinition {
  zoneId: string;
  displayName: string;
  /** Metadata de diseño (no cambia lógica): bucket de nivel recomendado de esta cámara. */
  tier: 'LOW' | 'MEDIUM' | 'HIGH';
  adenaMultiplier: number;
  expMultiplier: number;
  dropChanceMultiplier: number;
}

export interface DailyDungeonsConfigFile {
  version: number;
  ticketExpirySeconds: number;
  /**
   * `Partial`: el enum `DungeonChamberType` de Prisma conserva valores legacy (GOLD/EXPERIENCE/
   * DROP, pre-tiers) que ya no se definen en datos — ver el comentario del enum en schema.prisma.
   */
  chambers: Partial<Record<DungeonChamberType, DailyDungeonChamberDefinition>>;
}

function configDir(): string {
  return join(__dirname, '..', '..', 'config');
}

let cache: DailyDungeonsConfigFile | null = null;

export function loadDailyDungeonsConfig(): DailyDungeonsConfigFile {
  if (!cache) {
    const raw = readFileSync(join(configDir(), 'daily-dungeons.json'), 'utf8');
    cache = JSON.parse(raw) as DailyDungeonsConfigFile;
  }
  return cache;
}

export function resetDailyDungeonsConfigCache(): void {
  cache = null;
}

export function getAllChamberTypes(): DungeonChamberType[] {
  return Object.keys(loadDailyDungeonsConfig().chambers) as DungeonChamberType[];
}

export function getChamberDefinition(
  chamberType: DungeonChamberType,
): DailyDungeonChamberDefinition {
  const def = loadDailyDungeonsConfig().chambers[chamberType];
  if (!def) {
    throw new Error(`daily-dungeons.json: no hay definición para la cámara ${chamberType}`);
  }
  return def;
}

/** `undefined` si `zoneId` no es ninguna de las cámaras de mazmorra (zona normal del mundo). */
export function getChamberDefinitionByZoneId(
  zoneId: string | null | undefined,
): DailyDungeonChamberDefinition | undefined {
  if (!zoneId) {
    return undefined;
  }
  const chambers = loadDailyDungeonsConfig().chambers;
  return Object.values(chambers).find((c) => c.zoneId === zoneId);
}

export function isDungeonZoneId(zoneId: string | null | undefined): boolean {
  return getChamberDefinitionByZoneId(zoneId) !== undefined;
}

/** `{1,1,1}` fuera de mazmorra. Único punto que `combat.service.ts` consulta para aplicar las cámaras. */
export function resolveDungeonRewardMultipliers(zoneId: string | null | undefined): {
  expMultiplier: number;
  adenaMultiplier: number;
  dropChanceMultiplier: number;
} {
  const def = getChamberDefinitionByZoneId(zoneId);
  return {
    expMultiplier: def?.expMultiplier ?? 1,
    adenaMultiplier: def?.adenaMultiplier ?? 1,
    dropChanceMultiplier: def?.dropChanceMultiplier ?? 1,
  };
}
