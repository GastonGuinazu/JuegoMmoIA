import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WorldPresenceService } from '../world/world-presence.service';
import { PlayerCombatRuntimeService } from './player-combat-runtime.service';

/**
 * Tick servidor: auto-ataque PvE estilo L2 para personajes con objetivo activo y en rango.
 */
@Injectable()
export class PlayerCombatTickService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlayerCombatTickService.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private tickInFlight = false;

  constructor(
    private readonly presence: WorldPresenceService,
    private readonly runtime: PlayerCombatRuntimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, 150);
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
      const ids = this.presence.snapshot();
      for (const characterId of ids) {
        await this.runtime.syncProgressionDrivenCombatState(characterId);
        this.runtime.tickManaRegenForCharacter(characterId);
        if (!this.presence.getActiveMobTarget(characterId)) {
          continue;
        }
        const isTargetInRange =
          await this.runtime.validateAutoAttackRangeForCharacter(characterId);
        if (!isTargetInRange) {
          continue;
        }
        void this.runtime.tryAutoSwingForCharacter(characterId).catch((e) => {
          this.logger.warn(
            `[PlayerCombatTick] ${characterId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
