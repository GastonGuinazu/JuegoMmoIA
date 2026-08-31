import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorldSpatialService } from '../world/world-spatial.service';
import { normalizeZoneId } from '../world/world-zone.util';

/**
 * Al arranque: mobs vivos con spawn XZ degenerado (0,0) heredan spawn desde posición actual.
 * Evita leash / “home” incorrectos cuando `spawnPos` nunca se persistió.
 */
@Injectable()
export class MobSpawnBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(MobSpawnBootstrapService.name);
  private readonly aiCollisionDebug =
    (process.env.AETHERIS_AI_COLLISION_DEBUG ?? '').toLowerCase() === 'true' ||
    process.env.AETHERIS_AI_COLLISION_DEBUG === '1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: WorldSpatialService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.prisma.mobInstance.findMany({
        where: {
          isAlive: true,
          AND: [
            { spawnPosX: { gte: -1e-3, lte: 1e-3 } },
            { spawnPosZ: { gte: -1e-3, lte: 1e-3 } },
          ],
        },
        select: { id: true, zoneId: true, posX: true, posY: true, posZ: true },
      });
      if (rows.length === 0) {
        return;
      }
      let correctedInsideObstacle = 0;
      for (const r of rows) {
        const zoneId = normalizeZoneId(r.zoneId);
        const safe = this.spatial.resolvePointOutsideObstacles({
          point: { x: r.posX, y: r.posY, z: r.posZ },
          zoneId,
        });
        if (safe.blocked) {
          correctedInsideObstacle += 1;
          if (this.aiCollisionDebug) {
            this.logger.debug(
              `[AI Collision] Mob ${r.id} hit obstacle at (${r.posX.toFixed(2)}, ${r.posY.toFixed(2)}, ${r.posZ.toFixed(2)}) (bootstrap spawn correction).`,
            );
          }
        }
        await this.prisma.mobInstance.update({
          where: { id: r.id },
          data: {
            spawnPosX: safe.corrected.x,
            spawnPosY: safe.corrected.y,
            spawnPosZ: safe.corrected.z,
            posX: safe.corrected.x,
            posY: safe.corrected.y,
            posZ: safe.corrected.z,
          },
        });
      }
      this.logger.log(
        `[SpawnBootstrap] Fixed spawnPos from current pos for ${rows.length} mob(s). Corrected ${correctedInsideObstacle} inside obstacle(s).`,
      );
    } catch (e) {
      this.logger.warn(
        `[SpawnBootstrap] Skipped: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
