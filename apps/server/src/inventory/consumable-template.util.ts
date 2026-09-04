/**
 * Lectura data-driven de meta de consumibles desde `ItemTemplate.baseStats` (JSON).
 */

export type ConsumableHealMeta = {
  consumable: true;
  healAmount: number;
};

export function parseConsumableHealMeta(baseStats: unknown): ConsumableHealMeta | null {
  if (!baseStats || typeof baseStats !== 'object') {
    return null;
  }
  const o = baseStats as Record<string, unknown>;
  if (o.consumable !== true) {
    return null;
  }
  const raw = o.healAmount;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return { consumable: true, healAmount: Math.floor(n) };
}
