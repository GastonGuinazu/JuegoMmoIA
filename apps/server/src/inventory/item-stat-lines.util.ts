import type { Prisma } from '@prisma/client';
import { parseTemplateBaseStats } from '../character/item-stats.util';
import {
  loadSynthesisTierConfig,
  resolveAccumulatedStatBonusPercent,
} from '../synthesis/synthesis-tier-config';
import {
  DERIVED_KEYS,
  type DerivedStatKey,
} from '../character/types/character-stats.types';

const D_LABEL: Record<DerivedStatKey, string> = {
  pAtk: 'P.Atk',
  mAtk: 'M.Atk',
  pDef: 'P.Def',
  atkSpeed: 'Atk.Sp',
  critRate: 'Crit',
};

function fmtNum(n: number): string {
  if (Number.isInteger(n)) {
    return String(n);
  }
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/** Líneas listas para tooltip UI (bonos de plantilla, sin requisitos). */
export function buildItemStatLines(
  baseStats: Prisma.JsonValue,
  synthesisLevel: number,
): string[] {
  const { core, derivedFlat, derivedPercent } = parseTemplateBaseStats(baseStats);
  const lines: string[] = [];
  const tierConfig = loadSynthesisTierConfig();
  const statBonusPct = resolveAccumulatedStatBonusPercent(tierConfig, synthesisLevel);
  const statMultiplier = 1 + statBonusPct / 100;

  for (const k of DERIVED_KEYS) {
    const v = derivedFlat[k];
    if (v !== 0) {
      lines.push(formatScaledLine(D_LABEL[k], v, statMultiplier));
    }
    const p = derivedPercent[k];
    if (p !== 0) {
      const sign = p > 0 ? '+' : '';
      lines.push(`${D_LABEL[k]}: ${sign}${fmtNum(p)}%`);
    }
  }

  const coreLabels: [keyof typeof core, string][] = [
    ['str', 'STR'],
    ['agi', 'AGI'],
    ['vit', 'VIT'],
    ['ene', 'ENE'],
  ];
  for (const [key, label] of coreLabels) {
    const v = core[key];
    if (v !== 0) {
      lines.push(formatScaledLine(label, v, statMultiplier));
    }
  }

  return lines;
}

function formatScaledLine(label: string, baseValue: number, multiplier: number): string {
  const scaled = baseValue * multiplier;
  if (multiplier === 1) {
    return `${label}: ${fmtNum(scaled)}`;
  }
  const delta = scaled - baseValue;
  const deltaSign = delta > 0 ? '+' : '';
  return `${label}: ${fmtNum(scaled)} (${deltaSign}${fmtNum(delta)})`;
}
