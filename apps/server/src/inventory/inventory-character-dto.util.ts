import type { Character } from '@prisma/client';
import type { CharacterSheetDto } from '@aetheris/shared-types';
import type { StatEngineService } from '../character/stat-engine.service';
import { computeSwingCooldownMs } from '../combat/combat-timing.loaders';

export function buildCharacterSheetDto(
  c: Character,
  vitals: { currentHp: number; maxHp: number },
  statEngine: Pick<StatEngineService, 'experienceRequiredForNextOrZero'>,
  effectiveCore?: { str: number; agi: number; vit: number; ene: number },
): CharacterSheetDto {
  return {
    characterId: c.id,
    name: c.name,
    characterClass: c.characterClass,
    level: c.level,
    experience: c.experience,
    experienceRequiredForNext: statEngine.experienceRequiredForNextOrZero(c.level),
    availableStatPoints: c.availableStatPoints,
    isAdmin: c.isAdmin,
    core: {
      str: effectiveCore?.str ?? c.statStr,
      agi: effectiveCore?.agi ?? c.statAgi,
      vit: effectiveCore?.vit ?? c.statVit,
      ene: effectiveCore?.ene ?? c.statEne,
    },
    derived: {
      pAtk: c.derivedPAtk,
      mAtk: c.derivedMAtk,
      pDef: c.derivedPDef,
      mDef: c.derivedMDef,
      atkSpeed: c.derivedAtkSpeed,
      critRate: c.derivedCritRate,
      pvpSwingCooldownMs: computeSwingCooldownMs(c.derivedAtkSpeed),
    },
    vitals,
  };
}
