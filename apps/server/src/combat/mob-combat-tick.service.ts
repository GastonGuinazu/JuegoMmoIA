import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlayerCombatRuntimeService } from './player-combat-runtime.service';

/**
 * Tick servidor 20 TPS: mobs con aggro intentan melee. El GCD real vive en RAM
 * (`meleeCooldownMs` / `combat-timing.mobMeleeCooldownMs`); este intervalo sólo
 * despierta el intento para no esperar 750 ms a la primera swing.
 */
@Injectable()
export class MobCombatTickService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly playerCombatRuntime: PlayerCombatRuntimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, 50);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) {
      return;
    }
    this.tickInFlight = true;
    try {
      const mobs = await this.prisma.mobInstance.findMany({
        where: {
          isAlive: true,
          aggroTargetCharacterId: { not: null },
        },
        select: { id: true, aggroTargetCharacterId: true },
      });

      for (const m of mobs) {
        const target = m.aggroTargetCharacterId;
        if (!target) {
          continue;
        }
        try {
          await this.playerCombatRuntime.tryMobMeleeHit(m.id, target);
        } catch {
          /* rango, cooldown, carrera: siguiente tick */
        }
      }
    } catch {
      /* P2024 u otra falla de pool: no tumbar el proceso */
    } finally {
      this.tickInFlight = false;
    }
  }
}
