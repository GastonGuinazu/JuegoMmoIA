import type { Prisma } from '@prisma/client';
import { ITEM_GRADES, type ItemGrade } from './items-config.types';

const VALID_GRADES = new Set<string>(ITEM_GRADES);

const MIN_LEVEL_BY_GRADE: Record<ItemGrade, number> = {
  None: 0,
  D: 20,
  C: 40,
  B: 52,
  A: 0,
  S: 0,
};

export function parseItemGradeFromBaseStats(baseStats: Prisma.JsonValue): ItemGrade {
  if (baseStats === null || typeof baseStats !== 'object' || Array.isArray(baseStats)) {
    return 'None';
  }
  const raw = (baseStats as Record<string, unknown>).grade;
  if (typeof raw !== 'string' || !VALID_GRADES.has(raw)) {
    return 'None';
  }
  return raw as ItemGrade;
}

export function minLevelForGrade(grade: ItemGrade): number {
  return MIN_LEVEL_BY_GRADE[grade];
}
