import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KarmaTier } from '@prisma/client';

export interface KarmaRulesConfigFile {
  version: number;
  karmaThresholds: {
    tier2MaxPoints: number;
    tier3MaxPoints: number;
  };
  attackOnWhite: {
    karmaPointsDelta: number;
    forceMinimumTier: KarmaTier;
  };
  killOnWhite: {
    karmaPointsDelta: number;
    unjustifiedKillIncrement: number;
    forceTier: KarmaTier;
  };
  redDeathDrop: {
    baseChance: number;
    valueScoreFactor: number;
    maxChance: number;
  };
}

function configDir(): string {
  return join(__dirname, '..', '..', 'config');
}

let cache: KarmaRulesConfigFile | null = null;

export function loadKarmaRulesConfig(): KarmaRulesConfigFile {
  if (!cache) {
    const raw = readFileSync(join(configDir(), 'karma-rules.json'), 'utf8');
    cache = JSON.parse(raw) as KarmaRulesConfigFile;
  }
  return cache;
}

export function resetKarmaRulesConfigCache(): void {
  cache = null;
}
