import type { Prisma } from '@prisma/client';
import type { CoreStats, DerivedCombatStats } from './types/character-stats.types';
import { zeroCore, zeroDerived } from './types/character-stats.types';

const CORE_ALIASES: Record<string, keyof CoreStats | undefined> = {
  str: 'str',
  strength: 'str',
  agi: 'agi',
  agility: 'agi',
  vit: 'vit',
  vitality: 'vit',
  ene: 'ene',
  energy: 'ene',
};

const DERIVED_ALIASES: Record<string, keyof DerivedCombatStats | undefined> = {
  patk: 'pAtk',
  p_atk: 'pAtk',
  physicalattack: 'pAtk',
  matk: 'mAtk',
  m_atk: 'mAtk',
  magicattack: 'mAtk',
  pdef: 'pDef',
  p_def: 'pDef',
  physicaldefense: 'pDef',
  physicaldefence: 'pDef',
  mdef: 'mDef',
  m_def: 'mDef',
  magicdefense: 'mDef',
  magicdefence: 'mDef',
  atkspeed: 'atkSpeed',
  atk_speed: 'atkSpeed',
  attackspeed: 'atkSpeed',
  critrate: 'critRate',
  crit_rate: 'critRate',
  criticalrate: 'critRate',
};

function normalizeKey(k: string): string {
  return k.replace(/\s+/g, '').toLowerCase();
}

/**
 * Separa pares planos de `ItemTemplate.baseStats` en núcleo vs derivados.
 * Claves camelCase estándar: str, agi, vit, ene, pAtk, mAtk, pDef, atkSpeed, critRate.
 */
export function parseTemplateBaseStats(
  raw: Prisma.JsonValue,
): {
  core: CoreStats;
  derivedFlat: DerivedCombatStats;
  derivedPercent: DerivedCombatStats;
} {
  const core = zeroCore();
  const derivedFlat = zeroDerived();
  const derivedPercent = zeroDerived();

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { core, derivedFlat, derivedPercent };
  }

  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      continue;
    }
    const nk = normalizeKey(key);

    const ck = CORE_ALIASES[nk];
    if (ck) {
      core[ck] += val;
      continue;
    }

    if (
      nk === 'patk' ||
      nk === 'matk' ||
      nk === 'pdef' ||
      nk === 'mdef' ||
      nk === 'atkspeed' ||
      nk === 'critrate'
    ) {
      const dk = DERIVED_ALIASES[nk];
      if (dk) derivedFlat[dk] += val;
      continue;
    }

    if (key === 'str' || key === 'agi' || key === 'vit' || key === 'ene') {
      core[key] += val;
      continue;
    }
    if (
      key === 'pAtk' ||
      key === 'mAtk' ||
      key === 'pDef' ||
      key === 'mDef' ||
      key === 'atkSpeed' ||
      key === 'critRate'
    ) {
      derivedFlat[key] += val;
    }
  }

  return { core, derivedFlat, derivedPercent };
}

export type AffixJson = unknown;

/**
 * Formato flexible: `[{ "flat": { "str": 2, "pAtk": 5 }, "percent": { "pAtk": 3 } }]`
 */
export function mergeAffixBonuses(
  affixes: Prisma.JsonValue,
): {
  core: CoreStats;
  derivedFlat: DerivedCombatStats;
  derivedPercent: DerivedCombatStats;
} {
  const core = zeroCore();
  const derivedFlat = zeroDerived();
  const derivedPercent = zeroDerived();

  if (!Array.isArray(affixes)) {
    return { core, derivedFlat, derivedPercent };
  }

  for (const entry of affixes) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const o = entry as Record<string, unknown>;
    const flat = o.flat;
    const percent = o.percent;
    if (flat && typeof flat === 'object' && !Array.isArray(flat)) {
      const parsed = parseTemplateBaseStats(flat as Prisma.JsonValue);
      addCore(core, parsed.core);
      addDerived(derivedFlat, parsed.derivedFlat);
      addDerived(derivedPercent, parsed.derivedPercent);
    }
    if (percent && typeof percent === 'object' && !Array.isArray(percent)) {
      const parsed = parseTemplateBaseStats(percent as Prisma.JsonValue);
      addDerived(derivedPercent, parsed.derivedFlat);
      addDerived(derivedPercent, parsed.derivedPercent);
    }
  }

  return { core, derivedFlat, derivedPercent };
}

function addCore(a: CoreStats, b: CoreStats): void {
  a.str += b.str;
  a.agi += b.agi;
  a.vit += b.vit;
  a.ene += b.ene;
}

function addDerived(a: DerivedCombatStats, b: DerivedCombatStats): void {
  a.pAtk += b.pAtk;
  a.mAtk += b.mAtk;
  a.pDef += b.pDef;
  a.mDef += b.mDef;
  a.atkSpeed += b.atkSpeed;
  a.critRate += b.critRate;
}
