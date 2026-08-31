import { CharacterClass } from '@prisma/client';
import { loadCombatDamageConfig } from './combat-config.loaders';

export function rollPlayerToMobMeleeDamage(params: {
  characterClass: CharacterClass;
  derivedPAtk: number;
  derivedMAtk: number;
  derivedCritRate: number;
  mobPDef: number;
  mobMDef: number;
  facingDamageMultiplier: number;
  rng: () => number;
}): { damage: number; critical: boolean } {
  const dmgCfg = loadCombatDamageConfig();
  const isMage = params.characterClass === CharacterClass.DARK_WIZARD;
  const atkStat = isMage ? params.derivedMAtk : params.derivedPAtk;
  const mobMit = isMage ? params.mobMDef : params.mobPDef;
  const factor = isMage
    ? dmgCfg.magicalMitigationFactor
    : dmgCfg.physicalMitigationFactor;
  const baseMitigated = atkStat - mobMit * factor;
  const afterFacing = baseMitigated * params.facingDamageMultiplier;
  const critical = params.rng() < params.derivedCritRate;
  let damage = Math.floor(
    critical ? afterFacing * dmgCfg.criticalMultiplier : afterFacing,
  );
  if (!Number.isFinite(damage) || damage < dmgCfg.minimumDamage) {
    damage = dmgCfg.minimumDamage;
  }
  return { damage, critical };
}

/**
 * Mob → jugador: mitigación porcentual data-driven.
 * `pAtk - P.Def` (o `pAtk - P.Def * factor`) aplasta el golpe a 1 porque el P.Def
 * derivado del personaje (~100+) y el pAtk de template (~10–50) no comparten escala.
 */
export function resolveMobToPlayerMeleeDamage(params: {
  mobPAtk: number;
  derivedPDef: number;
}): number {
  const dmgCfg = loadCombatDamageConfig();
  const atk = Number.isFinite(params.mobPAtk) ? Math.max(0, params.mobPAtk) : 0;
  const pDef = Number.isFinite(params.derivedPDef) ? Math.max(0, params.derivedPDef) : 0;
  const factor = dmgCfg.physicalMitigationFactor;
  const softCap =
    typeof dmgCfg.mobToPlayerDefenseSoftCap === 'number' &&
    Number.isFinite(dmgCfg.mobToPlayerDefenseSoftCap) &&
    dmgCfg.mobToPlayerDefenseSoftCap > 0
      ? dmgCfg.mobToPlayerDefenseSoftCap
      : 80;
  const effectiveDef = pDef * factor;
  const mitigation = effectiveDef / (effectiveDef + softCap);
  const damage = Math.floor(atk * (1 - mitigation));
  if (!Number.isFinite(damage) || damage < dmgCfg.minimumDamage) {
    return dmgCfg.minimumDamage;
  }
  return damage;
}
