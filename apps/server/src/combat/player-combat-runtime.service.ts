import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { CharacterClass } from '@prisma/client';
import { StatEngineService } from '../character/stat-engine.service';
import { loadCharacterVitalsConfig } from '../character/config/config-loaders';
import { PrismaService } from '../prisma/prisma.service';
import {
  WS_WORLD_EVENTS,
  type WsAttackMobDeniedPayload,
  type WsAttackMobResultPayload,
  type WsAttackMobRewardsPayload,
  type WsGradePenaltyStatusPayload,
  type WsLevelUpPayload,
  type WsMobDeathPayload,
  type WsPlayerVitalsPayload,
  type WsSkillHitResultPayload,
} from '@aetheris/shared-types';
import { WorldSocketBridgeService } from '../world/world-socket-bridge.service';
import { WorldPresenceService } from '../world/world-presence.service';
import { WorldSpatialService } from '../world/world-spatial.service';
import { MobCombatRegenService } from '../mob/mob-combat-regen.service';
import { CombatService, type RuntimeMobKillCommitPlan } from './combat.service';
import { PendingWorldDropService } from '../world/pending-world-drop.service';
import { loadCombatTimingConfig } from './combat-timing.loaders';
import { loadSkillsConfig } from './combat-config.loaders';
import {
  resolveMobMeleeCooldownMs,
  resolveMobMeleeHitDelayMs,
} from '../mob/mob-config.loaders';
import { normalizeZoneId, zonesMatch } from '../world/world-zone.util';
import { resolveMobToPlayerMeleeDamage, rollPlayerToMobMeleeDamage } from './pve-melee-damage.util';
import { DamageContributionTrackerService } from './damage-contribution-tracker.service';

type CharPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  zoneId: string;
};

type CharCombatStats = {
  characterClass: CharacterClass;
  derivedPAtk: number;
  derivedMAtk: number;
  derivedCritRate: number;
  derivedAtkSpeed: number;
  derivedPDef: number;
  currentHp: number;
  maxHp: number;
  currentMp: number;
  maxMp: number;
  hpDirty: boolean;
};

type MobRuntimeRow = {
  currentHp: number;
  maxHp: number;
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  zoneId: string | null;
  mobTemplateKey: string;
  pDef: number;
  mDef: number;
  mobAttackRange: number;
  expReward: number;
  dropTable: unknown;
  dirty: boolean;
  /** Muerte optimista: el cliente ya vio kill; Prisma termina en background. */
  isPendingDeath?: boolean;
};

@Injectable()
export class PlayerCombatRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlayerCombatRuntimeService.name);
  private readonly mobRuntime = new Map<string, MobRuntimeRow>();
  private readonly charPose = new Map<string, CharPose>();
  private readonly charStats = new Map<string, CharCombatStats>();
  private readonly lastSwingAtMs = new Map<string, number>();
  private readonly lastManaRegenAtMs = new Map<string, number>();
  private readonly lastSkillCastAtMs = new Map<string, Map<string, number>>();
  private readonly lastProgressionSyncAtMs = new Map<string, number>();
  private readonly gradePenaltyByCharacter = new Map<string, boolean>();
  private readonly killFinalizeQueueByCharacter = new Map<string, Promise<void>>();
  /** GCD mob→jugador en RAM (ms). */
  private readonly mobMeleeLastSwingMs = new Map<string, number>();
  /** Contacto diferido tras telegraph (`meleeHitDelayMs`). */
  private readonly mobMeleePendingHitAtMs = new Map<string, number>();
  private readonly mobIdsNeedingMeleeTimestampFlush = new Set<string>();
  /** GCD consumibles (pociones, etc.): anti-spam entre usos. */
  private static readonly CONSUMABLE_USE_COOLDOWN_MS = 1000;
  private readonly lastConsumableUseAtMs = new Map<string, number>();
  private static readonly MANA_REGEN_INTERVAL_MS = 3000;
  private static readonly MANA_REGEN_PERCENT = 0.05;
  private static readonly PROGRESSION_SYNC_INTERVAL_MS = 1000;
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: WorldSpatialService,
    private readonly bridge: WorldSocketBridgeService,
    private readonly presence: WorldPresenceService,
    private readonly combat: CombatService,
    private readonly statEngine: StatEngineService,
    private readonly mobCombatRegen: MobCombatRegenService,
    private readonly pendingWorldDrop: PendingWorldDropService,
    private readonly damageTracker: DamageContributionTrackerService,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => {
      void this.flushDirtyCombatState();
    }, 3000);
  }

  onModuleDestroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
  }

  invalidateMobRuntime(mobInstanceId: string): void {
    this.mobRuntime.delete(mobInstanceId);
    this.mobMeleeLastSwingMs.delete(mobInstanceId);
    this.mobMeleePendingHitAtMs.delete(mobInstanceId);
    this.mobIdsNeedingMeleeTimestampFlush.delete(mobInstanceId);
  }

  isMobPendingDeath(mobInstanceId: string): boolean {
    return !!this.mobRuntime.get(mobInstanceId)?.isPendingDeath;
  }

  /**
   * Tick de IA: sincroniza pose / stats de plantilla en RAM. Soberanía de HP: la DB **nunca**
   * reescribe `currentHp` en RAM salvo la primera fila al crear la entrada (bootstrap en frío).
   */
  hydrateMobsForAiTick(
    rows: Array<{
      id: string;
      currentHp: number;
      posX: number;
      posY: number;
      posZ: number;
      worldFacingYaw: number;
      zoneId: string | null;
      template: {
        maxHp: number;
        templateKey: string;
        pDef: number;
        mDef: number;
        attackRange: number;
        expReward: number;
        dropTable: unknown;
      };
    }>,
  ): void {
    for (const mob of rows) {
      const ex = this.mobRuntime.get(mob.id);
      if (ex) {
        if (ex.isPendingDeath) {
          continue;
        }
        ex.maxHp = mob.template.maxHp;
        ex.currentHp = Math.min(ex.currentHp, ex.maxHp);
        ex.posX = mob.posX;
        ex.posY = mob.posY;
        ex.posZ = mob.posZ;
        ex.yaw = mob.worldFacingYaw;
        ex.zoneId = mob.zoneId;
        ex.mobTemplateKey = mob.template.templateKey;
        ex.pDef = mob.template.pDef;
        ex.mDef = mob.template.mDef;
        ex.mobAttackRange = mob.template.attackRange;
        ex.expReward = mob.template.expReward;
        ex.dropTable = mob.template.dropTable;
        continue;
      }
      this.mobRuntime.set(mob.id, {
        currentHp: mob.currentHp,
        maxHp: mob.template.maxHp,
        posX: mob.posX,
        posY: mob.posY,
        posZ: mob.posZ,
        yaw: mob.worldFacingYaw,
        zoneId: mob.zoneId,
        mobTemplateKey: mob.template.templateKey,
        pDef: mob.template.pDef,
        mDef: mob.template.mDef,
        mobAttackRange: mob.template.attackRange,
        expReward: mob.template.expReward,
        dropTable: mob.template.dropTable,
        dirty: false,
        isPendingDeath: false,
      });
    }
  }

  /** Pose de movimiento en RAM (más fresca que `Character.worldPos*` si hay samples recientes). */
  getCharacterWorldPose(
    characterId: string,
  ): { x: number; y: number; z: number; zoneId: string } | undefined {
    return this.charPose.get(characterId);
  }

  /** IA: movimiento sin invalidar runtime ni tocar HP. */
  syncMobWorldPoseFromAi(
    mobInstanceId: string,
    patch: {
      posX: number;
      posY: number;
      posZ: number;
      yaw: number;
      zoneId: string | null;
    },
  ): void {
    const row = this.mobRuntime.get(mobInstanceId);
    if (!row) {
      return;
    }
    row.posX = patch.posX;
    row.posY = patch.posY;
    row.posZ = patch.posZ;
    row.yaw = patch.yaw;
    row.zoneId = patch.zoneId;
  }

  isMobHpDirty(mobInstanceId: string): boolean {
    return this.mobRuntime.get(mobInstanceId)?.dirty ?? false;
  }

  /** HP del mob para lógica de IA en este tick: solo RAM (tras `hydrateMobsForAiTick`). */
  getMobHpForAiTick(mobInstanceId: string): number {
    return this.mobRuntime.get(mobInstanceId)?.currentHp ?? 0;
  }

  /** Tras curación OOC autoritativa en DB: alinea RAM sin invalidar el runtime. */
  setMobRuntimeHpClean(mobInstanceId: string, currentHp: number, maxHp: number): void {
    const row = this.mobRuntime.get(mobInstanceId);
    if (!row) {
      return;
    }
    row.currentHp = currentHp;
    row.maxHp = maxHp;
    row.dirty = false;
  }

  /** Persiste HP “sucio” del mob antes de resets de IA / leash (autoridad del combate). */
  async flushMobHpToDatabase(mobInstanceId: string): Promise<void> {
    await this.flushMobHpIfDirty(mobInstanceId);
  }

  recordPoseFromMove(
    characterId: string,
    pos: { x: number; y: number; z: number },
    yaw: number,
    zoneId: string,
  ): void {
    this.charPose.set(characterId, {
      x: pos.x,
      y: pos.y,
      z: pos.z,
      yaw,
      zoneId,
    });
  }

  /**
   * Tras equipar/desequipar (HTTP o socket): actualiza PAtk/PDef/AtkSpeed en RAM
   * para que el próximo swing o mitigación use los valores persistidos.
   * Respeta HP “sucio” de combate (no flush aún): solo reclampa a maxHp nuevo.
   */
  async refreshDerivedStatsAfterEquipmentChange(
    characterId: string,
  ): Promise<void> {
    const existing = this.charStats.get(characterId);
    const vitals = await this.statEngine.getCombatVitals(characterId);
    const row = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: {
        characterClass: true,
        level: true,
        statEne: true,
        derivedPAtk: true,
        derivedMAtk: true,
        derivedCritRate: true,
        derivedAtkSpeed: true,
        derivedPDef: true,
      },
    });
    if (!row) {
      return;
    }

    if (!existing) {
      return;
    }

    let currentHp = existing.hpDirty ? existing.currentHp : vitals.currentHp;
    currentHp = Math.min(vitals.maxHp, Math.max(0, currentHp));

    this.charStats.set(characterId, {
      characterClass: row.characterClass,
      derivedPAtk: row.derivedPAtk,
      derivedMAtk: row.derivedMAtk,
      derivedCritRate: row.derivedCritRate,
      derivedAtkSpeed: row.derivedAtkSpeed,
      derivedPDef: row.derivedPDef,
      currentHp,
      maxHp: vitals.maxHp,
      currentMp: Math.min(existing.currentMp, this.computeMaxMpFromCharacter(row.level, row.statEne)),
      maxMp: this.computeMaxMpFromCharacter(row.level, row.statEne),
      hpDirty: existing.hpDirty,
    });
    await this.emitGradePenaltyStatusIfChanged(characterId, true);
  }

  async seedCharacterCombatState(characterId: string): Promise<void> {
    const vitals = await this.statEngine.getCombatVitals(characterId);
    const row = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: {
        characterClass: true,
        level: true,
        statEne: true,
        derivedPAtk: true,
        derivedMAtk: true,
        derivedCritRate: true,
        derivedAtkSpeed: true,
        derivedPDef: true,
        worldPosX: true,
        worldPosY: true,
        worldPosZ: true,
        worldFacingYaw: true,
        currentZoneId: true,
      },
    });
    if (!row) {
      return;
    }
    const maxMp = this.computeMaxMpFromCharacter(row.level, row.statEne);
    this.charStats.set(characterId, {
      characterClass: row.characterClass,
      derivedPAtk: row.derivedPAtk,
      derivedMAtk: row.derivedMAtk,
      derivedCritRate: row.derivedCritRate,
      derivedAtkSpeed: row.derivedAtkSpeed,
      derivedPDef: row.derivedPDef,
      currentHp: vitals.currentHp,
      maxHp: vitals.maxHp,
      currentMp: maxMp,
      maxMp,
      hpDirty: false,
    });
    this.lastManaRegenAtMs.set(characterId, Date.now());
    this.presence.clearCharacterHpDirty(characterId);
    this.charPose.set(characterId, {
      x: row.worldPosX,
      y: row.worldPosY,
      z: row.worldPosZ,
      yaw: row.worldFacingYaw,
      zoneId: normalizeZoneId(row.currentZoneId),
    });
    await this.emitGradePenaltyStatusIfChanged(characterId, true);
  }

  async setCombatTarget(
    characterId: string,
    zoneId: string,
    mobInstanceId: string | null,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (mobInstanceId === null) {
      const prev = this.presence.getActiveMobTarget(characterId);
      this.presence.setActiveMobTarget(characterId, null);
      if (prev) {
        await this.flushMobHpIfDirty(prev);
      }
      return { ok: true };
    }

    const vitals = await this.statEngine.getCombatVitals(characterId);
    const ch = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: {
        currentZoneId: true,
        characterClass: true,
        level: true,
        statEne: true,
        derivedPAtk: true,
        derivedMAtk: true,
        derivedCritRate: true,
        derivedAtkSpeed: true,
        derivedPDef: true,
      },
    });
    if (!ch) {
      return { ok: false, code: 'CHARACTER_NOT_FOUND', message: 'Character not found' };
    }
    if (!zonesMatch(ch.currentZoneId, zoneId)) {
      return { ok: false, code: 'ZONE_MISMATCH', message: 'Character is not in this zone' };
    }

    const mob = await this.prisma.mobInstance.findUnique({
      where: { id: mobInstanceId },
      include: { template: true },
    });
    if (!mob || !mob.isAlive || mob.currentHp <= 0) {
      return { ok: false, code: 'MOB_INVALID', message: 'Mob is not a valid living target' };
    }
    if (this.isMobPendingDeath(mobInstanceId)) {
      return { ok: false, code: 'MOB_INVALID', message: 'Mob is not a valid living target' };
    }
    if (!zonesMatch(mob.zoneId, zoneId)) {
      return { ok: false, code: 'ZONE_MISMATCH', message: 'Mob is not in this zone' };
    }

    await this.ensureMobRuntimeLoaded(mobInstanceId);

    this.charStats.set(characterId, {
      characterClass: ch.characterClass,
      derivedPAtk: ch.derivedPAtk,
      derivedMAtk: ch.derivedMAtk,
      derivedCritRate: ch.derivedCritRate,
      derivedAtkSpeed: ch.derivedAtkSpeed,
      derivedPDef: ch.derivedPDef,
      currentHp: vitals.currentHp,
      maxHp: vitals.maxHp,
      currentMp: this.charStats.get(characterId)?.currentMp ?? this.computeMaxMpFromCharacter(ch.level, ch.statEne),
      maxMp: this.computeMaxMpFromCharacter(ch.level, ch.statEne),
      hpDirty: false,
    });
    this.presence.clearCharacterHpDirty(characterId);

    this.presence.setActiveMobTarget(characterId, mobInstanceId);
    return { ok: true };
  }

  async onCharacterDisconnect(characterId: string): Promise<void> {
    await this.flushCharacterHpIfDirty(characterId);
    const prev = this.presence.getActiveMobTarget(characterId);
    this.presence.setActiveMobTarget(characterId, null);
    if (prev) {
      await this.flushMobHpIfDirty(prev);
    }
    this.charPose.delete(characterId);
    this.charStats.delete(characterId);
    this.lastSwingAtMs.delete(characterId);
    this.lastManaRegenAtMs.delete(characterId);
    this.lastSkillCastAtMs.delete(characterId);
    this.lastProgressionSyncAtMs.delete(characterId);
    this.lastConsumableUseAtMs.delete(characterId);
    this.gradePenaltyByCharacter.delete(characterId);
    this.presence.clearCharacterHpDirty(characterId);
  }

  async syncProgressionDrivenCombatState(characterId: string): Promise<void> {
    const now = Date.now();
    const last = this.lastProgressionSyncAtMs.get(characterId) ?? 0;
    if (now - last < PlayerCombatRuntimeService.PROGRESSION_SYNC_INTERVAL_MS) {
      return;
    }
    this.lastProgressionSyncAtMs.set(characterId, now);
    const runtime = this.charStats.get(characterId);
    if (!runtime) {
      return;
    }
    const row = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: {
        level: true,
        statVit: true,
        statEne: true,
        derivedPAtk: true,
        derivedMAtk: true,
        derivedCritRate: true,
        derivedAtkSpeed: true,
        derivedPDef: true,
      },
    });
    if (!row) {
      return;
    }
    const maxHp = this.statEngine.computeMaxHp(row.level, row.statVit);
    const maxMp = this.computeMaxMpFromCharacter(row.level, row.statEne);
    runtime.derivedPAtk = row.derivedPAtk;
    runtime.derivedMAtk = row.derivedMAtk;
    runtime.derivedCritRate = row.derivedCritRate;
    runtime.derivedAtkSpeed = row.derivedAtkSpeed;
    runtime.derivedPDef = row.derivedPDef;
    runtime.maxHp = maxHp;
    runtime.currentHp = Math.min(runtime.currentHp, maxHp);
    runtime.maxMp = maxMp;
    runtime.currentMp = Math.min(runtime.currentMp, maxMp);
    await this.emitGradePenaltyStatusIfChanged(characterId);
  }

  private async emitGradePenaltyStatusIfChanged(
    characterId: string,
    force = false,
  ): Promise<void> {
    const active = await this.statEngine.hasGradePenaltyForCharacter(characterId, this.prisma);
    const previous = this.gradePenaltyByCharacter.get(characterId);
    if (!force && previous === active) {
      return;
    }
    this.gradePenaltyByCharacter.set(characterId, active);
    const payload: WsGradePenaltyStatusPayload = { active };
    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.GRADE_PENALTY_STATUS, payload);
  }

  checkConsumableUseCooldown(
    characterId: string,
  ): { ok: true } | { ok: false; code: string; message: string } {
    const now = Date.now();
    const last = this.lastConsumableUseAtMs.get(characterId) ?? 0;
    if (now - last < PlayerCombatRuntimeService.CONSUMABLE_USE_COOLDOWN_MS) {
      return {
        ok: false,
        code: 'ITEM_USE_COOLDOWN',
        message: 'Esperá un momento antes de usar otro consumible.',
      };
    }
    return { ok: true };
  }

  touchConsumableUseCooldown(characterId: string): void {
    this.lastConsumableUseAtMs.set(characterId, Date.now());
  }

  getRuntimeVitals(
    characterId: string,
  ): { currentHp: number; maxHp: number; currentMp: number; maxMp: number } | null {
    const s = this.charStats.get(characterId);
    if (!s) {
      return null;
    }
    return {
      currentHp: s.currentHp,
      maxHp: s.maxHp,
      currentMp: s.currentMp,
      maxMp: s.maxMp,
    };
  }

  /**
   * Tras validar en gateway: curación plana desde consumible ya debitado en DB.
   */
  applyHealFromConsumable(
    characterId: string,
    flatHeal: number,
  ): { actualHeal: number; currentHp: number; maxHp: number } {
    const stats = this.charStats.get(characterId);
    if (!stats) {
      throw new Error(`applyHealFromConsumable: missing charStats for ${characterId}`);
    }
    const room = Math.max(0, stats.maxHp - stats.currentHp);
    const actualHeal = Math.min(Math.max(0, Math.floor(flatHeal)), room);
    stats.currentHp = Math.min(stats.maxHp, stats.currentHp + actualHeal);
    stats.hpDirty = true;
    this.presence.markCharacterHpDirty(characterId);
    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.PLAYER_VITALS, {
      characterId,
      currentHp: stats.currentHp,
      maxHp: stats.maxHp,
      currentMp: stats.currentMp,
      maxMp: stats.maxMp,
    });
    return { actualHeal, currentHp: stats.currentHp, maxHp: stats.maxHp };
  }

  async assertCanHealWithConsumable(
    characterId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    let stats = this.charStats.get(characterId);
    if (!stats) {
      await this.seedCharacterCombatState(characterId);
      stats = this.charStats.get(characterId);
    }
    if (!stats) {
      return {
        ok: false,
        code: 'NO_COMBAT_STATE',
        message: 'Personaje sin estado de combate',
      };
    }
    if (stats.currentHp <= 0) {
      return {
        ok: false,
        code: 'CANNOT_USE_WHILE_DEAD',
        message: 'No podés usar eso en este estado',
      };
    }
    if (stats.currentHp >= stats.maxHp) {
      return {
        ok: false,
        code: 'ALREADY_FULL_HP',
        message: 'La vitalidad ya está al máximo',
      };
    }
    return { ok: true };
  }

  tickManaRegenForCharacter(characterId: string): void {
    const stats = this.charStats.get(characterId);
    if (!stats || stats.currentHp <= 0 || stats.maxMp <= 0) {
      return;
    }
    const now = Date.now();
    const last = this.lastManaRegenAtMs.get(characterId) ?? now;
    if (now - last < PlayerCombatRuntimeService.MANA_REGEN_INTERVAL_MS) {
      return;
    }
    this.lastManaRegenAtMs.set(characterId, now);
    if (stats.currentMp >= stats.maxMp) {
      return;
    }
    const regen = Math.max(1, Math.floor(stats.maxMp * PlayerCombatRuntimeService.MANA_REGEN_PERCENT));
    stats.currentMp = Math.min(stats.maxMp, stats.currentMp + regen);
    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.PLAYER_VITALS, {
      characterId,
      currentHp: stats.currentHp,
      maxHp: stats.maxHp,
      currentMp: stats.currentMp,
      maxMp: stats.maxMp,
    });
  }

  async tryCastSkillForCharacter(
    characterId: string,
    skillId: string,
    targetId: string,
  ): Promise<
    | { ok: true; zoneId: string; payload: WsSkillHitResultPayload }
    | { ok: false; code: string; message: string }
  > {
    const skills = loadSkillsConfig().skills;
    const skill = skills.find((row) => row.id === skillId);
    if (!skill) {
      return { ok: false, code: 'SKILL_NOT_FOUND', message: 'Skill no encontrada' };
    }

    const pose = this.charPose.get(characterId);
    const stats = this.charStats.get(characterId);
    if (!pose || !stats || stats.currentHp <= 0) {
      return { ok: false, code: 'NO_COMBAT_STATE', message: 'Personaje sin estado de combate válido' };
    }

    const lastBySkill = this.lastSkillCastAtMs.get(characterId) ?? new Map<string, number>();
    this.lastSkillCastAtMs.set(characterId, lastBySkill);
    const now = Date.now();
    const lastCast = lastBySkill.get(skillId) ?? 0;
    if (now - lastCast < skill.cooldownMs) {
      return { ok: false, code: 'SKILL_ON_COOLDOWN', message: 'La habilidad sigue en cooldown' };
    }
    if (stats.currentMp < skill.manaCost) {
      return { ok: false, code: 'NO_MANA', message: 'No tienes mana suficiente' };
    }

    const mobRow = await this.ensureMobRuntimeLoaded(targetId);
    if (!mobRow || mobRow.currentHp <= 0 || mobRow.isPendingDeath) {
      return { ok: false, code: 'TARGET_INVALID', message: 'El objetivo no es válido o ya murió' };
    }
    const zoneId = pose.zoneId;
    if (!zonesMatch(mobRow.zoneId, zoneId)) {
      return { ok: false, code: 'ZONE_MISMATCH', message: 'Objetivo fuera de la zona actual' };
    }
    const inRange = this.spatial.isWithinMeleeAttackRange(
      { x: pose.x, y: pose.y, z: pose.z },
      { x: mobRow.posX, y: mobRow.posY, z: mobRow.posZ },
      skill.rangeMeters,
    );
    if (!inRange) {
      return {
        ok: false,
        code: 'OUT_OF_RANGE',
        message: 'Objetivo fuera de rango para esta habilidad',
      };
    }

    const primaryBackstab = this.spatial.isBackstabFromRearCone({
      targetForwardYaw: mobRow.yaw,
      targetPosition: { x: mobRow.posX, y: mobRow.posY, z: mobRow.posZ },
      attackerPosition: { x: pose.x, y: pose.y, z: pose.z },
    });
    const facingMult = primaryBackstab ? this.spatial.getBackstabDamageMultiplier() : 1;
    const baseRoll = rollPlayerToMobMeleeDamage({
      characterClass: stats.characterClass,
      derivedPAtk: stats.derivedPAtk,
      derivedMAtk: stats.derivedMAtk,
      derivedCritRate: stats.derivedCritRate,
      mobPDef: mobRow.pDef,
      mobMDef: mobRow.mDef,
      facingDamageMultiplier: facingMult,
      rng: Math.random,
    });
    const damage = Math.max(1, Math.floor(baseRoll.damage * skill.damageMultiplier));

    stats.currentMp = Math.max(0, stats.currentMp - skill.manaCost);
    lastBySkill.set(skillId, now);

    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.PLAYER_VITALS, {
      characterId,
      currentHp: stats.currentHp,
      maxHp: stats.maxHp,
      currentMp: stats.currentMp,
      maxMp: stats.maxMp,
    });

    const aoeRadius = skill.isAoe ? skill.aoeRadius ?? 0 : 0;
    const targetIds =
      skill.isAoe && aoeRadius > 0
        ? await this.findAoeMobTargets({
            center: { x: mobRow.posX, y: mobRow.posY, z: mobRow.posZ },
            zoneId,
            primaryTargetId: targetId,
            radiusMeters: aoeRadius,
          })
        : [targetId];
    if (targetIds.length === 0) {
      return { ok: false, code: 'TARGET_INVALID', message: 'No hay objetivos válidos en el área' };
    }
    const payloads: WsSkillHitResultPayload[] = [];
    const killed: Array<{
      mobInstanceId: string;
      mob: MobRuntimeRow;
      backstab: boolean;
      killPlan: RuntimeMobKillCommitPlan | null;
    }> = [];
    for (const candidateMobId of targetIds) {
      const row = candidateMobId === targetId ? mobRow : await this.ensureMobRuntimeLoaded(candidateMobId);
      if (!row || row.currentHp <= 0 || row.isPendingDeath) {
        continue;
      }
      const targetBackstab = this.spatial.isBackstabFromRearCone({
        targetForwardYaw: row.yaw,
        targetPosition: { x: row.posX, y: row.posY, z: row.posZ },
        attackerPosition: { x: pose.x, y: pose.y, z: pose.z },
      });
      row.currentHp = Math.max(0, row.currentHp - damage);
      row.dirty = true;
      this.damageTracker.recordDamage({
        mobInstanceId: candidateMobId,
        characterId,
        partyId: await this.resolvePartyIdForCharacter(characterId),
        damage,
      });
      this.mobCombatRegen.recordDamageReceived(
        candidateMobId,
        Date.now(),
        characterId,
      );
      const payload: WsSkillHitResultPayload = {
        attackerCharacterId: characterId,
        targetId: candidateMobId,
        skillId: skill.id,
        skillName: skill.name,
        damage,
        critical: baseRoll.critical,
        backstab: targetBackstab,
        targetKilled: row.currentHp <= 0,
        targetHpAfter: row.currentHp,
        manaCost: skill.manaCost,
        mpAfter: stats.currentMp,
      };
      payloads.push(payload);
      if (row.currentHp > 0) {
        continue;
      }
      row.currentHp = 0;
      row.dirty = false;
      row.isPendingDeath = true;
      this.presence.clearAllCharactersTargetingMob(candidateMobId);
      if (candidateMobId === targetId) {
        this.presence.setActiveMobTarget(characterId, null);
      }
      this.mobCombatRegen.clear(candidateMobId);
      const usePrecomputedKillPlan = !skill.isAoe;
      const killPlan = usePrecomputedKillPlan
        ? await this.combat.buildRuntimeMobKillCommitPlan(
            characterId,
            candidateMobId,
            row.mobTemplateKey,
            row.dropTable,
            row.expReward,
            { x: row.posX, y: row.posY, z: row.posZ },
            row.zoneId,
            Math.random,
          )
        : null;
      if (killPlan) {
        this.pendingWorldDrop.registerSpawns(
          killPlan.loot.worldDrops.map((w) => w.itemInstanceId),
        );
      }
      killed.push({
        mobInstanceId: candidateMobId,
        mob: row,
        backstab: targetBackstab,
        killPlan,
      });
    }
    if (payloads.length === 0) {
      return { ok: false, code: 'TARGET_INVALID', message: 'No hay objetivos válidos en el área' };
    }
    for (const payload of payloads) {
      this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.SKILL_HIT_RESULT, payload);
    }
    for (const entry of killed) {
      this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.MOB_DEATH, {
        mobInstanceId: entry.mobInstanceId,
        killerCharacterId: characterId,
        mobTemplateKey: entry.mob.mobTemplateKey,
        pos: { x: entry.mob.posX, y: entry.mob.posY, z: entry.mob.posZ },
      } satisfies WsMobDeathPayload);
      if (entry.killPlan) {
        this.bridge.emitToCharacter(
          characterId,
          WS_WORLD_EVENTS.ATTACK_MOB_REWARDS,
          entry.killPlan.rewardsPayload,
        );
        for (const drop of entry.killPlan.loot.worldDrops) {
          this.bridge.broadcastToZone(
            zoneId,
            WS_WORLD_EVENTS.WORLD_DROP_SPAWN,
            drop.spawnPayload,
          );
        }
      }
      this.finalizeOptimisticMobKillInBackground(
        characterId,
        entry.mobInstanceId,
        {
          damage,
          critical: baseRoll.critical,
          backstab: entry.backstab,
        },
        entry.killPlan,
      );
    }
    const primaryPayload = payloads.find((p) => p.targetId === targetId) ?? payloads[0];
    return { ok: true, zoneId, payload: primaryPayload };
  }

  private async findAoeMobTargets(params: {
    center: { x: number; y: number; z: number };
    zoneId: string;
    primaryTargetId: string;
    radiusMeters: number;
  }): Promise<string[]> {
    const radius = params.radiusMeters;
    if (!(radius > 0) || !Number.isFinite(radius)) {
      return [params.primaryTargetId];
    }
    const minX = params.center.x - radius;
    const maxX = params.center.x + radius;
    const minZ = params.center.z - radius;
    const maxZ = params.center.z + radius;
    const roughCandidates = await this.prisma.mobInstance.findMany({
      where: {
        isAlive: true,
        posX: { gte: minX, lte: maxX },
        posZ: { gte: minZ, lte: maxZ },
      },
      select: { id: true },
    });
    const orderedIds = new Set<string>([params.primaryTargetId]);
    for (const row of roughCandidates) {
      orderedIds.add(row.id);
    }
    const targets: string[] = [];
    for (const mobId of orderedIds) {
      const mob = await this.ensureMobRuntimeLoaded(mobId);
      if (!mob || mob.currentHp <= 0 || mob.isPendingDeath) {
        continue;
      }
      if (!zonesMatch(mob.zoneId, params.zoneId)) {
        continue;
      }
      const inRadius = this.spatial.isWithinRadiusXZ(
        params.center,
        { x: mob.posX, y: mob.posY, z: mob.posZ },
        radius,
      );
      if (!inRadius) {
        continue;
      }
      targets.push(mobId);
    }
    return targets;
  }

  /**
   * Mob con aggro → jugador: daño en RAM, vitales por socket; muerte en DB si HP ≤ 0.
   */
  async tryMobMeleeHit(mobInstanceId: string, characterId: string): Promise<void> {
    let stats = this.charStats.get(characterId);
    if (!stats) {
      await this.seedCharacterCombatState(characterId);
      stats = this.charStats.get(characterId);
    }
    if (!stats || stats.currentHp <= 0) {
      return;
    }

    const pose = this.charPose.get(characterId);
    if (!pose) {
      return;
    }

    if (this.isMobPendingDeath(mobInstanceId)) {
      return;
    }

    const mob = await this.prisma.mobInstance.findUnique({
      where: { id: mobInstanceId },
      include: { template: true },
    });
    if (!mob || !mob.isAlive || mob.aggroTargetCharacterId !== characterId) {
      return;
    }

    const ramMob = this.mobRuntime.get(mobInstanceId);
    const mobX = ramMob?.posX ?? mob.posX;
    const mobY = ramMob?.posY ?? mob.posY;
    const mobZ = ramMob?.posZ ?? mob.posZ;

    if (!zonesMatch(pose.zoneId, mob.zoneId)) {
      return;
    }

    const inRange = this.spatial.isWithinMobToPlayerMeleeRange(
      { x: mobX, y: mobY, z: mobZ },
      { x: pose.x, y: pose.y, z: pose.z },
      mob.template.attackRange,
    );
    if (!inRange) {
      this.mobMeleePendingHitAtMs.delete(mobInstanceId);
      return;
    }

    const faceYaw = Math.atan2(pose.x - mobX, pose.z - mobZ);
    if (Number.isFinite(faceYaw)) {
      this.syncMobWorldPoseFromAi(mobInstanceId, {
        posX: mobX,
        posY: mobY,
        posZ: mobZ,
        yaw: faceYaw,
        zoneId: mob.zoneId,
      });
    }

    const timing = loadCombatTimingConfig();
    const fallbackCd = timing.mobMeleeCooldownMs ?? 900;
    const mobCd = resolveMobMeleeCooldownMs(mob.template.templateKey, fallbackCd);
    const hitDelayMs = resolveMobMeleeHitDelayMs(mob.template.templateKey);
    const now = Date.now();
    const pendingAt = this.mobMeleePendingHitAtMs.get(mobInstanceId);
    if (pendingAt != null) {
      if (now < pendingAt) {
        return;
      }
      this.mobMeleePendingHitAtMs.delete(mobInstanceId);
    } else {
      const dbLast = mob.lastMobMeleeAt?.getTime() ?? 0;
      const ramLast = this.mobMeleeLastSwingMs.get(mobInstanceId) ?? 0;
      const effectiveLast = Math.max(dbLast, ramLast);
      if (now - effectiveLast < mobCd) {
        return;
      }
      this.mobMeleeLastSwingMs.set(mobInstanceId, now);
      this.mobIdsNeedingMeleeTimestampFlush.add(mobInstanceId);
      if (hitDelayMs > 0) {
        this.mobMeleePendingHitAtMs.set(mobInstanceId, now + hitDelayMs);
        this.bridge.broadcastToZone(pose.zoneId, WS_WORLD_EVENTS.MOB_MELEE_RESULT, {
          mobInstanceId,
          targetCharacterId: characterId,
          damage: 0,
        });
        return;
      }
    }

    const damage = resolveMobToPlayerMeleeDamage({
      mobPAtk: mob.template.pAtk,
      derivedPDef: stats.derivedPDef,
    });
    stats.currentHp = Math.max(0, stats.currentHp - damage);
    stats.hpDirty = true;
    this.presence.markCharacterHpDirty(characterId);
    this.mobCombatRegen.recordMobDealtDamage(mobInstanceId);

    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.PLAYER_VITALS, {
      characterId,
      currentHp: stats.currentHp,
      maxHp: stats.maxHp,
      currentMp: stats.currentMp,
      maxMp: stats.maxMp,
    });
    this.bridge.broadcastToZone(pose.zoneId, WS_WORLD_EVENTS.MOB_MELEE_RESULT, {
      mobInstanceId,
      targetCharacterId: characterId,
      damage,
    });

    if (stats.currentHp <= 0) {
      stats.hpDirty = false;
      this.presence.clearCharacterHpDirty(characterId);
      try {
        await this.combat.commitRuntimePlayerDeath(characterId, mobInstanceId);
      } catch (e) {
        this.logger.error(
          `[MobMelee] Death commit failed ${characterId}: ${e instanceof Error ? e.message : String(e)}`,
        );
        await this.seedCharacterCombatState(characterId);
        return;
      }
      this.mobMeleeLastSwingMs.delete(mobInstanceId);
      this.mobMeleePendingHitAtMs.delete(mobInstanceId);
      this.mobIdsNeedingMeleeTimestampFlush.delete(mobInstanceId);
      await this.seedCharacterCombatState(characterId);
      const row = await this.prisma.character.findUnique({
        where: { id: characterId },
        select: {
          worldPosX: true,
          worldPosY: true,
          worldPosZ: true,
          worldFacingYaw: true,
          currentZoneId: true,
        },
      });
      if (row) {
        this.recordPoseFromMove(
          characterId,
          { x: row.worldPosX, y: row.worldPosY, z: row.worldPosZ },
          row.worldFacingYaw,
          normalizeZoneId(row.currentZoneId),
        );
      }
      this.presence.setActiveMobTarget(characterId, null);
    }
  }

  async tryAutoSwingForCharacter(characterId: string): Promise<void> {
    const mobId = this.presence.getActiveMobTarget(characterId);
    if (!mobId) {
      return;
    }
    const pose = this.charPose.get(characterId);
    const stats = this.charStats.get(characterId);
    if (!pose || !stats || stats.currentHp <= 0) {
      return;
    }

    const mobRow = await this.ensureMobRuntimeLoaded(mobId);
    if (!mobRow || mobRow.currentHp <= 0 || mobRow.isPendingDeath) {
      this.presence.setActiveMobTarget(characterId, null);
      return;
    }

    const strictRange = this.evaluateStrictAutoAttackRange(pose, mobRow);
    if (!strictRange.inRange) {
      await this.clearAutoAttackForOutOfRange(
        characterId,
        mobId,
        strictRange.distanceMeters,
        strictRange.maxDistanceMeters,
      );
      return;
    }

    const timing = loadCombatTimingConfig();
    const atkSpeed = Math.max(0.65, stats.derivedAtkSpeed);
    let cooldownMs = timing.baseSwingCooldownMs / atkSpeed;
    cooldownMs = Math.min(
      timing.maxCooldownMs,
      Math.max(timing.minCooldownMs, cooldownMs),
    );
    const now = Date.now();
    const last = this.lastSwingAtMs.get(characterId) ?? 0;
    if (now - last < cooldownMs) {
      return;
    }

    const backstab = this.spatial.isBackstabFromRearCone({
      targetForwardYaw: mobRow.yaw,
      targetPosition: { x: mobRow.posX, y: mobRow.posY, z: mobRow.posZ },
      attackerPosition: { x: pose.x, y: pose.y, z: pose.z },
    });
    const facingMult = backstab ? this.spatial.getBackstabDamageMultiplier() : 1;

    const { damage, critical } = rollPlayerToMobMeleeDamage({
      characterClass: stats.characterClass,
      derivedPAtk: stats.derivedPAtk,
      derivedMAtk: stats.derivedMAtk,
      derivedCritRate: stats.derivedCritRate,
      mobPDef: mobRow.pDef,
      mobMDef: mobRow.mDef,
      facingDamageMultiplier: facingMult,
      rng: Math.random,
    });

    mobRow.currentHp = Math.max(0, mobRow.currentHp - damage);
    mobRow.dirty = true;
    this.damageTracker.recordDamage({
      mobInstanceId: mobId,
      characterId,
      partyId: await this.resolvePartyIdForCharacter(characterId),
      damage,
    });
    this.lastSwingAtMs.set(characterId, now);
    this.mobCombatRegen.recordDamageReceived(mobId, Date.now(), characterId);

    const zoneId = pose.zoneId;

    if (mobRow.currentHp <= 0) {
      mobRow.currentHp = 0;
      mobRow.dirty = false;
      mobRow.isPendingDeath = true;

      this.presence.setActiveMobTarget(characterId, null);
      this.presence.clearAllCharactersTargetingMob(mobId);
      this.mobCombatRegen.clear(mobId);

      // ── Pre-cálculo en RAM (sin DB) ────────────────────────────────────────
      const killPlan = await this.combat.buildRuntimeMobKillCommitPlan(
        characterId,
        mobId,
        mobRow.mobTemplateKey,
        mobRow.dropTable,
        mobRow.expReward,
        { x: mobRow.posX, y: mobRow.posY, z: mobRow.posZ },
        mobRow.zoneId,
        Math.random,
      );
      if (!killPlan) {
        this.logger.warn(
          `[AutoMelee] Kill plan failed (character missing?) ${characterId} vs ${mobId}; persisting without precomputed loot.`,
        );
      } else {
        // Reserva en RAM los IDs de drop antes del INSERT para evitar duplicados
        this.pendingWorldDrop.registerSpawns(
          killPlan.loot.worldDrops.map((w) => w.itemInstanceId),
        );
      }

      // ── Emisión atómica: 4 eventos en el mismo bloque síncrono ────────────
      // 1. Último golpe con kill flag (toda la zona ve el daño + mob flag killed)
      this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.ATTACK_MOB_RESULT, {
        attackerCharacterId: characterId,
        mobInstanceId: mobId,
        damage,
        critical,
        backstab,
        mobKilled: true,
        mobHpAfter: 0,
        mobTemplateKey: mobRow.mobTemplateKey,
      } satisfies WsAttackMobResultPayload);

      // 2. Muerte del mob (toda la zona: mob desaparece)
      this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.MOB_DEATH, {
        mobInstanceId: mobId,
        killerCharacterId: characterId,
        mobTemplateKey: mobRow.mobTemplateKey,
        pos: { x: mobRow.posX, y: mobRow.posY, z: mobRow.posZ },
      } satisfies WsMobDeathPayload);

      if (killPlan) {
        // 3. Rewards solo al killer (XP floater + barra de progresión)
        this.bridge.emitToCharacter(
          characterId,
          WS_WORLD_EVENTS.ATTACK_MOB_REWARDS,
          killPlan.rewardsPayload,
        );

        // 4. Drops para toda la zona (cubo amarillo aparece en el suelo)
        for (const drop of killPlan.loot.worldDrops) {
          this.bridge.broadcastToZone(
            zoneId,
            WS_WORLD_EVENTS.WORLD_DROP_SPAWN,
            drop.spawnPayload,
          );
        }
      }

      // ── Persistencia en background: sin await, DB confirma lo ya visible ──
      this.finalizeOptimisticMobKillInBackground(characterId, mobId, { damage, critical, backstab }, killPlan);
      return;
    }

    const payload: WsAttackMobResultPayload = {
      attackerCharacterId: characterId,
      mobInstanceId: mobId,
      damage,
      critical,
      backstab,
      mobKilled: false,
      mobHpAfter: mobRow.currentHp,
      mobTemplateKey: mobRow.mobTemplateKey,
    };
    this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.ATTACK_MOB_RESULT, payload);
  }

  /**
   * Warden tick guard: antes de ejecutar auto-melee, corta target si quedó fuera de rango.
   */
  async validateAutoAttackRangeForCharacter(characterId: string): Promise<boolean> {
    const mobId = this.presence.getActiveMobTarget(characterId);
    if (!mobId) {
      return false;
    }
    const pose = this.charPose.get(characterId);
    if (!pose) {
      return false;
    }
    const mobRow = await this.ensureMobRuntimeLoaded(mobId);
    if (!mobRow || mobRow.currentHp <= 0 || mobRow.isPendingDeath) {
      this.presence.setActiveMobTarget(characterId, null);
      return false;
    }
    const strictRange = this.evaluateStrictAutoAttackRange(pose, mobRow);
    if (strictRange.inRange) {
      return true;
    }
    await this.clearAutoAttackForOutOfRange(
      characterId,
      mobId,
      strictRange.distanceMeters,
      strictRange.maxDistanceMeters,
    );
    return false;
  }

  /**
   * Persistencia async post-muerte optimista: transacción Prisma (loot/XP) sin bloquear el tick.
   */
  private finalizeOptimisticMobKillInBackground(
    characterId: string,
    mobInstanceId: string,
    lastHit: { damage: number; critical: boolean; backstab: boolean },
    killPlan: RuntimeMobKillCommitPlan | null,
  ): void {
    const pendingDropIds = killPlan?.loot.worldDrops.map((w) => w.itemInstanceId) ?? [];
    this.enqueueOptimisticKillFinalization(characterId, async () => {
      try {
        const outcome = await this.combat.commitRuntimeMobKill(characterId, mobInstanceId, lastHit, {
          precomputedPlan: killPlan ?? undefined,
          suppressDuplicateWorldDropBroadcast: !!killPlan,
        });
        if (pendingDropIds.length) {
          this.pendingWorldDrop.clearSpawns(pendingDropIds);
        }
        this.mobRuntime.delete(mobInstanceId);
        if (!outcome.mobKilled || !outcome.rewards) {
          return;
        }
        /**
         * En AoE (sin precompute) este payload es la fuente autoritativa para mantener XP exacta
         * por mob muerto sin drift por commits concurrentes.
         */
        if (!killPlan) {
          this.bridge.emitToCharacter(
            characterId,
            WS_WORLD_EVENTS.ATTACK_MOB_REWARDS,
            outcome.rewards,
          );
        }
        if (outcome.rewards.levelsGained > 0) {
          const vitals = await this.statEngine.getCombatVitals(characterId);
          const row = await this.prisma.character.findUnique({
            where: { id: characterId },
            select: { availableStatPoints: true },
          });
          const vitalsPayload: WsPlayerVitalsPayload = {
            characterId,
            currentHp: vitals.currentHp,
            maxHp: vitals.maxHp,
          };
          this.bridge.emitToCharacter(
            characterId,
            WS_WORLD_EVENTS.PLAYER_VITALS,
            vitalsPayload,
          );
          const levelPayload: WsLevelUpPayload = {
            characterId,
            newLevel: outcome.rewards.level,
            experience: outcome.rewards.experience,
            experienceRequiredForNext: outcome.rewards.experienceRequiredForNext,
            availableStatPoints: row?.availableStatPoints ?? 0,
            currentHp: vitals.currentHp,
            maxHp: vitals.maxHp,
          };
          this.bridge.emitToCharacter(
            characterId,
            WS_WORLD_EVENTS.LEVEL_UP,
            levelPayload,
          );
          await this.seedCharacterCombatState(characterId);
        }
      } catch (e) {
        if (pendingDropIds.length) {
          this.pendingWorldDrop.clearSpawns(pendingDropIds);
        }
        this.logger.warn(
          `[OptimisticKill] Persist failed ${characterId} vs ${mobInstanceId}: ${e instanceof Error ? e.message : String(e)}`,
        );
        this.mobRuntime.delete(mobInstanceId);
        this.presence.clearAllCharactersTargetingMob(mobInstanceId);
      }
    });
  }

  private enqueueOptimisticKillFinalization(
    characterId: string,
    task: () => Promise<void>,
  ): void {
    const prev = this.killFinalizeQueueByCharacter.get(characterId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => task())
      .finally(() => {
        if (this.killFinalizeQueueByCharacter.get(characterId) === next) {
          this.killFinalizeQueueByCharacter.delete(characterId);
        }
      });
    this.killFinalizeQueueByCharacter.set(characterId, next);
  }

  private computeMaxMpFromCharacter(level: number, effectiveEne: number): number {
    const vitals = loadCharacterVitalsConfig();
    const baseMp = vitals.baseMaxMp ?? 70;
    const perLevel = vitals.perCharacterLevelMp ?? 5;
    const perEne = vitals.perEffectiveEnePoint ?? 8;
    const raw = baseMp + level * perLevel + effectiveEne * perEne;
    return Math.max(1, Math.floor(raw));
  }

  private evaluateStrictAutoAttackRange(
    pose: CharPose,
    mobRow: MobRuntimeRow,
  ): { inRange: boolean; distanceMeters: number; maxDistanceMeters: number } {
    const attackerPos = { x: pose.x, y: pose.y, z: pose.z };
    const targetPos = { x: mobRow.posX, y: mobRow.posY, z: mobRow.posZ };
    const distanceMeters = this.spatial.distance3d(attackerPos, targetPos);
    const maxDistanceMeters = this.spatial.getPlayerAutoAttackMaxDistanceMeters();
    return {
      inRange: distanceMeters <= maxDistanceMeters,
      distanceMeters,
      maxDistanceMeters,
    };
  }

  private async clearAutoAttackForOutOfRange(
    characterId: string,
    mobInstanceId: string,
    distanceMeters: number,
    maxDistanceMeters: number,
  ): Promise<void> {
    this.presence.setActiveMobTarget(characterId, null);
    await this.flushMobHpIfDirty(mobInstanceId);
    const payload: WsAttackMobDeniedPayload = {
      code: 'TARGET_OUT_OF_RANGE',
      message: `Target out of range (${distanceMeters.toFixed(2)}m > ${maxDistanceMeters.toFixed(2)}m)`,
    };
    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.ATTACK_MOB_DENIED, payload);
  }

  private async ensureMobRuntimeLoaded(mobInstanceId: string): Promise<MobRuntimeRow | null> {
    const cached = this.mobRuntime.get(mobInstanceId);
    if (cached?.isPendingDeath) {
      return null;
    }
    if (cached) {
      return cached;
    }
    const mob = await this.prisma.mobInstance.findUnique({
      where: { id: mobInstanceId },
      include: { template: true },
    });
    if (!mob || !mob.isAlive) {
      return null;
    }
    const row: MobRuntimeRow = {
      currentHp: mob.currentHp,
      maxHp: mob.template.maxHp,
      posX: mob.posX,
      posY: mob.posY,
      posZ: mob.posZ,
      yaw: mob.worldFacingYaw,
      zoneId: mob.zoneId,
      mobTemplateKey: mob.template.templateKey,
      pDef: mob.template.pDef,
      mDef: mob.template.mDef,
      mobAttackRange: mob.template.attackRange,
      expReward: mob.template.expReward,
      dropTable: mob.template.dropTable,
      dirty: false,
      isPendingDeath: false,
    };
    this.mobRuntime.set(mobInstanceId, row);
    return row;
  }

  private async resolvePartyIdForCharacter(
    _characterId: string,
  ): Promise<string | null> {
    return null;
  }

  private async flushDirtyCombatState(): Promise<void> {
    await this.flushDirtyMobs();
    await this.flushDirtyCharacters();
    await this.flushMobMeleeTimestamps();
  }

  private async flushDirtyMobs(): Promise<void> {
    for (const [id, row] of this.mobRuntime) {
      if (!row.dirty || row.currentHp <= 0) {
        continue;
      }
      row.dirty = false;
      try {
        await this.prisma.mobInstance.update({
          where: { id },
          data: { currentHp: row.currentHp },
        });
      } catch (e) {
        this.logger.warn(
          `[CombatRuntime] Flush mob HP failed mob=${id}: ${e instanceof Error ? e.message : String(e)}`,
        );
        row.dirty = true;
      }
    }
  }

  private async flushDirtyCharacters(): Promise<void> {
    for (const [characterId, stats] of this.charStats) {
      if (!stats.hpDirty) {
        continue;
      }
      stats.hpDirty = false;
      this.presence.clearCharacterHpDirty(characterId);
      try {
        await this.prisma.character.update({
          where: { id: characterId },
          data: {
            currentHp: stats.currentHp,
            lastCombatAt: new Date(),
          },
        });
      } catch (e) {
        this.logger.warn(
          `[CombatRuntime] Flush char HP failed ${characterId}: ${e instanceof Error ? e.message : String(e)}`,
        );
        stats.hpDirty = true;
        this.presence.markCharacterHpDirty(characterId);
      }
    }
  }

  private async flushMobMeleeTimestamps(): Promise<void> {
    const ids = [...this.mobIdsNeedingMeleeTimestampFlush];
    if (ids.length === 0) {
      return;
    }
    const stamp = new Date();
    for (const mobId of ids) {
      try {
        await this.prisma.mobInstance.update({
          where: { id: mobId },
          data: { lastMobMeleeAt: stamp },
        });
        this.mobIdsNeedingMeleeTimestampFlush.delete(mobId);
      } catch (e) {
        this.logger.warn(
          `[CombatRuntime] Flush mob meleeAt failed ${mobId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  private async flushMobHpIfDirty(mobInstanceId: string): Promise<void> {
    const row = this.mobRuntime.get(mobInstanceId);
    if (!row || !row.dirty || row.currentHp <= 0) {
      return;
    }
    row.dirty = false;
    try {
      await this.prisma.mobInstance.update({
        where: { id: mobInstanceId },
        data: { currentHp: row.currentHp },
      });
    } catch (e) {
      row.dirty = true;
      this.logger.warn(
        `[CombatRuntime] Flush single mob failed ${mobInstanceId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async flushCharacterHpIfDirty(characterId: string): Promise<void> {
    const stats = this.charStats.get(characterId);
    if (!stats?.hpDirty) {
      return;
    }
    stats.hpDirty = false;
    this.presence.clearCharacterHpDirty(characterId);
    try {
      await this.prisma.character.update({
        where: { id: characterId },
        data: {
          currentHp: stats.currentHp,
          lastCombatAt: new Date(),
        },
      });
    } catch (e) {
      stats.hpDirty = true;
      this.presence.markCharacterHpDirty(characterId);
      this.logger.warn(
        `[CombatRuntime] Flush disconnect char HP failed ${characterId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
