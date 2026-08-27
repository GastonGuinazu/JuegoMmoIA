import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { loadCharacterVitalsConfig } from './config/config-loaders';
import { CharacterService } from './character.service';
import {
  WS_WORLD_EVENTS,
  type WsPlayerVitalsPayload,
} from '@aetheris/shared-types';
import { MobCombatRegenService } from '../mob/mob-combat-regen.service';
import { WorldSocketBridgeService } from '../world/world-socket-bridge.service';
import { WorldPresenceService } from '../world/world-presence.service';

/**
 * Regen pasiva de **personajes** (`Character`). Los `MobInstance` no pasan por aquí: cualquier
 * curación futura de mobs en este servicio debe abortarse si `aggroTargetCharacterId != null` o
 * si `MobCombatRegenService.isCombatActivityHot` / `isHardCombatLocked` (The Warden).
 */
@Injectable()
export class HealthRegenService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthRegenService.name);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly presence: WorldPresenceService,
    private readonly characters: CharacterService,
    private readonly bridge: WorldSocketBridgeService,
    private readonly mobCombatRegen: MobCombatRegenService,
  ) {}

  onModuleInit(): void {
    const ms = loadCharacterVitalsConfig().regenIntervalMs ?? 5000;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    this.logger.log(`Out-of-combat regen tick every ${ms}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick(): Promise<void> {
    for (const characterId of this.presence.snapshot()) {
      if (this.presence.isCharacterHpDirty(characterId)) {
        continue;
      }
      try {
        const v = await this.characters.applyOutOfCombatRegenTick(characterId);
        if (v) {
          const payload: WsPlayerVitalsPayload = {
            characterId,
            currentHp: v.currentHp,
            maxHp: v.maxHp,
          };
          this.bridge.emitToCharacter(
            characterId,
            WS_WORLD_EVENTS.PLAYER_VITALS,
            payload,
          );
        }
      } catch {
        /* personaje borrado / carrera: ignorar tick */
      }
    }
    void this.mobCombatRegen;
  }
}
