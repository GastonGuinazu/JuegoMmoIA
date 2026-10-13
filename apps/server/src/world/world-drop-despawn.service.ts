import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ItemInstanceLocation } from '@prisma/client';
import {
  WS_WORLD_EVENTS,
  type WsWorldDropRemovedPayload,
} from '@aetheris/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { WorldSocketBridgeService } from './world-socket-bridge.service';
import { normalizeZoneId } from './world-zone.util';

/** Tiempo en el suelo antes de desaparecer: sin esto el piso se llena de drops sin dueño. */
const WORLD_DROP_DESPAWN_MS = 120_000;
const WORLD_DROP_SWEEP_INTERVAL_MS = 15_000;

/**
 * Barrido periódico que elimina WORLD_DROP vencidos (por `createdAt`, siempre fresco: cada
 * drop es una fila `itemInstance` nueva, ver `loot.service.ts`) y avisa a la zona para que
 * el cliente los saque del mapa, igual que al recogerlos.
 */
@Injectable()
export class WorldDropDespawnService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorldDropDespawnService.name);
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweepInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: WorldSocketBridgeService,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.sweepExpiredDrops();
    }, WORLD_DROP_SWEEP_INTERVAL_MS);
    this.logger.log(
      `World drop despawn sweep every ${WORLD_DROP_SWEEP_INTERVAL_MS}ms (TTL ${WORLD_DROP_DESPAWN_MS}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
  }

  private async sweepExpiredDrops(): Promise<void> {
    if (this.sweepInFlight) {
      return;
    }
    this.sweepInFlight = true;
    try {
      const cutoff = new Date(Date.now() - WORLD_DROP_DESPAWN_MS);
      const expired = await this.prisma.itemInstance.findMany({
        where: {
          location: ItemInstanceLocation.WORLD_DROP,
          createdAt: { lt: cutoff },
        },
        select: { id: true, worldDropZoneId: true },
      });
      if (expired.length === 0) {
        return;
      }

      // Guarda de concurrencia: si alguien lo recogió entre el find y acá, ya no es
      // WORLD_DROP y este delete lo deja afuera (el pick-item propio ya avisó su remoción).
      const deleted = await this.prisma.itemInstance.deleteMany({
        where: {
          id: { in: expired.map((e) => e.id) },
          location: ItemInstanceLocation.WORLD_DROP,
        },
      });

      for (const row of expired) {
        const payload: WsWorldDropRemovedPayload = { itemInstanceId: row.id };
        this.bridge.broadcastToZone(
          normalizeZoneId(row.worldDropZoneId),
          WS_WORLD_EVENTS.WORLD_DROP_REMOVED,
          payload,
        );
      }

      if (deleted.count > 0) {
        this.logger.log(`[DropDespawn] ${deleted.count} drop(s) expirado(s) eliminados.`);
      }
    } catch (e) {
      this.logger.warn(`[DropDespawn] Falló el barrido: ${String(e)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }
}
