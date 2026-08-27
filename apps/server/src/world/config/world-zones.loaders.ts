import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorldZoneEntrySpawn {
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
}

export interface WorldZoneDefinition {
  zoneId: string;
  displayName: string;
  minCharacterLevel: number;
  mapObjectsFile: string;
  /** Visual Weaver: archivo en `apps/client/public/models/textures/`. El servidor lo ignora. */
  groundAlbedo?: string;
  /**
   * Lado del plano jugable (metros). Half-extent = size/2. Default 128.
   * Debe cubrir hunting grounds (spots ±32 + boss x=48) con margen; no el vacío de 256.
   */
  groundSizeMeters?: number;
  entrySpawn: WorldZoneEntrySpawn;
}

export interface WorldZonesConfigFile {
  version: number;
  zones: WorldZoneDefinition[];
}

function configDir(): string {
  return join(__dirname, '..', '..', '..', 'config');
}

let cache: WorldZonesConfigFile | null = null;

export function loadWorldZonesConfig(): WorldZonesConfigFile {
  if (!cache) {
    const raw = readFileSync(join(configDir(), 'world-zones.json'), 'utf8');
    cache = JSON.parse(raw) as WorldZonesConfigFile;
  }
  return cache;
}

export function resetWorldZonesConfigCache(): void {
  cache = null;
}

export function getWorldZoneDefinition(zoneId: string): WorldZoneDefinition | undefined {
  const zid = zoneId === 'default' || !zoneId ? 'Zone_0' : zoneId;
  return loadWorldZonesConfig().zones.find((z) => z.zoneId === zid);
}

const DEFAULT_GROUND_SIZE_METERS = 128;
const MIN_GROUND_SIZE_METERS = 48;
const MAX_GROUND_SIZE_METERS = 256;

/** Lado del plano jugable. Recorte Cartographer: 128 cubre cuadrantes ±32 y boss x=48. */
export function getZoneGroundSizeMeters(zoneId: string | null | undefined): number {
  const def = getWorldZoneDefinition(zoneId === 'default' || !zoneId ? 'Zone_0' : zoneId);
  const raw = def?.groundSizeMeters ?? DEFAULT_GROUND_SIZE_METERS;
  if (!Number.isFinite(raw)) {
    return DEFAULT_GROUND_SIZE_METERS;
  }
  return Math.max(MIN_GROUND_SIZE_METERS, Math.min(MAX_GROUND_SIZE_METERS, raw));
}

export function clampAxisToPlayable(zoneId: string | null | undefined, value: number): number {
  const half = getZoneGroundSizeMeters(zoneId) / 2 - 0.5;
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-half, Math.min(half, value));
}
