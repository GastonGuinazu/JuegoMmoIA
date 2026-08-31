import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { MobAiState } from '@prisma/client';
import {
  getMobLevelForTemplateKey,
  getRespawnDelayMsForTemplateKey,
  getRespawnSweepIntervalMs,
} from '../mob/mob-config.loaders';
import { MobService } from '../mob/mob.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  WS_WORLD_EVENTS,
  type WsMobRespawnPayload,
} from '@aetheris/shared-types';
import { WorldSocketBridgeService } from './world-socket-bridge.service';
import { PlayerCombatRuntimeService } from '../combat/player-combat-runtime.service';
import { MobCombatRegenService } from '../mob/mob-combat-regen.service';
import { WorldSpatialService } from './world-spatial.service';
import { normalizeZoneId } from './world-zone.util';

/**
 * Ciclo de respawn PvE persistente.
 *
 * La fuente de verdad del respawn pendiente es la DB (`isAlive=false` + `diedAt`), no el
 * temporizador en memoria: los `setTimeout` son sólo una optimización para reaccionar en el
 * milisegundo exacto. Un barrido de arranque más un reconciliador periódico garantizan que
 * ningún mob quede muerto para siempre por un reinicio del proceso.
 */
@Injectable()
export class MobRespawnService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MobRespawnService.name);
  private sub: Subscription | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweepInFlight = false;
  /** Respawns ya agendados, para que el barrido no duplique el trabajo del evento de muerte. */
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly aiCollisionDebug =
    (process.env.AETHERIS_AI_COLLISION_DEBUG ?? '').toLowerCase() === 'true' ||
    process.env.AETHERIS_AI_COLLISION_DEBUG === '1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly mobService: MobService,
    private readonly bridge: WorldSocketBridgeService,
    private readonly playerCombatRuntime: PlayerCombatRuntimeService,
    private readonly mobCombatRegen: MobCombatRegenService,
    private readonly spatial: WorldSpatialService,
  ) {}

  onModuleInit(): void {
    this.sub = this.mobService.mobDeathEvents.subscribe((ev) => {
      this.schedule(
        ev.mobInstanceId,
        getRespawnDelayMsForTemplateKey(ev.mobTemplateKey),
      );
    });

    const sweepMs = getRespawnSweepIntervalMs();
    this.sweepTimer = setInterval(() => {
      void this.sweepPendingRespawns();
    }, sweepMs);

    // Arranque: recuperar los mobs que murieron antes de este proceso.
    void this.sweepPendingRespawns(true);
    this.logger.log(`Respawn reconciler every ${sweepMs}ms`);
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    for (const timer of this.scheduled.values()) {
      clearTimeout(timer);
    }
    this.scheduled.clear();
  }

  private schedule(mobInstanceId: string, delayMs: number): void {
    const existing = this.scheduled.get(mobInstanceId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.scheduled.delete(mobInstanceId);
      void this.respawnMob(mobInstanceId);
    }, Math.max(0, delayMs));
    this.scheduled.set(mobInstanceId, timer);
  }

  /**
   * Reconcilia contra la DB: revive lo vencido y agenda lo pendiente. Idempotente, así que
   * puede correr en el arranque y en cada intervalo sin duplicar respawns.
   */
  private async sweepPendingRespawns(isBootstrap = false): Promise<void> {
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      const dead = await this.prisma.mobInstance.findMany({
        where: { isAlive: false },
        select: {
          id: true,
          diedAt: true,
          template: { select: { templateKey: true } },
        },
      });

      const now = Date.now();
      let revived = 0;
      let pending = 0;

      for (const row of dead) {
        if (this.scheduled.has(row.id)) {
          pending += 1;
          continue;
        }
        const delayMs = getRespawnDelayMsForTemplateKey(row.template.templateKey);
        // Sin `diedAt` no hay forma de datar la muerte: revivir ya antes que dejarlo perdido.
        const dueAtMs = row.diedAt ? row.diedAt.getTime() + delayMs : now;
        const remainingMs = dueAtMs - now;

        if (remainingMs <= 0) {
          await this.respawnMob(row.id);
          revived += 1;
        } else {
          this.schedule(row.id, remainingMs);
          pending += 1;
        }
      }

      if (isBootstrap && dead.length > 0) {
        this.logger.log(
          `[RespawnSweep] Bootstrap: ${dead.length} mob(s) muertos → ${revived} revividos, ${pending} agendados.`,
        );
      } else if (revived > 0) {
        this.logger.log(
          `[RespawnSweep] Recuperados ${revived} mob(s) con respawn vencido.`,
        );
      }
    } catch (e) {
      this.logger.warn(`[RespawnSweep] Falló la reconciliación: ${String(e)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  private async respawnMob(mobInstanceId: string): Promise<void> {
    try {
      this.playerCombatRuntime.invalidateMobRuntime(mobInstanceId);
      this.mobCombatRegen.clear(mobInstanceId);
      const row = await this.prisma.mobInstance.findUnique({
        where: { id: mobInstanceId },
        include: { template: true },
      });
      if (!row) {
        return;
      }
      if (row.isAlive) {
        return;
      }
      const zoneId = normalizeZoneId(row.zoneId);
      const safeRespawn = this.spatial.resolvePointOutsideObstacles({
        point: { x: row.spawnPosX, y: row.spawnPosY, z: row.spawnPosZ },
        zoneId,
      });
      if (safeRespawn.blocked && this.aiCollisionDebug) {
        this.logger.debug(
          `[AI Collision] Mob ${row.id} hit obstacle at (${row.spawnPosX.toFixed(2)}, ${row.spawnPosY.toFixed(2)}, ${row.spawnPosZ.toFixed(2)}) (respawn correction).`,
        );
      }

      // Guarda de concurrencia: sólo revive quien gane la transición isAlive false → true,
      // así el barrido y el temporizador nunca emiten dos respawns del mismo mob.
      const claimed = await this.prisma.mobInstance.updateMany({
        where: { id: mobInstanceId, isAlive: false },
        data: {
          isAlive: true,
          currentHp: row.template.maxHp,
          diedAt: null,
          posX: safeRespawn.corrected.x,
          posY: safeRespawn.corrected.y,
          posZ: safeRespawn.corrected.z,
          aggroTargetCharacterId: null,
          lastMobMeleeAt: null,
          aiState: MobAiState.IDLE,
        },
      });
      if (claimed.count === 0) {
        return;
      }

      const payload: WsMobRespawnPayload = {
        mobInstanceId: row.id,
        mobTemplateKey: row.template.templateKey,
        displayName: row.template.displayName,
        mobLevel: getMobLevelForTemplateKey(row.template.templateKey),
        currentHp: row.template.maxHp,
        maxHp: row.template.maxHp,
        pos: {
          x: safeRespawn.corrected.x,
          y: safeRespawn.corrected.y,
          z: safeRespawn.corrected.z,
        },
        worldFacingYaw: row.worldFacingYaw,
        aiState: MobAiState.IDLE,
        attackRange: row.template.attackRange ?? 2.5,
      };

      this.bridge.broadcastToZone(
        zoneId,
        WS_WORLD_EVENTS.MOB_RESPAWN,
        payload,
      );
    } catch (e) {
      this.logger.warn(`Mob respawn failed for ${mobInstanceId}: ${String(e)}`);
    }
  }
}
