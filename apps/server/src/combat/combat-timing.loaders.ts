import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CombatTimingConfigFile {
  version: number;
  baseSwingCooldownMs: number;
  minCooldownMs: number;
  maxCooldownMs: number;
  mobMeleeCooldownMs?: number;
}

function configDir(): string {
  return join(__dirname, '..', '..', 'config');
}

/** Cache por proceso; nest --watch recarga al tocar este archivo (GCD mob default 900 ms). */

let cache: CombatTimingConfigFile | null = null;

export function loadCombatTimingConfig(): CombatTimingConfigFile {
  if (!cache) {
    const raw = readFileSync(join(configDir(), 'combat-timing.json'), 'utf8');
    cache = JSON.parse(raw) as CombatTimingConfigFile;
  }
  return cache;
}

export function resetCombatTimingCache(): void {
  cache = null;
}

/**
 * Único lugar donde vive esta fórmula: GCD de swing básico (PvE contra mob, PvE
 * auto-attack loop y PvP) a partir de `atkSpeed`. Antes estaba inline y duplicada en
 * `combat.service.ts` (dos veces) y `player-combat-runtime.service.ts`. El cliente NO la
 * recalcula para PvP: recibe el resultado ya resuelto en `derived.pvpSwingCooldownMs`
 * para espaciar sus reintentos de ataque a jugador sin arriesgarse a quedar
 * desactualizado si el balance cambia en `combat-timing.json`.
 */
export function computeSwingCooldownMs(atkSpeed: number): number {
  const timing = loadCombatTimingConfig();
  const safeAtkSpeed = Math.max(0.65, atkSpeed);
  const cooldownMs = timing.baseSwingCooldownMs / safeAtkSpeed;
  return Math.min(timing.maxCooldownMs, Math.max(timing.minCooldownMs, cooldownMs));
}
