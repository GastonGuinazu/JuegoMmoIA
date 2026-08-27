import type { CharacterClass } from '@prisma/client';

export type CoreStatKey = 'STR' | 'AGI' | 'VIT' | 'ENE';

export type DerivedStatKey = 'pAtk' | 'mAtk' | 'pDef' | 'atkSpeed' | 'critRate';

export interface CoreStats {
  str: number;
  agi: number;
  vit: number;
  ene: number;
}

export interface DerivedCombatStats {
  pAtk: number;
  mAtk: number;
  pDef: number;
  atkSpeed: number;
  critRate: number;
}

export interface StatComputationContext {
  characterClass: CharacterClass;
  characterLevel: number;
  baseCore: CoreStats;
  equipment: EquipmentStatTotals;
}

/** Totales de equipo ya agregados (plantilla + instancia + síntesis + affixes). */
export interface EquipmentStatTotals {
  coreFlat: CoreStats;
  derivedFlat: DerivedCombatStats;
  /** Porcentajes enteros que se suman antes de aplicar 1 + total/100 (ej. 5 + 3 → 8%). */
  derivedPercentSum: DerivedCombatStats;
}

export const DERIVED_KEYS: DerivedStatKey[] = [
  'pAtk',
  'mAtk',
  'pDef',
  'atkSpeed',
  'critRate',
];

export const CORE_KEYS: CoreStatKey[] = ['STR', 'AGI', 'VIT', 'ENE'];

export function zeroCore(): CoreStats {
  return { str: 0, agi: 0, vit: 0, ene: 0 };
}

export function zeroDerived(): DerivedCombatStats {
  return { pAtk: 0, mAtk: 0, pDef: 0, atkSpeed: 0, critRate: 0 };
}

export function coreFromCharacterRow(row: {
  statStr: number;
  statAgi: number;
  statVit: number;
  statEne: number;
}): CoreStats {
  return {
    str: row.statStr,
    agi: row.statAgi,
    vit: row.statVit,
    ene: row.statEne,
  };
}

export function coreStatValue(core: CoreStats, key: CoreStatKey): number {
  switch (key) {
    case 'STR':
      return core.str;
    case 'AGI':
      return core.agi;
    case 'VIT':
      return core.vit;
    case 'ENE':
      return core.ene;
  }
}
