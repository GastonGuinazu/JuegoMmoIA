export interface MobDropRoll {
  chance: number;
  min: number;
  max: number;
}

export interface MobDropItemEntry {
  catalogKey: string;
  chance: number;
  minQty: number;
  maxQty: number;
}

export interface MobDropTable {
  adenaRolls?: MobDropRoll[];
  items?: MobDropItemEntry[];
}

export interface MobTemplateDefinition {
  templateKey: string;
  displayName: string;
  /** Nivel PvE autoritativo para reglas de progresión y loot. */
  level?: number;
  maxHp: number;
  /** Daño físico base (mob → jugador). */
  pAtk: number;
  pDef: number;
  mDef?: number;
  /** XP otorgada al matar (Warden). Preferido sobre `expReward` legacy. */
  baseExperience?: number;
  /** @deprecated Usar `baseExperience`. */
  expReward?: number;
  attackRange?: number;
  /**
   * GCD melee mob→jugador (ms). Si falta, el runtime usa `combat-timing.json` (`mobMeleeCooldownMs`).
   */
  meleeCooldownMs?: number;
  /**
   * Retraso entre el telegraph del swing (clip de ataque) y el daño autoritativo (ms).
   * 0 = daño en el mismo tick que el clip. Ogro/boss usan ~250–350 para no pegar en el wind-up.
   */
  meleeHitDelayMs?: number;
  /** Radio de aggro / percepción. */
  aggroRange?: number;
  /**
   * Alias preferido de producto para percepción PvE.
   * Si existe, sobrescribe `aggroRange` legacy.
   */
  aggroRadius?: number;
  /**
   * Radio de "auxilio social": mobs del mismo tipo en este rango
   * pueden entrar en CHASE contra el atacante al recibir señal.
   */
  socialLinkRadius?: number;
  /**
   * Familia social opcional para permitir asistencia entre templates distintos.
   * Si no existe, el filtro social cae a mismo template.
   */
  socialFamily?: string;
  /**
   * Velocidad de patrulla / retorno (unidades/s). Si falta, se usa `moveSpeed` legacy.
   */
  baseMoveSpeed?: number;
  /**
   * Velocidad en CHASE (unidades/s). Debe quedar cerca del player base (~6) para
   * poder cerrar gap sin hacer el kite imposible.
   */
  chaseSpeed?: number;
  /**
   * Alias legacy de velocidad única (patrulla y chase). Preferir `baseMoveSpeed` + `chaseSpeed`.
   */
  moveSpeed?: number;
  /** Delay antes de respawn en la posición original (MobRespawnService). */
  respawnDelayMs?: number;
  dropTable: MobDropTable;
}

/**
 * Cartographer: mancha de spawn data-driven (sin dispersión masiva aleatoria).
 * Un spot usa un solo `templateKey` → misma socialFamily y nivel (coherente con Social Link).
 */
export interface SpawnSpotDefinition {
  id: string;
  zoneId: string;
  center: { x: number; y: number; z: number };
  radius: number;
  templateKey: string;
  maxEntities: number;
}

export interface MobsConfigFile {
  version: number;
  mobs: MobTemplateDefinition[];
  /** Spots PvE por zona; validación ±2 niveles / misma familia entre spots que se solapan. */
  spawnSpots?: SpawnSpotDefinition[];
  /**
   * Cada cuánto reconcilia `MobRespawnService` los mobs muertos contra la DB.
   * Es la red de seguridad que hace el ciclo de respawn resistente a reinicios
   * y a temporizadores en memoria perdidos.
   */
  respawnSweepIntervalMs?: number;
}
