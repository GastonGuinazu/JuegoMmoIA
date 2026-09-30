/**
 * Lectura data-driven de meta de consumibles desde `ItemTemplate.baseStats` (JSON).
 */

export type ConsumableHealMeta = {
  consumable: true;
  /** HP a restaurar (0 si este consumible no toca HP, p. ej. una poción de maná). */
  healAmount: number;
  /** MP a restaurar (0 si este consumible no toca MP, p. ej. una poción de vida). */
  manaAmount: number;
};

export function parseConsumableHealMeta(baseStats: unknown): ConsumableHealMeta | null {
  if (!baseStats || typeof baseStats !== 'object') {
    return null;
  }
  const o = baseStats as Record<string, unknown>;
  if (o.consumable !== true) {
    return null;
  }
  const toAmount = (raw: unknown): number => {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const healAmount = toAmount(o.healAmount);
  const manaAmount = toAmount(o.manaAmount);
  if (healAmount <= 0 && manaAmount <= 0) {
    return null;
  }
  return { consumable: true, healAmount, manaAmount };
}
