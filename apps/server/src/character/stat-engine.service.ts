import { Injectable, NotFoundException } from '@nestjs/common';
import type { Character, ItemInstance, ItemTemplate } from '@prisma/client';
import { ItemInstanceLocation } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { minLevelForGrade, parseItemGradeFromBaseStats } from '../items/item-grade.util';
import {
  loadCharacterClassesConfig,
  loadCharacterVitalsConfig,
  loadStatDerivationConfig,
  loadSynthesisEquipmentBonusesConfig,
} from './config/config-loaders';
import { toPlusLevelFromStoredSynthesisLevel } from '../synthesis/synthesis-level-normalizer';
import {
  loadSynthesisTierConfig,
  resolveAccumulatedStatBonusPercent,
} from '../synthesis/synthesis-tier-config';
import { loadExperienceCurveConfig } from './config/experience.loaders';
import { mergeAffixBonuses, parseTemplateBaseStats } from './item-stats.util';
import {
  CORE_KEYS,
  DERIVED_KEYS,
  type CoreStats,
  type DerivedCombatStats,
  type EquipmentStatTotals,
  coreFromCharacterRow,
  coreStatValue,
  zeroCore,
  zeroDerived,
} from './types/character-stats.types';

export type EquippedRow = ItemInstance & { template: ItemTemplate };

@Injectable()
export class StatEngineService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * XP para pasar del nivel `level` al siguiente según `config/experience-curve.json`.
   * `level` es el nivel actual del personaje antes de subir.
   */
  experienceRequiredToAdvanceFromLevel(level: number): number {
    const L = Math.max(1, Math.floor(level));
    const cfg = loadExperienceCurveConfig();
    const base = cfg.xpFormula?.base ?? 100;
    const exponent = cfg.xpFormula?.exponent ?? 1.5;
    const levelScalar = cfg.xpFormula?.levelScalar ?? 1;
    return Math.max(1, Math.ceil(base * Math.pow(L * levelScalar, exponent)));
  }

  /** 0 si ya está en tope de nivel configurado. */
  experienceRequiredForNextOrZero(level: number): number {
    const max = loadExperienceCurveConfig().maxLevel;
    if (level >= max) {
      return 0;
    }
    return this.experienceRequiredToAdvanceFromLevel(level);
  }

  /**
   * Skill Warden: núcleo + equipo (plantilla + síntesis + affixes) → derivados de combate.
   */
  computeDerivedStats(
    characterClass: Character['characterClass'],
    level: number,
    baseCore: CoreStats,
    equipped: EquippedRow[],
  ): DerivedCombatStats {
    const equipment = this.aggregateEquipmentTotals(equipped);
    const classes = loadCharacterClassesConfig();
    const classKey = characterClass as string;
    const classDef = classes.classes[classKey];
    if (!classDef) {
      throw new Error(`Unknown character class in config: ${classKey}`);
    }
    const deriv = loadStatDerivationConfig();

    const effectiveCore: CoreStats = {
      str: baseCore.str + equipment.coreFlat.str,
      agi: baseCore.agi + equipment.coreFlat.agi,
      vit: baseCore.vit + equipment.coreFlat.vit,
      ene: baseCore.ene + equipment.coreFlat.ene,
    };

    const out = zeroDerived();

    for (const d of DERIVED_KEYS) {
      let sum = deriv.baseConstants[d] + level * deriv.perCharacterLevel[d];
      for (const c of CORE_KEYS) {
        const perPoint = deriv.perPointContributions[d][c];
        const classScalar = classDef.coreContributionScalars[c][d];
        sum += coreStatValue(effectiveCore, c) * perPoint * classScalar;
      }
      sum *= classDef.derivedOutputMultipliers[d];
      sum += equipment.derivedFlat[d];
      const pct = equipment.derivedPercentSum[d];
      if (pct !== 0) {
        sum *= 1 + pct / 100;
      }
      out[d] = sum;
    }

    const gradePenaltyActive = this.hasGradePenalty(level, equipped);
    if (gradePenaltyActive) {
      out.pAtk *= 0.5;
      out.atkSpeed *= 0.5;
    }

    if (out.critRate > deriv.limits.critRateMax) {
      out.critRate = deriv.limits.critRateMax;
    }
    if (out.critRate < 0) {
      out.critRate = 0;
    }
    if (out.atkSpeed < deriv.limits.atkSpeedMin) {
      out.atkSpeed = deriv.limits.atkSpeedMin;
    }
    if (out.atkSpeed > deriv.limits.atkSpeedMax) {
      out.atkSpeed = deriv.limits.atkSpeedMax;
    }

    return out;
  }

  hasGradePenalty(level: number, equipped: EquippedRow[]): boolean {
    for (const row of equipped) {
      const grade = parseItemGradeFromBaseStats(row.template.baseStats);
      const minLevel = minLevelForGrade(grade);
      if (level < minLevel) {
        return true;
      }
    }
    return false;
  }

  async hasGradePenaltyForCharacter(
    characterId: string,
    db: Pick<PrismaService, 'character'> = this.prisma,
  ): Promise<boolean> {
    const character = await db.character.findUnique({
      where: { id: characterId },
      include: {
        items: {
          where: { location: ItemInstanceLocation.EQUIPPED },
          include: { template: true },
        },
      },
    });
    if (!character) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }
    return this.hasGradePenalty(character.level, character.items as EquippedRow[]);
  }

  /**
   * Max HP desde VIT efectivo + nivel (tabla `character-vitals.json`).
   */
  computeMaxHp(characterLevel: number, effectiveVit: number): number {
    const v = loadCharacterVitalsConfig();
    const raw =
      v.baseMaxHp +
      characterLevel * v.perCharacterLevel +
      effectiveVit * v.perEffectiveVitPoint;
    return Math.max(1, Math.floor(raw));
  }

  computeMaxHpForLoadedCharacter(
    character: Character & { items: EquippedRow[] },
  ): number {
    const effectiveVit = this.getEffectiveVitality(character);
    return this.computeMaxHp(character.level, effectiveVit);
  }

  /** VIT base + equipo (regen / fórmulas que dependen de VIT efectivo). */
  getEffectiveVitality(character: Character & { items: EquippedRow[] }): number {
    return this.computeEffectiveCoreForLoadedCharacter(character).vit;
  }

  computeEffectiveCoreForLoadedCharacter(
    character: Character & { items: EquippedRow[] },
  ): CoreStats {
    const baseCore = coreFromCharacterRow(character);
    const equippedOnly = character.items.filter(
      (i) => i.location === ItemInstanceLocation.EQUIPPED,
    );
    const equipment = this.aggregateEquipmentTotals(equippedOnly);
    return {
      str: baseCore.str + equipment.coreFlat.str,
      agi: baseCore.agi + equipment.coreFlat.agi,
      vit: baseCore.vit + equipment.coreFlat.vit,
      ene: baseCore.ene + equipment.coreFlat.ene,
    };
  }

  async getEffectiveCoreStats(
    characterId: string,
    db: Pick<PrismaService, 'character'> = this.prisma,
  ): Promise<CoreStats> {
    const character = await db.character.findUnique({
      where: { id: characterId },
      include: {
        items: {
          where: { location: ItemInstanceLocation.EQUIPPED },
          include: { template: true },
        },
      },
    });
    if (!character) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }
    return this.computeEffectiveCoreForLoadedCharacter(
      character as Character & { items: EquippedRow[] },
    );
  }

  /**
   * Vitales desde fila ya cargada (usa `currentHp` persistido, acotado a maxHp).
   */
  getCombatVitalsFromLoaded(
    character: Character & { items: EquippedRow[] },
  ): { currentHp: number; maxHp: number } {
    const maxHp = this.computeMaxHpForLoadedCharacter(character);
    let cur = character.currentHp;
    if (cur > maxHp) {
      cur = maxHp;
    }
    if (cur < 0) {
      cur = 0;
    }
    return { currentHp: cur, maxHp };
  }

  /**
   * Vitales de combate para UI / sockets.
   */
  async getCombatVitals(
    characterId: string,
    db: Pick<PrismaService, 'character'> = this.prisma,
  ): Promise<{ currentHp: number; maxHp: number }> {
    const character = await db.character.findUnique({
      where: { id: characterId },
      include: {
        items: {
          where: { location: ItemInstanceLocation.EQUIPPED },
          include: { template: true },
        },
      },
    });
    if (!character) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }
    return this.getCombatVitalsFromLoaded(character as Character & { items: EquippedRow[] });
  }

  aggregateEquipmentTotals(equipped: EquippedRow[]): EquipmentStatTotals {
    const coreFlat = zeroCore();
    const derivedFlat = zeroDerived();
    const derivedPercentSum = zeroDerived();
    const syn = loadSynthesisEquipmentBonusesConfig();
    const synthesisTierConfig = loadSynthesisTierConfig();
    const childrenByParent = new Map<string, EquippedRow[]>();
    for (const row of equipped) {
      if (!row.parentItemInstanceId) {
        continue;
      }
      const group = childrenByParent.get(row.parentItemInstanceId) ?? [];
      group.push(row);
      childrenByParent.set(row.parentItemInstanceId, group);
    }

    const applyItemBonusesRecursive = (row: EquippedRow): void => {
      const tpl = parseTemplateBaseStats(row.template.baseStats);
      const statScaleMultiplier = this.getSynthesisStatScaleMultiplier(
        row.synthesisLevel,
        synthesisTierConfig,
      );
      addCore(coreFlat, scaleCore(tpl.core, statScaleMultiplier));
      addDerived(derivedFlat, scaleDerived(tpl.derivedFlat, statScaleMultiplier));
      addDerived(derivedPercentSum, tpl.derivedPercent);

      const aff = mergeAffixBonuses(row.randomAffixes);
      addCore(coreFlat, scaleCore(aff.core, statScaleMultiplier));
      addDerived(derivedFlat, scaleDerived(aff.derivedFlat, statScaleMultiplier));
      addDerived(derivedPercentSum, aff.derivedPercent);

      const plusLevel = toPlusLevelFromStoredSynthesisLevel(row.synthesisLevel);
      if (plusLevel > 0) {
        for (const d of DERIVED_KEYS) {
          const inc = syn.flatPerSynthesisLevelAboveOne[d] ?? 0;
          derivedFlat[d] += inc * plusLevel;
        }
        coreFlat.str +=
          (syn.coreFlatPerSynthesisLevelAboveOne.str ?? 0) * plusLevel;
        coreFlat.agi +=
          (syn.coreFlatPerSynthesisLevelAboveOne.agi ?? 0) * plusLevel;
        coreFlat.vit +=
          (syn.coreFlatPerSynthesisLevelAboveOne.vit ?? 0) * plusLevel;
        coreFlat.ene +=
          (syn.coreFlatPerSynthesisLevelAboveOne.ene ?? 0) * plusLevel;
      }
      const children = childrenByParent.get(row.id) ?? [];
      for (const child of children) {
        applyItemBonusesRecursive(child);
      }
    };

    const roots = equipped.filter((row) => row.parentItemInstanceId === null);
    for (const root of roots) {
      applyItemBonusesRecursive(root);
    }

    return { coreFlat, derivedFlat, derivedPercentSum };
  }

  private getSynthesisStatScaleMultiplier(
    synthesisLevel: number,
    tierConfig = loadSynthesisTierConfig(),
  ): number {
    const bonusPct = resolveAccumulatedStatBonusPercent(tierConfig, synthesisLevel);
    return 1 + bonusPct / 100;
  }

  /**
   * Persiste derivados. Si se pasa `db` (p. ej. `tx` de `$transaction`), el recálculo es atómico con el resto del Ledger.
   */
  async recalculateAndPersistCharacter(
    characterId: string,
    db: Pick<PrismaService, 'character'> = this.prisma,
    opts?: { fullHeal?: boolean },
  ): Promise<Character> {
    const character = await db.character.findUnique({
      where: { id: characterId },
      include: {
        items: {
          where: { location: ItemInstanceLocation.EQUIPPED },
          include: { template: true },
        },
      },
    });
    if (!character) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }

    const baseCore = coreFromCharacterRow(character);
    const derived = this.computeDerivedStats(
      character.characterClass,
      character.level,
      baseCore,
      character.items as EquippedRow[],
    );

    const maxHp = this.computeMaxHpForLoadedCharacter(
      character as Character & { items: EquippedRow[] },
    );
    let nextHp = opts?.fullHeal ? maxHp : character.currentHp;
    if (!opts?.fullHeal) {
      if (nextHp > maxHp) {
        nextHp = maxHp;
      }
      if (nextHp < 0) {
        nextHp = 0;
      }
    }

    return db.character.update({
      where: { id: characterId },
      data: {
        derivedPAtk: derived.pAtk,
        derivedMAtk: derived.mAtk,
        derivedPDef: derived.pDef,
        derivedAtkSpeed: derived.atkSpeed,
        derivedCritRate: derived.critRate,
        currentHp: nextHp,
      },
    });
  }
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
  a.atkSpeed += b.atkSpeed;
  a.critRate += b.critRate;
}

function scaleCore(stats: CoreStats, multiplier: number): CoreStats {
  if (multiplier === 1) {
    return stats;
  }
  return {
    str: stats.str * multiplier,
    agi: stats.agi * multiplier,
    vit: stats.vit * multiplier,
    ene: stats.ene * multiplier,
  };
}

function scaleDerived(
  stats: DerivedCombatStats,
  multiplier: number,
): DerivedCombatStats {
  if (multiplier === 1) {
    return stats;
  }
  return {
    pAtk: stats.pAtk * multiplier,
    mAtk: stats.mAtk * multiplier,
    pDef: stats.pDef * multiplier,
    atkSpeed: stats.atkSpeed * multiplier,
    critRate: stats.critRate * multiplier,
  };
}
