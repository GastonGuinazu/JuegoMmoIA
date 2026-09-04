export const ITEM_GRADES = ['None', 'D', 'C', 'B', 'A', 'S'] as const;
export type ItemGrade = (typeof ITEM_GRADES)[number];

export type ItemTemplateConfigEntry = {
  catalogKey: string;
  name: string;
  grade: ItemGrade;
  description?: string;
  /**
   * `GearSlot` de Prisma para equipables, o `null` para consumibles / no equipables.
   */
  baseSlot: string | null;
  hasSubSlots?: boolean;
  maxSubSlots?: number;
  subSlotType?: string | null;
  parentSlotType?: string | null;
  icon: string;
  /** Bonos planos / reqs; ver `ItemTemplate.baseStats` en Prisma. */
  baseStats?: Record<string, unknown>;
};

export type ItemsConfigFile = {
  version: number;
  items: ItemTemplateConfigEntry[];
};
