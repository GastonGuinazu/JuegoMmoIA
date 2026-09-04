import type { ItemInstance, ItemTemplate } from '@prisma/client';
import { buildItemStatLines } from './item-stat-lines.util';
import { parseItemGradeFromBaseStats } from '../items/item-grade.util';
import { toPlusLevelFromStoredSynthesisLevel } from '../synthesis/synthesis-level-normalizer';

function templateIsConsumable(baseStats: unknown): boolean {
  if (!baseStats || typeof baseStats !== 'object') {
    return false;
  }
  return (baseStats as Record<string, unknown>).consumable === true;
}

export function mapInventoryItemInstanceToRow(
  i: ItemInstance & { template: ItemTemplate },
  all: (ItemInstance & { template: ItemTemplate })[] = [],
): {
  id: string;
  itemTemplateId: string;
  name: string;
  catalogKey: string | null;
  icon: string;
  quantity: number;
  location: string;
  gearSlot: string | null;
  baseSlot: string | null;
  synthesisLevel: number;
  plusLevel: number;
  grade: 'None' | 'D' | 'C' | 'B' | 'A' | 'S';
  statLines: string[];
  consumable: boolean;
  hasSubSlots: boolean;
  maxSubSlots: number;
  subSlotType: string | null;
  parentSlotType: string | null;
  parentItemInstanceId: string | null;
  parentSubSlotIndex: number | null;
  subItems: {
    id: string;
    name: string;
    parentSubSlotIndex: number | null;
  }[];
} {
  const subItems = all
    .filter((row) => row.parentItemInstanceId === i.id)
    .map((row) => ({
      id: row.id,
      name: row.template.name,
      parentSubSlotIndex: row.parentSubSlotIndex,
    }))
    .sort((a, b) => (a.parentSubSlotIndex ?? 999) - (b.parentSubSlotIndex ?? 999));
  return {
    id: i.id,
    itemTemplateId: i.itemTemplateId,
    name: i.template.name,
    catalogKey: i.template.catalogKey,
    icon: i.template.icon,
    quantity: i.quantity,
    location: i.location,
    gearSlot: i.gearSlot,
    baseSlot: i.template.baseSlot,
    synthesisLevel: i.synthesisLevel,
    plusLevel: toPlusLevelFromStoredSynthesisLevel(i.synthesisLevel),
    grade: parseItemGradeFromBaseStats(i.template.baseStats),
    statLines: buildItemStatLines(i.template.baseStats, i.synthesisLevel),
    consumable: templateIsConsumable(i.template.baseStats),
    hasSubSlots: i.template.hasSubSlots,
    maxSubSlots: i.template.maxSubSlots,
    subSlotType: i.template.subSlotType,
    parentSlotType: i.template.parentSlotType,
    parentItemInstanceId: i.parentItemInstanceId,
    parentSubSlotIndex: i.parentSubSlotIndex,
    subItems,
  };
}
