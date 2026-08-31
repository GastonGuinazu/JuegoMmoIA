import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeZoneId } from '../world/world-zone.util';
import type { MobTemplateDefinition, MobsConfigFile, SpawnSpotDefinition } from './mob-config.types';

function configDir(): string {
  return join(__dirname, '..', '..', 'config');
}

let cache: MobsConfigFile | null = null;

export function loadMobsConfig(): MobsConfigFile {
  // Cache por proceso; nest --watch recarga el módulo al tocar este archivo.
  // Tras cambiar spawnSpots hay que correr `npx tsx scripts/seed-mobs.ts`.
  if (!cache) {
    const raw = readFileSync(join(configDir(), 'mobs.json'), 'utf8');
    cache = JSON.parse(raw) as MobsConfigFile;
  }
  return cache;
}

export function resetMobsConfigCache(): void {
  cache = null;
}

export function getSpawnSpotsFromConfig(): SpawnSpotDefinition[] {
  return loadMobsConfig().spawnSpots ?? [];
}

function spotCirclesOverlapXZ(a: SpawnSpotDefinition, b: SpawnSpotDefinition): boolean {
  if (normalizeZoneId(a.zoneId) !== normalizeZoneId(b.zoneId)) {
    return false;
  }
  const dx = a.center.x - b.center.x;
  const dz = a.center.z - b.center.z;
  const dist = Math.hypot(dx, dz);
  return dist < a.radius + b.radius;
}

/**
 * Regla de oro Cartographer: dos spots que se solapan en XZ no pueden mezclar familias sociales
 * ni niveles que difieran en más de 2 (evita pulls injustos vía Social Link).
 */
export function assertSpawnSpotsSocialCoherence(cfg: MobsConfigFile): void {
  const spots = cfg.spawnSpots ?? [];
  const byKey = new Map(cfg.mobs.map((m) => [m.templateKey, m] as const));
  for (const s of spots) {
    if (!byKey.has(s.templateKey)) {
      throw new Error(
        `SpawnSpot "${s.id}": templateKey "${s.templateKey}" no existe en mobs[]`,
      );
    }
    if (!(s.radius > 0) || !Number.isFinite(s.radius)) {
      throw new Error(`SpawnSpot "${s.id}": radius debe ser un número finito > 0`);
    }
    if (!(s.maxEntities >= 1) || !Number.isFinite(s.maxEntities)) {
      throw new Error(`SpawnSpot "${s.id}": maxEntities debe ser entero ≥ 1`);
    }
  }
  for (let i = 0; i < spots.length; i += 1) {
    for (let j = i + 1; j < spots.length; j += 1) {
      const a = spots[i]!;
      const b = spots[j]!;
      if (!spotCirclesOverlapXZ(a, b)) {
        continue;
      }
      const ma = byKey.get(a.templateKey)!;
      const mb = byKey.get(b.templateKey)!;
      const fa = ma.socialFamily?.trim() || null;
      const fb = mb.socialFamily?.trim() || null;
      if (fa && fb && fa !== fb) {
        throw new Error(
          `SpawnSpots "${a.id}" y "${b.id}" se solapan pero socialFamily distinta (${fa} vs ${fb})`,
        );
      }
      const la = getMobLevelForTemplateKey(a.templateKey);
      const lb = getMobLevelForTemplateKey(b.templateKey);
      if (Math.abs(la - lb) > 2) {
        throw new Error(
          `SpawnSpots "${a.id}" (nivel ${la}) y "${b.id}" (nivel ${lb}) se solapan: niveles deben estar a ±2`,
        );
      }
    }
  }
}

export function getMobDefinitionByTemplateKey(
  templateKey: string,
): MobTemplateDefinition | undefined {
  return loadMobsConfig().mobs.find((m) => m.templateKey === templateKey);
}

const MELEE_CD_MIN_MS = 320;
const MELEE_CD_MAX_MS = 2400;
const MELEE_HIT_DELAY_MAX_MS = 800;

/** GCD melee por template; `fallbackMs` viene de `combat-timing.json`. */
export function resolveMobMeleeCooldownMs(templateKey: string, fallbackMs: number): number {
  const raw = getMobDefinitionByTemplateKey(templateKey)?.meleeCooldownMs ?? fallbackMs;
  if (!Number.isFinite(raw)) {
    return Math.max(MELEE_CD_MIN_MS, Math.min(MELEE_CD_MAX_MS, fallbackMs));
  }
  return Math.max(MELEE_CD_MIN_MS, Math.min(MELEE_CD_MAX_MS, Math.floor(raw)));
}

/** Telegraph → contacto. 0 = daño inmediato. */
export function resolveMobMeleeHitDelayMs(templateKey: string): number {
  const raw = getMobDefinitionByTemplateKey(templateKey)?.meleeHitDelayMs ?? 0;
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(MELEE_HIT_DELAY_MAX_MS, Math.floor(raw)));
}

/** nest --watch: tocar este archivo recarga meleeCooldownMs de mobs.json (ogre/boss 1000). */

export function getRespawnDelayMsForTemplateKey(templateKey: string): number {
  const def = getMobDefinitionByTemplateKey(templateKey);
  return def?.respawnDelayMs ?? 15000;
}

/** Intervalo del reconciliador de respawn (Cartographer). */
export function getRespawnSweepIntervalMs(): number {
  const raw = loadMobsConfig().respawnSweepIntervalMs;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1000) {
    return raw;
  }
  return 10000;
}

function finitePositiveSpeed(raw: number | undefined, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return fallback;
}

/**
 * Velocidad persistida en `MobTemplate.moveSpeed` (columna única de Prisma).
 * Se guarda el chase para que cualquier lector legacy no quede más lento que el combate.
 */
export function resolvePersistedMobMoveSpeed(def: MobTemplateDefinition): number {
  return finitePositiveSpeed(
    def.chaseSpeed ?? def.moveSpeed ?? def.baseMoveSpeed,
    4.5,
  );
}

/**
 * Warden 20 TPS: patrulla usa `baseMoveSpeed`; CHASE usa `chaseSpeed`.
 */
export function resolveMobAiMoveSpeed(
  templateKey: string,
  mode: 'patrol' | 'chase',
  dbMoveSpeed: number,
): number {
  const def = getMobDefinitionByTemplateKey(templateKey);
  const db = finitePositiveSpeed(dbMoveSpeed, 4.5);
  const base = finitePositiveSpeed(def?.baseMoveSpeed ?? def?.moveSpeed, db);
  const chase = finitePositiveSpeed(def?.chaseSpeed ?? def?.moveSpeed, db);
  return Math.max(0.5, mode === 'chase' ? chase : base);
}

export function getAggroRadiusForTemplateKey(templateKey: string): number {
  const def = getMobDefinitionByTemplateKey(templateKey);
  const raw = def?.aggroRadius ?? def?.aggroRange ?? 10;
  if (!Number.isFinite(raw)) {
    return 10;
  }
  return Math.max(1, raw);
}

export function getSocialLinkRadiusForTemplateKey(templateKey: string): number {
  const def = getMobDefinitionByTemplateKey(templateKey);
  const raw = def?.socialLinkRadius ?? 8;
  if (!Number.isFinite(raw)) {
    return 8;
  }
  return Math.max(5, Math.min(10, raw));
}

export function getSocialFamilyForTemplateKey(
  templateKey: string,
): string | null {
  const def = getMobDefinitionByTemplateKey(templateKey);
  const family = def?.socialFamily?.trim();
  return family ? family : null;
}

function inferLevelFromTemplateKey(templateKey: string): number {
  const key = templateKey.toLowerCase();
  const explicit = key.match(/(?:^|[_-])(lv|lvl|level)[_-]?(\d{1,3})(?:$|[_-])/i);
  if (explicit?.[2]) {
    const parsed = Number(explicit[2]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  const trailing = key.match(/(\d{1,3})$/);
  if (trailing?.[1]) {
    const parsed = Number(trailing[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return 1;
}

export function getMobLevelForTemplateKey(templateKey: string): number {
  const def = getMobDefinitionByTemplateKey(templateKey);
  const configured = def?.level;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return inferLevelFromTemplateKey(templateKey);
}

/**
 * Warden: mob "gris" — el jugador tiene ≥10 niveles por encima del mob → 0 XP y 0 loot (incl. Adena).
 */
export function isGreyMobNoBenefitPenalty(
  characterLevel: number,
  mobLevel: number,
): boolean {
  return characterLevel - mobLevel >= 10;
}
