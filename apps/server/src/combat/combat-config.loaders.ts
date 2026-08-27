import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadWorldZonesConfig,
  resetWorldZonesConfigCache,
} from '../world/config/world-zones.loaders';

export interface CombatDamageConfigFile {
  version: number;
  physicalMitigationFactor: number;
  magicalMitigationFactor: number;
  minimumDamage: number;
  criticalMultiplier: number;
  /**
   * Soft-cap de defensa para mob → jugador. Evita que P.Def de personaje (escala ~100)
   * anule pAtk de template (escala ~10–50) vía resta lineal.
   */
  mobToPlayerDefenseSoftCap?: number;
}

export interface WorldSpatialConfigFile {
  version: number;
  characterBaseMeleeReach: number;
  extraInteractionSlack: number;
  /** Alcance base autoritativo de auto-ataque del jugador (sin buffers de red). */
  playerAutoAttackRangeMeters?: number;
  /** Buffer autoritativo para tolerancia mínima de posición en auto-ataque melee. */
  playerAutoAttackRangeBufferMeters?: number;
  /**
   * Buffer extra (latencia) para melee mob → jugador. No reutilizar el stack de
   * alcance del jugador (`characterBaseMeleeReach` + prediction slack).
   */
  mobMeleeRangeBufferMeters?: number;
  rearConeTotalDegrees: number;
  backstabDamageMultiplier: number;
  baseWorldMoveSpeed?: number;
  worldMoveSpeedMin?: number;
  worldMoveSpeedMax?: number;
  worldMoveSpeedAtkSpeedFactor?: number;
  movementValidationSlackRatio?: number;
  movementMinDtSeconds?: number;
  movementMaxDtSeconds?: number;
  movementMaxVerticalStep?: number;
  /** Metros extra solo en validación de ataque (predicción cliente / latencia). */
  attackReachPredictionSlackMeters?: number;
  /** Distancia jugador–drop para `PICK_ITEM` (Warden). */
  worldDropPickupRadiusMeters?: number;
  /** Distancia jugador–NPC para tienda / `NPC_INTERACT`. */
  npcInteractionRadiusMeters?: number;
  /** Leash de IA (metros XZ desde spawn del mob). */
  mobAiLeashRadiusMeters?: number;
  /** Cartographer: tamaño de celda para navegación A* en CHASE. */
  navGridCellSizeMeters?: number;
  /** Padding extra de búsqueda (celdas) alrededor del bbox from->to. */
  navGridPaddingCells?: number;
  /** Límite defensivo de expansiones A* por consulta de path. */
  navGridMaxExpandedNodes?: number;
  /** Fallback global del radio social de auxilio de mobs (si no viene en template). */
  mobSocialLinkRadiusMeters?: number;
  /** Radio de cuerpo XZ para no apilar mobs en CHASE (Warden). */
  mobBodyRadiusMeters?: number;
  /**
   * Anillo de hold alrededor del jugador = max(attackRange * factor, hueco de pack).
   * < 1 para quedar dentro de melee y no caminar al centro del target.
   */
  mobChaseRingFactor?: number;
}

export interface SkillConfigRow {
  id: string;
  name: string;
  targetType: 'single' | 'aoe';
  isAoe?: boolean;
  aoeRadius?: number;
  manaCost: number;
  damageMultiplier: number;
  cooldownMs: number;
  rangeMeters: number;
}

export interface SkillsConfigFile {
  version: number;
  skills: SkillConfigRow[];
}

export interface MapBoxObstacleConfigRow {
  id: string;
  zoneId?: string;
  kind: 'box';
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  /** Margen extra de colisión en metros (XZ). */
  collisionPaddingMeters?: number;
  /** Visual Weaver (`prop-visual-catalog`). El Warden no lo usa. */
  propTemplateKey?: string;
  /** Yaw visual (radianes). El AABB de colisión no rota. */
  yaw?: number;
  /**
   * `false` = deco caminable (senderos y micro-props). El Warden y el navgrid lo ignoran.
   * Default `true` (bloquea).
   */
  blocksMovement?: boolean;
}

export interface MapPortalConfigRow {
  id: string;
  zoneId?: string;
  kind: 'portal';
  position: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  targetZoneId: string;
  /** Texto de feedback en el log del cliente (Weaver). */
  portalTravelMessage?: string;
  interactionRadiusMeters?: number;
  propTemplateKey?: string;
  yaw?: number;
}

export type MapObjectConfigRow = MapBoxObstacleConfigRow | MapPortalConfigRow;

/** Senderos y deco con `blocksMovement: false` no entran al AABB ni al navgrid. */
export function isMapBoxBlockingMovement(
  row: MapObjectConfigRow | null | undefined,
): row is MapBoxObstacleConfigRow {
  if (!row || (row as { kind?: string }).kind === 'portal') {
    return false;
  }
  return (row as MapBoxObstacleConfigRow).blocksMovement !== false;
}

/** @deprecated Usar `MapBoxObstacleConfigRow` para colisión; `MapObjectConfigRow` incluye portales. */
export type MapObstacleConfigRow = MapBoxObstacleConfigRow;

export interface MapObjectsConfigFile {
  version: number;
  objects: MapObjectConfigRow[];
}

function configDir(): string {
  return join(__dirname, '..', '..', 'config');
}

let combatCache: CombatDamageConfigFile | null = null;
let spatialCache: WorldSpatialConfigFile | null = null;
let skillsCache: SkillsConfigFile | null = null;
let mapObjectsCache: MapObjectsConfigFile | null = null;

export function loadCombatDamageConfig(): CombatDamageConfigFile {
  if (!combatCache) {
    const raw = readFileSync(join(configDir(), 'combat-damage.json'), 'utf8');
    combatCache = JSON.parse(raw) as CombatDamageConfigFile;
  }
  return combatCache;
}

export function loadWorldSpatialConfig(): WorldSpatialConfigFile {
  if (!spatialCache) {
    const raw = readFileSync(join(configDir(), 'world-spatial.json'), 'utf8');
    spatialCache = JSON.parse(raw) as WorldSpatialConfigFile;
  }
  return spatialCache;
}

export function loadSkillsConfig(): SkillsConfigFile {
  if (!skillsCache) {
    const raw = readFileSync(join(configDir(), 'skills.json'), 'utf8');
    skillsCache = JSON.parse(raw) as SkillsConfigFile;
  }
  return skillsCache;
}

export function loadMapObjectsConfig(): MapObjectsConfigFile {
  if (!mapObjectsCache) {
    const zones = loadWorldZonesConfig().zones;
    const objects: MapObjectConfigRow[] = [];
    for (const z of zones) {
      const raw = readFileSync(join(configDir(), z.mapObjectsFile), 'utf8');
      const parsed = JSON.parse(raw) as Partial<MapObjectsConfigFile>;
      const rows = Array.isArray(parsed.objects) ? parsed.objects : [];
      for (const o of rows) {
        if (!o || typeof o !== 'object' || typeof (o as MapObjectConfigRow).id !== 'string') {
          continue;
        }
        const row = o as MapObjectConfigRow;
        const withZone: MapObjectConfigRow = {
          ...row,
          zoneId: row.zoneId ?? z.zoneId,
        };
        objects.push(withZone);
      }
    }
    mapObjectsCache = { version: 1, objects };
  }
  return mapObjectsCache;
}

export function findMapPortalById(portalId: string): MapPortalConfigRow | undefined {
  const rows = loadMapObjectsConfig().objects;
  for (const o of rows) {
    if (o.kind === 'portal' && o.id === portalId) {
      return o;
    }
  }
  return undefined;
}

export function resetCombatConfigCache(): void {
  combatCache = null;
  spatialCache = null;
  skillsCache = null;
  mapObjectsCache = null;
  resetWorldZonesConfigCache();
}
