import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorldSocketBridgeService } from '../world/world-socket-bridge.service';
import { getWorldZoneDefinition } from '../world/config/world-zones.loaders';
import { WS_WORLD_EVENTS, type WsDungeonExpelledPayload } from '@aetheris/shared-types';

const NEXUS_ZONE_ID = 'Zone_0';
/** Red de seguridad además del `setTimeout` puntual: cubre timers perdidos en un reinicio. */
const SAFETY_SWEEP_INTERVAL_MS = 30_000;

/**
 * Dueño del cronómetro de 10 min de una corrida de mazmorra (NexusManager). Persistido en DB
 * (no RAM como `Party`) porque debe sobrevivir a una desconexión o a un reinicio del proceso:
 * mismo patrón que `MobRespawnService` (DB es la fuente de verdad, el `setTimeout` es solo una
 * optimización de latencia; un sweep periódico reconcilia lo que un timer perdido dejaría colgado).
 */
@Injectable()
export class DungeonSessionTickService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DungeonSessionTickService.name);
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: WorldSocketBridgeService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconcile();
    this.sweepTimer = setInterval(() => void this.reconcile(), SAFETY_SWEEP_INTERVAL_MS);
    this.logger.log(`Dungeon session reconciler every ${SAFETY_SWEEP_INTERVAL_MS}ms`);
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  scheduleExpiry(characterId: string, expiresAt: Date): void {
    this.cancelScheduledExpiry(characterId);
    const delayMs = Math.max(0, expiresAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(characterId);
      void this.expelCharacter(characterId, 'TIME_UP').catch((e) => {
        this.logger.warn(
          `No se pudo expulsar por tiempo a ${characterId}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
    }, delayMs);
    this.timers.set(characterId, timer);
  }

  cancelScheduledExpiry(characterId: string): void {
    const timer = this.timers.get(characterId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(characterId);
    }
  }

  /** Al boot: expulsa sesiones ya vencidas y reagenda el resto. Idempotente. */
  private async reconcile(): Promise<void> {
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      const sessions = await this.prisma.dungeonSession.findMany();
      const now = Date.now();
      for (const session of sessions) {
        if (session.expiresAt.getTime() <= now) {
          await this.expelCharacter(session.characterId, 'TIME_UP');
        } else if (!this.timers.has(session.characterId)) {
          this.scheduleExpiry(session.characterId, session.expiresAt);
        }
      }
    } catch (e) {
      this.logger.warn(
        `Reconciliación de sesiones de mazmorra falló: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * Fuerza la salida de la mazmorra: borra la sesión, devuelve el personaje al nexo
   * (`Zone_0`) y migra su socket si está conectado. Usado por el timeout de 10 min y por
   * un kill PvP dentro de una cámara (ver `combat.service.ts`). No-op si ya no hay sesión
   * (double-fire del timer vs. un `exit` manual que ya la borró).
   */
  async expelCharacter(characterId: string, reason: 'TIME_UP' | 'PVP_KILLED'): Promise<void> {
    this.cancelScheduledExpiry(characterId);

    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { currentZoneId: true },
    });
    const deleted = await this.prisma.dungeonSession
      .delete({ where: { characterId } })
      .catch(() => null);
    if (!character || !deleted) {
      return;
    }

    const oldZoneId = character.currentZoneId;
    const nexus = getWorldZoneDefinition(NEXUS_ZONE_ID);
    if (!nexus) {
      this.logger.error(`world-zones.json no tiene definida ${NEXUS_ZONE_ID}`);
      return;
    }

    await this.prisma.character.update({
      where: { id: characterId },
      data: {
        currentZoneId: NEXUS_ZONE_ID,
        worldPosX: nexus.entrySpawn.worldPos.x,
        worldPosY: nexus.entrySpawn.worldPos.y,
        worldPosZ: nexus.entrySpawn.worldPos.z,
        worldFacingYaw: nexus.entrySpawn.worldFacingYaw,
      },
    });

    this.bridge.leaveCharacterFromRoom(characterId, this.bridge.zoneRoomId(oldZoneId));
    this.bridge.joinCharacterToRoom(characterId, this.bridge.zoneRoomId(NEXUS_ZONE_ID));
    this.bridge.setCharacterZoneId(characterId, NEXUS_ZONE_ID);
    this.bridge.broadcastToZone(oldZoneId, WS_WORLD_EVENTS.PLAYER_LEFT_ZONE, { characterId });
    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.DUNGEON_EXPELLED, {
      reason,
      zoneId: NEXUS_ZONE_ID,
    } satisfies WsDungeonExpelledPayload);
  }
}
