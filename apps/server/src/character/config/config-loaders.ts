import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreStatKey, DerivedStatKey } from '../types/character-stats.types';

export interface ClassDefinition {
  displayName: string;
  initialLevel: number;
  initialStats: { str: number; agi: number; vit: number; ene: number };
  coreContributionScalars: Record<
    CoreStatKey,
    Record<DerivedStatKey, number>
  >;
  derivedOutputMultipliers: Record<DerivedStatKey, number>;
}

export interface CharacterClassesConfigFile {
  version: number;
  classes: Record<string, ClassDefinition>;
}

export interface StatDerivationConfigFile {
  version: number;
  baseConstants: Record<DerivedStatKey, number>;
  perPointContributions: Record<DerivedStatKey, Record<CoreStatKey, number>>;
  perCharacterLevel: Record<DerivedStatKey, number>;
  limits: {
    critRateMax: number;
    atkSpeedMin: number;
    atkSpeedMax: number;
  };
}

export interface SynthesisEquipmentBonusesFile {
  version: number;
  flatPerSynthesisLevelAboveOne: Record<DerivedStatKey, number>;
  coreFlatPerSynthesisLevelAboveOne: Record<'str' | 'agi' | 'vit' | 'ene', number>;
}

function configDir(): string {
  return join(__dirname, '..', '..', '..', 'config');
}

let classesCache: CharacterClassesConfigFile | null = null;
let derivationCache: StatDerivationConfigFile | null = null;
let synthesisEquipCache: SynthesisEquipmentBonusesFile | null = null;

export interface CharacterVitalsConfigFile {
  version: number;
  baseMaxHp: number;
  perCharacterLevel: number;
  perEffectiveVitPoint: number;
  baseMaxMp?: number;
  perCharacterLevelMp?: number;
  perEffectiveEnePoint?: number;
  outOfCombatSeconds?: number;
  regenIntervalMs?: number;
  regenBasePercentOfMaxHp?: number;
  regenPerEffectiveVitPercentOfMaxHp?: number;
}

let vitalsCache: CharacterVitalsConfigFile | null = null;

export function loadCharacterClassesConfig(): CharacterClassesConfigFile {
  if (!classesCache) {
    const raw = readFileSync(
      join(configDir(), 'character-classes.json'),
      'utf8',
    );
    classesCache = JSON.parse(raw) as CharacterClassesConfigFile;
  }
  return classesCache;
}

export function loadStatDerivationConfig(): StatDerivationConfigFile {
  if (!derivationCache) {
    const raw = readFileSync(
      join(configDir(), 'stat-derivation.json'),
      'utf8',
    );
    derivationCache = JSON.parse(raw) as StatDerivationConfigFile;
  }
  return derivationCache;
}

export function loadSynthesisEquipmentBonusesConfig(): SynthesisEquipmentBonusesFile {
  if (!synthesisEquipCache) {
    const raw = readFileSync(
      join(configDir(), 'synthesis-equipment-bonuses.json'),
      'utf8',
    );
    synthesisEquipCache = JSON.parse(raw) as SynthesisEquipmentBonusesFile;
  }
  return synthesisEquipCache;
}

export function loadCharacterVitalsConfig(): CharacterVitalsConfigFile {
  if (!vitalsCache) {
    const raw = readFileSync(
      join(configDir(), 'character-vitals.json'),
      'utf8',
    );
    vitalsCache = JSON.parse(raw) as CharacterVitalsConfigFile;
  }
  return vitalsCache;
}

/** Tests / hot-reload futuro */
export function resetCharacterConfigCache(): void {
  classesCache = null;
  derivationCache = null;
  synthesisEquipCache = null;
  vitalsCache = null;
}
