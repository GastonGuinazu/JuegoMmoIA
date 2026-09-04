import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** Convención data-driven: `ItemTemplate.baseStats.requirements` (no mezclar con bonos planos del ítem). */
export interface ItemRequirements {
  minLevel?: number;
  minStr?: number;
  minAgi?: number;
  minVit?: number;
  minEne?: number;
}

export interface CharacterRequirementContext {
  level: number;
  statStr: number;
  statAgi: number;
  statVit: number;
  statEne: number;
}

function parseRequirements(raw: Prisma.JsonValue): ItemRequirements {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const root = raw as Record<string, unknown>;
  const block = root.requirements;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    return {};
  }
  const r = block as Record<string, unknown>;
  const out: ItemRequirements = {};
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const n = (v: unknown): number | undefined => {
    const x = num(v);
    if (x === undefined) return undefined;
    return Math.floor(x);
  };
  out.minLevel = n(r.minLevel);
  out.minStr = n(r.minStr);
  out.minAgi = n(r.minAgi);
  out.minVit = n(r.minVit);
  out.minEne = n(r.minEne);
  return out;
}

/**
 * Valida nivel y stats **base** del personaje (sin equipo), para evitar dependencias circulares al equipar.
 */
export function assertMeetsItemRequirements(
  character: CharacterRequirementContext,
  baseStats: Prisma.JsonValue,
): void {
  const req = parseRequirements(baseStats);
  const failures: string[] = [];

  if (req.minLevel !== undefined && character.level < req.minLevel) {
    failures.push(
      `requires character level ${req.minLevel} (current: ${character.level})`,
    );
  }
  if (req.minStr !== undefined && character.statStr < req.minStr) {
    failures.push(
      `requires base STR ${req.minStr} (current: ${character.statStr})`,
    );
  }
  if (req.minAgi !== undefined && character.statAgi < req.minAgi) {
    failures.push(
      `requires base AGI ${req.minAgi} (current: ${character.statAgi})`,
    );
  }
  if (req.minVit !== undefined && character.statVit < req.minVit) {
    failures.push(
      `requires base VIT ${req.minVit} (current: ${character.statVit})`,
    );
  }
  if (req.minEne !== undefined && character.statEne < req.minEne) {
    failures.push(
      `requires base ENE ${req.minEne} (current: ${character.statEne})`,
    );
  }

  if (failures.length > 0) {
    throw new BadRequestException({
      code: 'ITEM_REQUIREMENTS_NOT_MET',
      message:
        'Character does not meet this item requirements (server-authoritative check on base stats and level).',
      failures,
      required: req,
      current: {
        level: character.level,
        statStr: character.statStr,
        statAgi: character.statAgi,
        statVit: character.statVit,
        statEne: character.statEne,
      },
    });
  }
}
