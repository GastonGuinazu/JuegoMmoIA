import { Injectable } from '@nestjs/common';
import {
  GearSlot,
  ItemInstanceLocation,
  KarmaTier,
  type Character,
  type ItemInstance,
} from '@prisma/client';
import { toPlusLevelFromStoredSynthesisLevel } from '../synthesis/synthesis-level-normalizer';
import { loadKarmaRulesConfig } from './penalty-config.loaders';

export type KarmaFlag = 'WHITE' | 'PURPLE' | 'RED';

export type RedDropRollResult =
  | {
      shouldDrop: false;
      chance: number;
      totalValueScore: number;
    }
  | {
      shouldDrop: true;
      chance: number;
      totalValueScore: number;
      droppedItemInstanceId: string;
    };

@Injectable()
export class PenaltyManagerService {
  getKarmaFlagFromTier(tier: KarmaTier): KarmaFlag {
    if (tier === KarmaTier.TIER_III) {
      return 'RED';
    }
    if (tier === KarmaTier.TIER_II) {
      return 'PURPLE';
    }
    return 'WHITE';
  }

  getKarmaTierFromPoints(karmaPoints: number): KarmaTier {
    const cfg = loadKarmaRulesConfig();
    if (karmaPoints <= cfg.karmaThresholds.tier3MaxPoints) {
      return KarmaTier.TIER_III;
    }
    if (karmaPoints <= cfg.karmaThresholds.tier2MaxPoints) {
      return KarmaTier.TIER_II;
    }
    return KarmaTier.TIER_I;
  }

  applyUnjustifiedAttackTransition(params: {
    attacker: Pick<Character, 'karmaPoints' | 'karmaTier' | 'unjustifiedKillCount'>;
    victimTier: KarmaTier;
  }): {
    karmaPoints: number;
    karmaTier: KarmaTier;
    unjustifiedKillCount: number;
    changed: boolean;
  } {
    const { attacker, victimTier } = params;
    if (victimTier !== KarmaTier.TIER_I) {
      return {
        karmaPoints: attacker.karmaPoints,
        karmaTier: attacker.karmaTier,
        unjustifiedKillCount: attacker.unjustifiedKillCount,
        changed: false,
      };
    }
    const cfg = loadKarmaRulesConfig();
    const karmaPoints = attacker.karmaPoints + cfg.attackOnWhite.karmaPointsDelta;
    const computedTier = this.getKarmaTierFromPoints(karmaPoints);
    const karmaTier =
      computedTier === KarmaTier.TIER_I ? cfg.attackOnWhite.forceMinimumTier : computedTier;
    const changed =
      karmaTier !== attacker.karmaTier || karmaPoints !== attacker.karmaPoints;
    return {
      karmaPoints,
      karmaTier,
      unjustifiedKillCount: attacker.unjustifiedKillCount,
      changed,
    };
  }

  applyUnjustifiedKillTransition(params: {
    attacker: Pick<Character, 'karmaPoints' | 'karmaTier' | 'unjustifiedKillCount'>;
    victimTier: KarmaTier;
  }): {
    karmaPoints: number;
    karmaTier: KarmaTier;
    unjustifiedKillCount: number;
    changed: boolean;
  } {
    const { attacker, victimTier } = params;
    if (victimTier !== KarmaTier.TIER_I) {
      return {
        karmaPoints: attacker.karmaPoints,
        karmaTier: attacker.karmaTier,
        unjustifiedKillCount: attacker.unjustifiedKillCount,
        changed: false,
      };
    }
    const cfg = loadKarmaRulesConfig();
    const karmaPoints = attacker.karmaPoints + cfg.killOnWhite.karmaPointsDelta;
    const unjustifiedKillCount =
      attacker.unjustifiedKillCount + cfg.killOnWhite.unjustifiedKillIncrement;
    return {
      karmaPoints,
      karmaTier: cfg.killOnWhite.forceTier,
      unjustifiedKillCount,
      changed: true,
    };
  }

  rollRedDeathEquippedDrop(
    equippedItems: Array<Pick<ItemInstance, 'id' | 'valueScore' | 'gearSlot'>>,
    rng: () => number,
  ): RedDropRollResult {
    const cfg = loadKarmaRulesConfig();
    const candidates = equippedItems.filter((item) => item.gearSlot !== null);
    if (candidates.length === 0) {
      return {
        shouldDrop: false,
        chance: 0,
        totalValueScore: 0,
      };
    }
    const totalValueScore = candidates.reduce(
      (acc, item) => acc + Math.max(0, item.valueScore),
      0,
    );
    const chance = Math.min(
      cfg.redDeathDrop.maxChance,
      cfg.redDeathDrop.baseChance + totalValueScore * cfg.redDeathDrop.valueScoreFactor,
    );
    if (rng() > chance) {
      return { shouldDrop: false, chance, totalValueScore };
    }
    const poolWeight = candidates.reduce(
      (acc, item) => acc + Math.max(1, item.valueScore),
      0,
    );
    let roll = rng() * poolWeight;
    for (const item of candidates) {
      roll -= Math.max(1, item.valueScore);
      if (roll <= 0) {
        return {
          shouldDrop: true,
          chance,
          totalValueScore,
          droppedItemInstanceId: item.id,
        };
      }
    }
    const fallback = candidates[candidates.length - 1]!;
    return {
      shouldDrop: true,
      chance,
      totalValueScore,
      droppedItemInstanceId: fallback.id,
    };
  }

  resolveWeaponPlusLevel(
    equippedItems: Array<Pick<ItemInstance, 'gearSlot' | 'synthesisLevel'>>,
  ): number {
    const weapon = equippedItems.find((item) => item.gearSlot === GearSlot.WEAPON);
    if (!weapon) {
      return 0;
    }
    return toPlusLevelFromStoredSynthesisLevel(weapon.synthesisLevel);
  }

  isPvpFlagRelevantTier(tier: KarmaTier): boolean {
    return tier === KarmaTier.TIER_II || tier === KarmaTier.TIER_III;
  }

  canTriggerRedDrop(tier: KarmaTier): boolean {
    return tier === KarmaTier.TIER_III;
  }
}
