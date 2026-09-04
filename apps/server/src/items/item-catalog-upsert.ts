import type { PrismaClient } from '@prisma/client';
import { GearSlot } from '@prisma/client';
import { loadItemsConfig } from './items-config.loaders';
import { ITEM_GRADES, type ItemGrade } from './items-config.types';

/**
 * Persiste plantillas desde `config/items.json` (idempotente por `catalogKey`).
 */
export async function upsertItemTemplatesFromConfig(
  prisma: Pick<PrismaClient, 'itemTemplate'>,
): Promise<number> {
  const cfg = loadItemsConfig();
  const validSlots = new Set<string>(Object.values(GearSlot));
  const validGrades = new Set<string>(ITEM_GRADES);
  let n = 0;
  for (const it of cfg.items) {
    const slot =
      it.baseSlot !== null &&
      it.baseSlot !== undefined &&
      typeof it.baseSlot === 'string' &&
      validSlots.has(it.baseSlot)
        ? (it.baseSlot as GearSlot)
        : null;
    const normalizedGrade: ItemGrade =
      typeof it.grade === 'string' && validGrades.has(it.grade) ? it.grade : 'None';
    const baseStats = {
      ...(it.baseStats ?? {}),
      grade: normalizedGrade,
    } as object;
    await prisma.itemTemplate.upsert({
      where: { catalogKey: it.catalogKey },
      create: {
        name: it.name,
        description: it.description ?? null,
        catalogKey: it.catalogKey,
        baseSlot: slot,
        hasSubSlots: it.hasSubSlots === true,
        maxSubSlots: Math.max(0, Math.floor(it.maxSubSlots ?? 0)),
        subSlotType: it.subSlotType ?? null,
        parentSlotType: it.parentSlotType ?? null,
        icon: it.icon,
        baseStats,
      },
      update: {
        name: it.name,
        description: it.description ?? null,
        baseSlot: slot,
        hasSubSlots: it.hasSubSlots === true,
        maxSubSlots: Math.max(0, Math.floor(it.maxSubSlots ?? 0)),
        subSlotType: it.subSlotType ?? null,
        parentSlotType: it.parentSlotType ?? null,
        icon: it.icon,
        baseStats,
      },
    });
    n += 1;
  }
  return n;
}
