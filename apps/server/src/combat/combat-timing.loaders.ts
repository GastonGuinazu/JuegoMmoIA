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
