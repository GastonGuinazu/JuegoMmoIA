import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SynthesisTierRow {
  fromLevel: number;
  baseSuccessPercent: number;
  maxPityConsecutiveFails: number;
  adenaCost: string;
  pityBonusPerFailPercent: number;
  statBonusPercent?: number;
}

export interface SynthesisTierConfigFile {
  maxSynthesisLevel: number;
  tiers: SynthesisTierRow[];
}

let cached: SynthesisTierConfigFile | null = null;

export function loadSynthesisTierConfig(): SynthesisTierConfigFile {
  if (cached) {
    return cached;
  }
  const path = join(__dirname, '..', '..', 'config', 'synthesis-tiers.json');
  const raw = readFileSync(path, 'utf8');
  cached = JSON.parse(raw) as SynthesisTierConfigFile;
  return cached;
}

export function findTierForCurrentLevel(
  config: SynthesisTierConfigFile,
  currentSynthesisLevel: number,
): SynthesisTierRow | undefined {
  return config.tiers.find((t) => t.fromLevel === currentSynthesisLevel);
}

export function resolveAccumulatedStatBonusPercent(
  config: SynthesisTierConfigFile,
  synthesisLevel: number,
): number {
  if (!Number.isFinite(synthesisLevel) || synthesisLevel <= 1) {
    return 0;
  }
  const current = Math.floor(synthesisLevel);
  return config.tiers
    .filter((tier) => tier.fromLevel < current)
    .reduce((acc, tier) => acc + (tier.statBonusPercent ?? 0), 0);
}
