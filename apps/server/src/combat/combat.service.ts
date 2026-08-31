import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Character } from '@prisma/client';
import {
  CharacterClass,
  ItemInstanceLocation,
  KarmaTier,
  Prisma,
} from '@prisma/client';
import type { PvEDeathResolution } from '../character/character.service';
import { CharacterService } from '../character/character.service';
import type { EquippedRow } from '../character/stat-engine.service';
import { StatEngineService } from '../character/stat-engine.service';
import { DamageContributionTrackerService } from './damage-contribution-tracker.service';
import {
  LedgerLootService,
  collectDropCatalogKeysFromMobTable,
  type ItemTemplateDropRoll,
  type RuntimeMobKillLootPlan,
} from '../ledger/loot.service';
import { MobCombatRegenService } from '../mob/mob-combat-regen.service';
import { MobService } from '../mob/mob.service';
import { parseItemGradeFromBaseStats } from '../items/item-grade.util';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeZoneId, zonesMatch } from '../world/world-zone.util';
import {
  WS_WORLD_EVENTS,
  type WsAttackMobRewardsPayload,
  type WsPlayerDeathPayload,
  type WsPlayerMovedPayload,
  type WsPlayerVitalsPayload,
  type WsWorldDropSpawnPayload,
} from '@aetheris/shared-types';
import { WorldSocketBridgeService } from '../world/world-socket-bridge.service';
import { WorldSpatialService } from '../world/world-spatial.service';
import {
  getMobLevelForTemplateKey,
  isGreyMobNoBenefitPenalty,
} from '../mob/mob-config.loaders';
import { loadCombatDamageConfig } from './combat-config.loaders';
import { resolveMobToPlayerMeleeDamage } from './pve-melee-damage.util';
import { loadCombatTimingConfig } from './combat-timing.loaders';
import { PenaltyManagerService, type KarmaFlag } from './penalty-manager.service';

export interface AttackMobOptions {
  rng?: () => number;
  /** Multiplicador por facing (backstab); 1 si no aplica. */
  facingDamageMultiplier?: number;
}

export interface AttackMobResult {
  damage: number;
  critical: boolean;
  mobHpAfter: number;
  mobKilled: boolean;
  mobTemplateKey?: string;
  zoneId?: string | null;
  rewards?: {
    experienceGained: number;
    adenaGranted: string;
    itemInstanceIds: string[];
    levelsGained: number;
    level: number;
    experience: number;
    experienceRequiredForNext: number;
    worldDropSpawns: WsWorldDropSpawnPayload[];
  };
}

export interface AttackPlayerResult {
  damage: number;
  targetCharacterId: string;
  mobInstanceId: string;
  currentHp: number;
  maxHp: number;
  killed: boolean;
  death?: PvEDeathResolution;
}

export interface AttackPlayerCharacterResult {
  attackerCharacterId: string;
  targetCharacterId: string;
  damage: number;
  critical: boolean;
  targetHpAfter: number;
  targetKilled: boolean;
  zoneId: string | null;
  attackerFlag: KarmaFlag;
  targetFlag: KarmaFlag;
  attackerWeaponPlusLevel: number;
  targetWeaponPlusLevel: number;
  pkDropSpawn?: WsWorldDropSpawnPayload;
}

/** Loot + EXP precomputados en RAM antes del commit optimista (auto-melee). */
export type RuntimeMobKillCommitPlan = {
  loot: RuntimeMobKillLootPlan;
  /** EXP efectiva a persistir (0 si mob gris). */
  expAmount: number;
  /** `mob.template.expReward` al armar el plan (anti-stale vs DB). */
  sourceTemplateExpReward: number;
  rewardsPayload: WsAttackMobRewardsPayload;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CombatService {
  private readonly logger = new Logger(CombatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly characterService: CharacterService,
    private readonly statEngine: StatEngineService,
    private readonly worldSpatial: WorldSpatialService,
    private readonly mobService: MobService,
    private readonly damageTracker: DamageContributionTrackerService,
    private readonly ledgerLoot: LedgerLootService,
    private readonly penaltyManager: PenaltyManagerService,
    private readonly bridge: WorldSocketBridgeService,
    private readonly mobCombatRegen: MobCombatRegenService,
  ) {}

  /**
   * The Warden: un tick lógico de autoataque PvE — daño, muerte, exp y loot en una transacción.
   * Aislamiento ReadCommitted: Serializable chocaba (P2034) con `PLAYER_MOVE` que actualiza la misma
   * fila `Character` constantemente mientras el jugador se acerca al mob.
   */
  async attackMob(
    characterId: string,
    mobInstanceId: string,
    options?: AttackMobOptions,
  ): Promise<AttackMobResult> {
    const rand = options?.rng ?? Math.random;
    const facingMult = options?.facingDamageMultiplier ?? 1;

    const maxTxAttempts = 8;
    let outcome: AttackMobResult | undefined;
    for (let attempt = 1; attempt <= maxTxAttempts; attempt++) {
      try {
        outcome = await this.prisma.$transaction(
          async (tx) => {
            const character = await tx.character.findUnique({
              where: { id: characterId },
            });
            if (!character) {
              throw new NotFoundException(`Character not found: ${characterId}`);
            }

            const mob = await tx.mobInstance.findUnique({
              where: { id: mobInstanceId },
              include: { template: true },
            });
            if (!mob) {
              throw new NotFoundException(`MobInstance not found: ${mobInstanceId}`);
            }
            if (!mob.isAlive || mob.currentHp <= 0) {
              throw new BadRequestException({
                code: 'MOB_ALREADY_DEAD',
                message: 'Target is not a valid living mob',
              });
            }

            const timing = loadCombatTimingConfig();
            const atkSpeed = Math.max(0.65, character.derivedAtkSpeed);
            let cooldownMs = timing.baseSwingCooldownMs / atkSpeed;
            cooldownMs = Math.min(
              timing.maxCooldownMs,
              Math.max(timing.minCooldownMs, cooldownMs),
            );
            if (character.lastAttackServerAt) {
              const elapsed =
                Date.now() - character.lastAttackServerAt.getTime();
              if (elapsed < cooldownMs) {
                throw new BadRequestException({
                  code: 'ATTACK_ON_COOLDOWN',
                  message: 'Melee swing on cooldown',
                });
              }
            }

            const inRange = this.worldSpatial.isWithinMeleeAttackRange(
              {
                x: character.worldPosX,
                y: character.worldPosY,
                z: character.worldPosZ,
              },
              { x: mob.posX, y: mob.posY, z: mob.posZ },
              mob.template.attackRange,
            );
            if (!inRange) {
              const dist = this.worldSpatial.distance3d(
                {
                  x: character.worldPosX,
                  y: character.worldPosY,
                  z: character.worldPosZ,
                },
                { x: mob.posX, y: mob.posY, z: mob.posZ },
              );
              this.logger.warn(
                `[Attack] Player ${characterId} -> Mob ${mobInstanceId}. Rejected: ATTACK_OUT_OF_RANGE distance=${dist.toFixed(3)}`,
              );
              throw new BadRequestException({
                code: 'ATTACK_OUT_OF_RANGE',
                message: 'Attacker is too far from target (Cartographer)',
              });
            }

            const dmgCfg = loadCombatDamageConfig();
            const isMage = character.characterClass === CharacterClass.DARK_WIZARD;
            const atkStat = isMage ? character.derivedMAtk : character.derivedPAtk;
            const mobMit = isMage ? mob.template.mDef : mob.template.pDef;
            const factor = isMage
              ? dmgCfg.magicalMitigationFactor
              : dmgCfg.physicalMitigationFactor;
            const baseMitigated = atkStat - mobMit * factor;
            const afterFacing = baseMitigated * facingMult;
            const critical = rand() < character.derivedCritRate;
            let damage = Math.floor(
              critical
                ? afterFacing * dmgCfg.criticalMultiplier
                : afterFacing,
            );
            if (!Number.isFinite(damage) || damage < dmgCfg.minimumDamage) {
              damage = dmgCfg.minimumDamage;
            }
            const partyId = await this.resolvePartyIdForCharacter(
              tx,
              characterId,
            );
            this.damageTracker.recordDamage({
              mobInstanceId,
              characterId,
              partyId,
              damage,
            });

            const hpAfter = Math.max(0, mob.currentHp - damage);
            const killed = hpAfter <= 0;

            await tx.mobInstance.update({
              where: { id: mobInstanceId },
              data: {
                currentHp: hpAfter,
                isAlive: !killed,
                diedAt: killed ? new Date() : null,
              },
            });

            await tx.character.update({
              where: { id: characterId },
              data: {
                lastAttackServerAt: new Date(),
                lastCombatAt: new Date(),
              },
            });

            if (!killed) {
              return {
                damage,
                critical,
                mobHpAfter: hpAfter,
                mobKilled: false,
              } satisfies AttackMobResult;
            }

            const dropOwnerId = this.resolveDropOwnerId(mobInstanceId, characterId);
            const mobLevel = getMobLevelForTemplateKey(mob.template.templateKey);
            const ownerLevel = await this.resolveOwnerLevelForDrop(
              tx,
              dropOwnerId,
              character.level,
            );
            const levelPenaltyActive = isGreyMobNoBenefitPenalty(
              ownerLevel,
              mobLevel,
            );
            const { adenaGranted, itemInstanceIds, worldDropSpawns } =
              await this.ledgerLoot.applyMobDropTable(tx, {
                accountId: character.accountId,
                characterId,
                dropTable: levelPenaltyActive ? {} : mob.template.dropTable,
                rng: rand,
                worldDrop: {
                  zoneId: mob.zoneId,
                  basePos: { x: mob.posX, y: mob.posY, z: mob.posZ },
                  reservedForCharacterId: dropOwnerId,
                  reserveDurationMs: 10_000,
                },
              });

            const expAmount = levelPenaltyActive ? 0 : mob.template.expReward;
            const { character: afterExp, levelsGained } =
              await this.characterService.addExperience(
                characterId,
                expAmount,
                tx,
              );

            return {
              damage,
              critical,
              mobHpAfter: 0,
              mobKilled: true,
              mobTemplateKey: mob.template.templateKey,
              zoneId: mob.zoneId,
              rewards: {
                experienceGained: expAmount,
                adenaGranted: adenaGranted.toString(),
                itemInstanceIds,
                levelsGained,
                level: afterExp.level,
                experience: afterExp.experience,
                experienceRequiredForNext:
                  this.statEngine.experienceRequiredForNextOrZero(afterExp.level),
                worldDropSpawns,
              },
            } satisfies AttackMobResult;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          },
        );
        break;
      } catch (e) {
        const retryable =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2034' &&
          attempt < maxTxAttempts;
        if (retryable) {
          await new Promise((r) =>
            setTimeout(r, 15 * attempt + Math.floor(Math.random() * 25)),
          );
          continue;
        }
        throw e;
      }
    }

    if (!outcome) {
      throw new Error('attackMob: transaction produced no outcome');
    }

    this.logger.log(
      `[Attack] Player ${characterId} -> Mob ${mobInstanceId}. Result: damage=${outcome.damage} crit=${outcome.critical} killed=${outcome.mobKilled} hpAfter=${outcome.mobHpAfter}`,
    );

    if (outcome.mobKilled && outcome.rewards?.worldDropSpawns?.length) {
      this.emitWorldDropSpawns(outcome.zoneId ?? null, outcome.rewards.worldDropSpawns);
    }

    if (outcome.mobKilled && outcome.mobTemplateKey) {
      this.damageTracker.clearMob(mobInstanceId);
      this.mobService.emitMobDeath({
        mobInstanceId,
        mobTemplateKey: outcome.mobTemplateKey,
        killerCharacterId: characterId,
        zoneId: outcome.zoneId ?? null,
        occurredAt: new Date(),
      });
    }

    if (outcome.mobKilled) {
      this.mobCombatRegen.clear(mobInstanceId);
    } else {
      this.mobCombatRegen.recordDamageReceived(
        mobInstanceId,
        Date.now(),
        characterId,
      );
    }

    return outcome;
  }

  /**
   * Precomputa loot + EXP en RAM (lecturas ligeras) para empaquetar con `MOB_DEATH` en el mismo tick visual.
   */
  async buildRuntimeMobKillCommitPlan(
    characterId: string,
    mobInstanceId: string,
    mobTemplateKey: string,
    mobDropTable: unknown,
    mobExpReward: number,
    mobPos: { x: number; y: number; z: number },
    mobZoneId: string | null,
    rng: () => number,
  ): Promise<RuntimeMobKillCommitPlan | null> {
    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { accountId: true, level: true, experience: true },
    });
    if (!character) {
      return null;
    }
    const keys = collectDropCatalogKeysFromMobTable(mobDropTable);
    const templates =
      keys.length === 0
        ? []
        : await this.prisma.itemTemplate.findMany({
            where: { catalogKey: { in: keys } },
            select: {
              id: true,
              catalogKey: true,
              name: true,
              icon: true,
              baseStats: true,
            },
          });
    const map = new Map<string, ItemTemplateDropRoll>();
    for (const t of templates) {
      if (t.catalogKey) {
        map.set(t.catalogKey, {
          id: t.id,
          catalogKey: t.catalogKey,
          name: t.name,
          icon: t.icon,
          grade: parseItemGradeFromBaseStats(t.baseStats),
        });
      }
    }

    const dropOwnerId = this.resolveDropOwnerId(mobInstanceId, characterId);
    const mobLevel = getMobLevelForTemplateKey(mobTemplateKey);
    const ownerLevel = await this.resolveOwnerLevelForDrop(
      this.prisma,
      dropOwnerId,
      character.level,
    );
    const levelPenaltyActive = isGreyMobNoBenefitPenalty(
      ownerLevel,
      mobLevel,
    );
    const loot = levelPenaltyActive
      ? ({ adenaGranted: 0n, worldDrops: [] } satisfies RuntimeMobKillLootPlan)
      : this.ledgerLoot.buildRuntimeMobKillLootPlan({
          dropTable: mobDropTable,
          rng,
          worldDrop: {
            zoneId: mobZoneId,
            basePos: mobPos,
            reservedForCharacterId: dropOwnerId,
            reserveDurationMs: 10_000,
          },
          templatesByCatalog: map,
        });

    const expAmount = levelPenaltyActive ? 0 : mobExpReward;
    const projected = this.characterService.projectExperienceGain(
      { level: character.level, experience: character.experience },
      expAmount,
    );

    const rewardsPayload: WsAttackMobRewardsPayload = {
      mobInstanceId,
      experienceGained: expAmount,
      adenaGranted: loot.adenaGranted.toString(),
      itemInstanceIds: loot.worldDrops.map((w) => w.itemInstanceId),
      levelsGained: projected.levelsGained,
      level: projected.level,
      experience: projected.experience,
      experienceRequiredForNext: this.statEngine.experienceRequiredForNextOrZero(
        projected.level,
      ),
      worldDropSpawns: loot.worldDrops.map((w) => w.spawnPayload),
    };

    return {
      loot,
      expAmount,
      sourceTemplateExpReward: mobExpReward,
      rewardsPayload,
    };
  }

  /**
   * Auto-ataque (RAM): el golpe final ya se aplicó en memoria; persiste muerte, loot y EXP en una tx.
   */
  async commitRuntimeMobKill(
    characterId: string,
    mobInstanceId: string,
    lastHit: { damage: number; critical: boolean; backstab: boolean },
    options?: {
      rng?: () => number;
      precomputedPlan?: RuntimeMobKillCommitPlan;
      suppressDuplicateWorldDropBroadcast?: boolean;
    },
  ): Promise<AttackMobResult> {
    const rand = options?.rng ?? Math.random;
    const precomputedPlan = options?.precomputedPlan;
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const character = await tx.character.findUnique({
          where: { id: characterId },
        });
        if (!character) {
          throw new NotFoundException(`Character not found: ${characterId}`);
        }
        const mob = await tx.mobInstance.findUnique({
          where: { id: mobInstanceId },
          include: { template: true },
        });
        if (!mob) {
          throw new NotFoundException(`MobInstance not found: ${mobInstanceId}`);
        }
        if (!mob.isAlive) {
          return {
            damage: lastHit.damage,
            critical: lastHit.critical,
            mobHpAfter: 0,
            mobKilled: false,
          } satisfies AttackMobResult;
        }
        const partyId = await this.resolvePartyIdForCharacter(tx, characterId);
        this.damageTracker.recordDamage({
          mobInstanceId,
          characterId,
          partyId,
          damage: lastHit.damage,
        });

        await tx.mobInstance.update({
          where: { id: mobInstanceId },
          data: {
            currentHp: 0,
            isAlive: false,
            diedAt: new Date(),
          },
        });

        await tx.character.update({
          where: { id: characterId },
          data: {
            lastAttackServerAt: new Date(),
            lastCombatAt: new Date(),
          },
        });

        let adenaGranted: bigint;
        let itemInstanceIds: string[];
        let worldDropSpawns: WsWorldDropSpawnPayload[];
        let expAmount: number;

        if (precomputedPlan) {
          if (
            mob.template.expReward !== precomputedPlan.sourceTemplateExpReward
          ) {
            throw new BadRequestException({
              code: 'STALE_KILL_PLAN',
              message: 'Mob exp reward changed since kill plan was built',
            });
          }
          const applied = await this.ledgerLoot.applyRuntimeMobKillLootPlan(tx, {
            accountId: character.accountId,
            plan: precomputedPlan.loot,
          });
          adenaGranted = applied.adenaGranted;
          itemInstanceIds = applied.itemInstanceIds;
          worldDropSpawns = applied.worldDropSpawns;
          expAmount = precomputedPlan.expAmount;
        } else {
          const dropOwnerId = this.resolveDropOwnerId(mobInstanceId, characterId);
          const mobLevel = getMobLevelForTemplateKey(mob.template.templateKey);
          const ownerLevel = await this.resolveOwnerLevelForDrop(
            tx,
            dropOwnerId,
            character.level,
          );
          const levelPenaltyActive = isGreyMobNoBenefitPenalty(
            ownerLevel,
            mobLevel,
          );
          const applied = await this.ledgerLoot.applyMobDropTable(tx, {
            accountId: character.accountId,
            characterId,
            dropTable: levelPenaltyActive ? {} : mob.template.dropTable,
            rng: rand,
            worldDrop: {
              zoneId: mob.zoneId,
              basePos: { x: mob.posX, y: mob.posY, z: mob.posZ },
              reservedForCharacterId: dropOwnerId,
              reserveDurationMs: 10_000,
            },
          });
          adenaGranted = applied.adenaGranted;
          itemInstanceIds = applied.itemInstanceIds;
          worldDropSpawns = applied.worldDropSpawns;
          expAmount = levelPenaltyActive ? 0 : mob.template.expReward;
        }
        const { character: afterExp, levelsGained } =
          await this.characterService.addExperience(
            characterId,
            expAmount,
            tx,
          );

        return {
          damage: lastHit.damage,
          critical: lastHit.critical,
          mobHpAfter: 0,
          mobKilled: true,
          mobTemplateKey: mob.template.templateKey,
          zoneId: mob.zoneId,
          rewards: {
            experienceGained: expAmount,
            adenaGranted: adenaGranted.toString(),
            itemInstanceIds,
            levelsGained,
            level: afterExp.level,
            experience: afterExp.experience,
            experienceRequiredForNext:
              this.statEngine.experienceRequiredForNextOrZero(afterExp.level),
            worldDropSpawns,
          },
        } satisfies AttackMobResult;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );

    this.logger.log(
      `[RuntimeKill] Player ${characterId} -> Mob ${mobInstanceId}. damage=${outcome.damage} killed=${outcome.mobKilled}`,
    );

    if (
      outcome.mobKilled &&
      outcome.rewards?.worldDropSpawns?.length &&
      !options?.suppressDuplicateWorldDropBroadcast
    ) {
      this.emitWorldDropSpawns(outcome.zoneId ?? null, outcome.rewards.worldDropSpawns);
    }

    if (outcome.mobKilled && outcome.mobTemplateKey) {
      this.damageTracker.clearMob(mobInstanceId);
      this.mobService.emitMobDeath({
        mobInstanceId,
        mobTemplateKey: outcome.mobTemplateKey,
        killerCharacterId: characterId,
        zoneId: outcome.zoneId ?? null,
        occurredAt: new Date(),
      });
    }

    if (outcome.mobKilled) {
      this.mobCombatRegen.clear(mobInstanceId);
    }

    return outcome;
  }

  /**
   * Mob→jugador (RAM): persiste muerte PvE + `lastMobMeleeAt` del mob sin haber escrito el golpe en DB.
   * No repone al personaje: queda en HP 0 en el punto de caída esperando `REQUEST_RESPAWN`.
   */
  async commitRuntimePlayerDeath(
    characterId: string,
    mobInstanceId: string,
  ): Promise<PvEDeathResolution> {
    const death = await this.prisma.$transaction(
      async (tx) => {
        const d = await this.characterService.applyPvEDeathInTx(tx, characterId);
        await tx.mobInstance.update({
          where: { id: mobInstanceId },
          data: { lastMobMeleeAt: new Date() },
        });
        return d;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );

    const meta = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { name: true },
    });

    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.PLAYER_VITALS, {
      characterId,
      currentHp: death.currentHp,
      maxHp: death.maxHp,
    });

    this.broadcastPlayerDeath(characterId, meta?.name, death);

    this.logger.log(`[RuntimeDeath] Player ${characterId} (mob ${mobInstanceId})`);

    return death;
  }

  /**
   * Difusión de muerte a la zona **donde cayó** el personaje: su socket sigue en esa room,
   * así que es la única que garantiza que la víctima reciba su propio `player-death`.
   */
  private broadcastPlayerDeath(
    characterId: string,
    displayName: string | undefined,
    death: PvEDeathResolution,
  ): void {
    const deathPayload: WsPlayerDeathPayload = {
      characterId,
      displayName,
      experienceLost: death.experienceLost,
      newExperience: death.newExperience,
      worldPos: death.worldPos,
      worldFacingYaw: death.worldFacingYaw,
      currentHp: death.currentHp,
      maxHp: death.maxHp,
      respawnZoneId: death.respawn.zoneId,
      respawnWorldPos: death.respawn.worldPos,
    };
    this.bridge.broadcastToZone(
      death.zoneId,
      WS_WORLD_EVENTS.PLAYER_DEATH,
      deathPayload,
    );
  }

  async attackCharacter(
    attackerCharacterId: string,
    targetCharacterId: string,
    options?: { rng?: () => number },
  ): Promise<AttackPlayerCharacterResult> {
    const rand = options?.rng ?? Math.random;
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const [attacker, target] = await Promise.all([
          tx.character.findUnique({ where: { id: attackerCharacterId } }),
          tx.character.findUnique({ where: { id: targetCharacterId } }),
        ]);
        if (!attacker || !target) {
          throw new NotFoundException('Attacker or target character does not exist');
        }
        if (attacker.id === target.id) {
          throw new BadRequestException({
            code: 'INVALID_TARGET',
            message: 'A character cannot attack itself',
          });
        }
        if (!zonesMatch(attacker.currentZoneId, target.currentZoneId)) {
          throw new BadRequestException({
            code: 'ZONE_MISMATCH',
            message: 'Attacker and target are not in the same zone',
          });
        }
        if (target.currentHp <= 0) {
          throw new BadRequestException({
            code: 'TARGET_ALREADY_DEAD',
            message: 'Target is already dead',
          });
        }

        const timing = loadCombatTimingConfig();
        const atkSpeed = Math.max(0.65, attacker.derivedAtkSpeed);
        let cooldownMs = timing.baseSwingCooldownMs / atkSpeed;
        cooldownMs = Math.min(
          timing.maxCooldownMs,
          Math.max(timing.minCooldownMs, cooldownMs),
        );
        if (attacker.lastAttackServerAt) {
          const elapsed = Date.now() - attacker.lastAttackServerAt.getTime();
          if (elapsed < cooldownMs) {
            throw new BadRequestException({
              code: 'ATTACK_ON_COOLDOWN',
              message: 'Melee swing on cooldown',
            });
          }
        }

        const inRange = this.worldSpatial.isWithinMeleeAttackRange(
          { x: attacker.worldPosX, y: attacker.worldPosY, z: attacker.worldPosZ },
          { x: target.worldPosX, y: target.worldPosY, z: target.worldPosZ },
          1.8,
        );
        if (!inRange) {
          throw new BadRequestException({
            code: 'ATTACK_OUT_OF_RANGE',
            message: 'Attacker is too far from player target',
          });
        }

        const dmgCfg = loadCombatDamageConfig();
        const baseMitigated =
          attacker.derivedPAtk - target.derivedPDef * dmgCfg.physicalMitigationFactor;
        const critical = rand() < attacker.derivedCritRate;
        let damage = Math.floor(
          critical ? baseMitigated * dmgCfg.criticalMultiplier : baseMitigated,
        );
        if (!Number.isFinite(damage) || damage < dmgCfg.minimumDamage) {
          damage = dmgCfg.minimumDamage;
        }

        const attackTransition = this.penaltyManager.applyUnjustifiedAttackTransition({
          attacker,
          victimTier: target.karmaTier,
        });
        if (attackTransition.changed) {
          await tx.character.update({
            where: { id: attacker.id },
            data: {
              karmaPoints: attackTransition.karmaPoints,
              karmaTier: attackTransition.karmaTier,
            },
          });
        }

        const hpAfter = Math.max(0, target.currentHp - damage);
        await tx.character.update({
          where: { id: attacker.id },
          data: {
            lastAttackServerAt: new Date(),
            lastCombatAt: new Date(),
          },
        });

        let death: PvEDeathResolution | null = null;
        let pkDropSpawn: WsWorldDropSpawnPayload | undefined;
        if (hpAfter > 0) {
          await tx.character.update({
            where: { id: target.id },
            data: {
              currentHp: hpAfter,
              lastCombatAt: new Date(),
            },
          });
        } else {
          death = await this.characterService.applyPvEDeathInTx(tx, target.id);

          const killTransition = this.penaltyManager.applyUnjustifiedKillTransition({
            attacker: {
              karmaPoints: attackTransition.karmaPoints,
              karmaTier: attackTransition.karmaTier,
              unjustifiedKillCount: attackTransition.unjustifiedKillCount,
            },
            victimTier: target.karmaTier,
          });
          if (killTransition.changed) {
            await tx.character.update({
              where: { id: attacker.id },
              data: {
                karmaPoints: killTransition.karmaPoints,
                karmaTier: killTransition.karmaTier,
                unjustifiedKillCount: killTransition.unjustifiedKillCount,
              },
            });
          }

          if (this.penaltyManager.canTriggerRedDrop(target.karmaTier)) {
            const equipped = await tx.itemInstance.findMany({
              where: {
                ownerId: target.id,
                location: ItemInstanceLocation.EQUIPPED,
              },
              select: {
                id: true,
                valueScore: true,
                gearSlot: true,
              },
            });
            const roll = this.penaltyManager.rollRedDeathEquippedDrop(equipped, rand);
            if (roll.shouldDrop) {
              pkDropSpawn = await this.ledgerLoot.dropEquippedItemForPkDeath(tx, {
                itemInstanceId: roll.droppedItemInstanceId,
                context: {
                  zoneId: target.currentZoneId,
                  basePos: {
                    x: target.worldPosX,
                    y: target.worldPosY,
                    z: target.worldPosZ,
                  },
                },
                rng: rand,
              });
              await this.characterService.recalculateDerivedStats(target.id, tx);
            }
          }
        }

        const [attackerRefresh, targetRefresh, attackerEquipped, targetEquipped] =
          await Promise.all([
            tx.character.findUnique({ where: { id: attacker.id } }),
            tx.character.findUnique({ where: { id: target.id } }),
            tx.itemInstance.findMany({
              where: {
                ownerId: attacker.id,
                location: ItemInstanceLocation.EQUIPPED,
              },
              select: { gearSlot: true, synthesisLevel: true },
            }),
            tx.itemInstance.findMany({
              where: {
                ownerId: target.id,
                location: ItemInstanceLocation.EQUIPPED,
              },
              select: { gearSlot: true, synthesisLevel: true },
            }),
          ]);
        if (!attackerRefresh || !targetRefresh) {
          throw new NotFoundException('Combatants not found after PvP update');
        }

        const attackerFlag = this.penaltyManager.getKarmaFlagFromTier(attackerRefresh.karmaTier);
        const targetFlag = this.penaltyManager.getKarmaFlagFromTier(targetRefresh.karmaTier);

        return {
          attackerCharacterId: attacker.id,
          targetCharacterId: target.id,
          damage,
          critical,
          targetHpAfter: death?.currentHp ?? hpAfter,
          targetKilled: hpAfter <= 0,
          zoneId: attacker.currentZoneId,
          attackerFlag,
          targetFlag,
          attackerWeaponPlusLevel: this.penaltyManager.resolveWeaponPlusLevel(attackerEquipped),
          targetWeaponPlusLevel: this.penaltyManager.resolveWeaponPlusLevel(targetEquipped),
          pkDropSpawn,
          death,
          targetName: target.name,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    const targetVitals = await this.statEngine.getCombatVitals(outcome.targetCharacterId);
    this.bridge.emitToCharacter(outcome.targetCharacterId, WS_WORLD_EVENTS.PLAYER_VITALS, {
      characterId: outcome.targetCharacterId,
      currentHp: targetVitals.currentHp,
      maxHp: targetVitals.maxHp,
    } satisfies WsPlayerVitalsPayload);

    this.bridge.broadcastToZone(outcome.zoneId, WS_WORLD_EVENTS.ATTACK_PLAYER_RESULT, {
      attackerCharacterId: outcome.attackerCharacterId,
      targetCharacterId: outcome.targetCharacterId,
      damage: outcome.damage,
      critical: outcome.critical,
      targetHpAfter: outcome.targetHpAfter,
      targetKilled: outcome.targetKilled,
    });

    this.bridge.broadcastToZone(outcome.zoneId, WS_WORLD_EVENTS.PLAYER_VISUAL_STATE, {
      characterId: outcome.attackerCharacterId,
      karmaFlag: outcome.attackerFlag,
      weaponPlusLevel: outcome.attackerWeaponPlusLevel,
    });
    this.bridge.broadcastToZone(outcome.zoneId, WS_WORLD_EVENTS.PLAYER_VISUAL_STATE, {
      characterId: outcome.targetCharacterId,
      karmaFlag: outcome.targetFlag,
      weaponPlusLevel: outcome.targetWeaponPlusLevel,
    });

    if (outcome.pkDropSpawn) {
      this.bridge.broadcastToZone(outcome.zoneId, WS_WORLD_EVENTS.WORLD_DROP_SPAWN, outcome.pkDropSpawn);
    }
    if (outcome.targetKilled && outcome.death) {
      this.broadcastPlayerDeath(
        outcome.targetCharacterId,
        outcome.targetName,
        outcome.death,
      );
    }

    return {
      attackerCharacterId: outcome.attackerCharacterId,
      targetCharacterId: outcome.targetCharacterId,
      damage: outcome.damage,
      critical: outcome.critical,
      targetHpAfter: outcome.targetHpAfter,
      targetKilled: outcome.targetKilled,
      zoneId: outcome.zoneId,
      attackerFlag: outcome.attackerFlag,
      targetFlag: outcome.targetFlag,
      attackerWeaponPlusLevel: outcome.attackerWeaponPlusLevel,
      targetWeaponPlusLevel: outcome.targetWeaponPlusLevel,
      pkDropSpawn: outcome.pkDropSpawn,
    };
  }

  /**
   * Mob → jugador: daño físico mitigado por P.Def del personaje.
   * Emite vitales (y muerte + movimiento si aplica) por `WorldSocketBridgeService`.
   */
  async attackPlayer(
    mobInstanceId: string,
    characterId: string,
  ): Promise<AttackPlayerResult> {
    const timing = loadCombatTimingConfig();
    const mobCd = timing.mobMeleeCooldownMs ?? 900;
    const nowMs = Date.now();

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const mob = await tx.mobInstance.findUnique({
          where: { id: mobInstanceId },
          include: { template: true },
        });
        if (!mob || !mob.isAlive) {
          throw new BadRequestException({
            code: 'MOB_INVALID',
            message: 'Mob is not a valid living target',
          });
        }
        if (mob.aggroTargetCharacterId !== characterId) {
          throw new BadRequestException({
            code: 'MOB_NOT_AGGROED',
            message: 'Mob is not aggroed on this character',
          });
        }

        const character = await tx.character.findUnique({
          where: { id: characterId },
        });
        if (!character) {
          throw new NotFoundException(`Character not found: ${characterId}`);
        }

        if (!zonesMatch(character.currentZoneId, mob.zoneId)) {
          throw new BadRequestException({
            code: 'ZONE_MISMATCH',
            message: 'Character and mob are not in the same zone',
          });
        }

        const inRange = this.worldSpatial.isWithinMobToPlayerMeleeRange(
          { x: mob.posX, y: mob.posY, z: mob.posZ },
          {
            x: character.worldPosX,
            y: character.worldPosY,
            z: character.worldPosZ,
          },
          mob.template.attackRange,
        );
        if (!inRange) {
          throw new BadRequestException({
            code: 'MOB_OUT_OF_RANGE',
            message: 'Mob is too far to strike the character',
          });
        }

        if (mob.lastMobMeleeAt) {
          const elapsed = nowMs - mob.lastMobMeleeAt.getTime();
          if (elapsed < mobCd) {
            throw new BadRequestException({
              code: 'MOB_ATTACK_ON_COOLDOWN',
              message: 'Mob melee on cooldown',
            });
          }
        }

        const damage = resolveMobToPlayerMeleeDamage({
          mobPAtk: mob.template.pAtk,
          derivedPDef: character.derivedPDef,
        });
        const hpBefore = character.currentHp;
        const nextHp = Math.max(0, hpBefore - damage);

        let death: PvEDeathResolution | undefined;
        if (nextHp > 0) {
          await tx.character.update({
            where: { id: characterId },
            data: {
              currentHp: nextHp,
              lastCombatAt: new Date(),
            },
          });
        } else {
          death = await this.characterService.applyPvEDeathInTx(tx, characterId);
        }

        await tx.mobInstance.update({
          where: { id: mobInstanceId },
          data: { lastMobMeleeAt: new Date() },
        });

        const rowWithItems = await tx.character.findUnique({
          where: { id: characterId },
          include: {
            items: {
              where: { location: ItemInstanceLocation.EQUIPPED },
              include: { template: true },
            },
          },
        });
        const v = this.statEngine.getCombatVitalsFromLoaded(
          rowWithItems as Character & { items: EquippedRow[] },
        );

        return {
          damage,
          targetCharacterId: characterId,
          mobInstanceId,
          currentHp: v.currentHp,
          maxHp: v.maxHp,
          killed: nextHp <= 0,
          death,
        } satisfies AttackPlayerResult;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );

    const meta = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { name: true, currentZoneId: true },
    });

    const vitalsPayload: WsPlayerVitalsPayload = {
      characterId,
      currentHp: outcome.currentHp,
      maxHp: outcome.maxHp,
    };
    this.bridge.emitToCharacter(
      characterId,
      WS_WORLD_EVENTS.PLAYER_VITALS,
      vitalsPayload,
    );

    if (outcome.killed && outcome.death) {
      this.broadcastPlayerDeath(characterId, meta?.name, outcome.death);
    }

    return outcome;
  }

  private emitWorldDropSpawns(
    zoneId: string | null,
    spawns: WsWorldDropSpawnPayload[],
  ): void {
    const z = normalizeZoneId(zoneId);
    for (const s of spawns) {
      this.bridge.broadcastToZone(z, WS_WORLD_EVENTS.WORLD_DROP_SPAWN, s);
    }
  }

  private resolveDropOwnerId(
    mobInstanceId: string,
    fallbackCharacterId: string,
  ): string {
    const owner = this.damageTracker.resolveTopOwner(mobInstanceId);
    if (!owner) {
      return fallbackCharacterId;
    }
    return owner.ownerId;
  }

  private async resolvePartyIdForCharacter(
    _tx: Prisma.TransactionClient,
    _characterId: string,
  ): Promise<string | null> {
    return null;
  }

  private async resolveOwnerLevelForDrop(
    db:
      | PrismaService
      | Prisma.TransactionClient,
    ownerId: string,
    fallbackLevel: number,
  ): Promise<number> {
    if (!UUID_RE.test(ownerId)) {
      return fallbackLevel;
    }
    const owner = await db.character.findUnique({
      where: { id: ownerId },
      select: { level: true },
    });
    return owner?.level ?? fallbackLevel;
  }
}
