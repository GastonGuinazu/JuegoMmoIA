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
        // Por personaje: un error transitorio (ej. corte de DB) no debe cortar el tick de
        // los demás. Antes esto no estaba, así que una promesa rechazada acá escapaba de
        // `tick()` y, al llamarse con `void this.tick()` desde `setInterval`, tumbaba el
        // proceso entero (rejection sin manejar) — un simple hipo de red bajaba el server.
        try {
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
        } catch (e) {
          this.logger.warn(
            `[PlayerCombatTick] ${characterId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      // Red de seguridad: nada debería llegar hasta acá (lo de arriba ya atrapa por
      // personaje), pero si pasa, mejor loguearlo que tumbar el proceso.
      this.logger.error(
        `[PlayerCombatTick] Tick falló: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.tickInFlight = false;
    }
  }
}
