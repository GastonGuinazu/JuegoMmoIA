import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getWorldZoneDefinition } from './world-zones.loaders';
import { normalizeZoneId } from '../world-zone.util';

/**
 * Política de respawn por muerte. Data-driven: este archivo decide **a qué zona** vuelve el
 * personaje y con cuánta vida; las coordenadas son siempre el `entrySpawn` de `world-zones.json`.
 */
export interface WorldSpawnConfigFile {
  version: number;
  deathRespawn: {
    /** `true`: revive en la zona donde murió. `false`: siempre en `fallbackZoneId`. */
    respawnInDeathZone: boolean;
    /** Zona usada si la de muerte no existe en `world-zones.json` (o si la política es fija). */
    fallbackZoneId: string;
    hpPercentOfMax: number;
  };
}

export interface ResolvedRespawnTarget {
  zoneId: string;
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
}

const DEFAULTS: WorldSpawnConfigFile['deathRespawn'] = {
  respawnInDeathZone: true,
  fallbackZoneId: 'Zone_0',
  hpPercentOfMax: 0.35,
};

function configDir(): string {
  return join(__dirname, '..', '..', '..', 'config');
}

let cache: WorldSpawnConfigFile | null = null;

export function loadWorldSpawnConfig(): WorldSpawnConfigFile {
  if (!cache) {
    const raw = readFileSync(join(configDir(), 'world-spawn.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      version?: number;
      deathRespawn?: Partial<WorldSpawnConfigFile['deathRespawn']>;
    };
    const d: Partial<WorldSpawnConfigFile['deathRespawn']> =
      parsed.deathRespawn ?? {};
    cache = {
      version: parsed.version ?? 2,
      deathRespawn: {
        respawnInDeathZone:
          typeof d.respawnInDeathZone === 'boolean'
            ? d.respawnInDeathZone
            : DEFAULTS.respawnInDeathZone,
        fallbackZoneId: d.fallbackZoneId ?? DEFAULTS.fallbackZoneId,
        hpPercentOfMax:
          typeof d.hpPercentOfMax === 'number' && d.hpPercentOfMax > 0
            ? d.hpPercentOfMax
            : DEFAULTS.hpPercentOfMax,
      },
    };
  }
  return cache;
}

export function resetWorldSpawnConfigCache(): void {
  cache = null;
}

/**
 * Punto autoritativo de resurrección. Nunca devuelve coordenadas de `world-spawn.json`:
 * siempre el `entrySpawn` de una zona declarada en `world-zones.json`.
 */
export function resolveRespawnTarget(
  deathZoneId: string | null | undefined,
): ResolvedRespawnTarget {
  const policy = loadWorldSpawnConfig().deathRespawn;
  const preferredZoneId = policy.respawnInDeathZone
    ? normalizeZoneId(deathZoneId)
    : policy.fallbackZoneId;

  const zone =
    getWorldZoneDefinition(preferredZoneId) ??
    getWorldZoneDefinition(policy.fallbackZoneId);
  if (!zone) {
    throw new Error(
      `world-zones.json: no hay zona de respawn resoluble (intentado "${preferredZoneId}" y fallback "${policy.fallbackZoneId}")`,
    );
  }

  return {
    zoneId: zone.zoneId,
    worldPos: { ...zone.entrySpawn.worldPos },
    worldFacingYaw: zone.entrySpawn.worldFacingYaw,
  };
}
