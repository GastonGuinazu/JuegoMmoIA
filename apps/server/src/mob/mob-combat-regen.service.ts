import { Injectable } from '@nestjs/common';

/** Ventana “caliente” tras cualquier intercambio de golpes (no curación al spawn hasta pasar paz). */
export const MOB_COMBAT_ACTIVITY_LOCK_MS = 10_000;

/** Solo daño **recibido** por el mob: bloquea leash / IDLE / retorno a casa (hard combat lock). */
export const MOB_HARD_COMBAT_LOCK_MS = 10_000;

/** Curación completa al spawn solo tras esta ventana sin actividad de combate (ambas direcciones). */
export const MOB_PEACE_FOR_FULL_HEAL_MS = 5_000;

/**
 * The Warden: timestamps de combate PvE por instancia de mob (RAM).
 */
@Injectable()
export class MobCombatRegenService {
  private readonly mobLastCombatActivityAtMs = new Map<string, number>();
  private readonly mobLastDamageReceivedAtMs = new Map<string, number>();
  private readonly mobLastDamageByCharacter = new Map<
    string,
    { characterId: string; atMs: number }
  >();

  /** Golpe recibido (jugador → mob): hard lock + actividad para paz/regen. */
  recordDamageReceived(
    mobInstanceId: string,
    atMs: number = Date.now(),
    attackerCharacterId?: string,
  ): void {
    this.mobLastDamageReceivedAtMs.set(mobInstanceId, atMs);
    this.mobLastCombatActivityAtMs.set(mobInstanceId, atMs);
    if (attackerCharacterId) {
      this.mobLastDamageByCharacter.set(mobInstanceId, {
        characterId: attackerCharacterId,
        atMs,
      });
    }
  }

  /** Golpe dado (mob → jugador): solo reinicia ventana de paz / “combat hot”, no hard lock. */
  recordMobDealtDamage(mobInstanceId: string, atMs: number = Date.now()): void {
    this.mobLastCombatActivityAtMs.set(mobInstanceId, atMs);
  }

  /**
   * `true` si hubo actividad de combate reciente (cualquier dirección) — p.ej. anti-regen pasivo.
   */
  isCombatActivityHot(mobInstanceId: string, nowMs: number = Date.now()): boolean {
    const last = this.mobLastCombatActivityAtMs.get(mobInstanceId);
    if (last === undefined) {
      return false;
    }
    return nowMs - last < MOB_COMBAT_ACTIVITY_LOCK_MS;
  }

  /** Alias legado: “regen lock” = combate reciente (10 s). */
  isRegenLocked(mobInstanceId: string, nowMs: number = Date.now()): boolean {
    return this.isCombatActivityHot(mobInstanceId, nowMs);
  }

  /**
   * Hard combat lock: el mob **recibió** daño hace poco — no se le fuerza IDLE ni retorno a casa.
   */
  isHardCombatLocked(mobInstanceId: string, nowMs: number = Date.now()): boolean {
    const last = this.mobLastDamageReceivedAtMs.get(mobInstanceId);
    if (last === undefined) {
      return false;
    }
    return nowMs - last < MOB_HARD_COMBAT_LOCK_MS;
  }

  /**
   * Ventana de paz para permitir curación completa al spawn (post-escape, sin intercambio reciente).
   */
  hasPeaceForMobFullHeal(
    mobInstanceId: string,
    nowMs: number = Date.now(),
    minPeaceMs: number = MOB_PEACE_FOR_FULL_HEAL_MS,
  ): boolean {
    const last = this.mobLastCombatActivityAtMs.get(mobInstanceId);
    if (last === undefined) {
      return true;
    }
    return nowMs - last >= minPeaceMs;
  }

  /** Daño recibido por el mob hace menos de `windowMs` (OOC heal off). */
  wasDamageReceivedWithin(
    mobInstanceId: string,
    nowMs: number,
    windowMs: number,
  ): boolean {
    const last = this.mobLastDamageReceivedAtMs.get(mobInstanceId);
    if (last === undefined) {
      return false;
    }
    return nowMs - last < windowMs;
  }

  getLatestDamageSource(
    mobInstanceId: string,
    nowMs: number,
    windowMs: number,
  ): { attackerCharacterId: string; atMs: number } | null {
    const row = this.mobLastDamageByCharacter.get(mobInstanceId);
    if (!row) {
      return null;
    }
    if (nowMs - row.atMs > windowMs) {
      return null;
    }
    return {
      attackerCharacterId: row.characterId,
      atMs: row.atMs,
    };
  }

  clear(mobInstanceId: string): void {
    this.mobLastCombatActivityAtMs.delete(mobInstanceId);
    this.mobLastDamageReceivedAtMs.delete(mobInstanceId);
    this.mobLastDamageByCharacter.delete(mobInstanceId);
  }
}
