import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WS_WORLD_EVENTS } from '@aetheris/shared-types';
import { PlayerCombatRuntimeService } from '../combat/player-combat-runtime.service';
import { WorldPresenceService } from '../world/world-presence.service';
import { WorldSocketBridgeService } from '../world/world-socket-bridge.service';
import { PartyService } from './party.service';

/**
 * Único costo "por tick" de Party: 1 Hz, muy por debajo del tick de combate (150ms)
 * o de IA (50ms), y acotado al Nº de grupos activos (siempre chico). No toca ninguna
 * ruta de combate/recompensas; solo lee vitals que ya están en RAM (`getRuntimeVitals`)
 * y los empuja a la sala `party:*` de cada grupo para refrescar las barras de HP/MP
 * de los aliados en el panel. Si un grupo nunca se formó, este tick no hace nada.
 */
const PARTY_VITALS_TICK_MS = 1000;

@Injectable()
export class PartyVitalsTickService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly party: PartyService,
    private readonly presence: WorldPresenceService,
    private readonly playerCombatRuntime: PlayerCombatRuntimeService,
    private readonly bridge: WorldSocketBridgeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => this.tick(), PARTY_VITALS_TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private tick(): void {
    this.party.sweepExpiredInvites(Date.now());
    const partyIds = this.party.allPartyIds();
    for (const partyId of partyIds) {
      const payload = this.party.buildUpdatePayload(partyId, (characterId) => {
        const online = this.presence.isConnected(characterId);
        const vitals = online ? this.playerCombatRuntime.getRuntimeVitals(characterId) : null;
        return {
          online,
          currentHp: vitals?.currentHp ?? 0,
          maxHp: vitals?.maxHp ?? 0,
          currentMp: vitals?.currentMp ?? 0,
          maxMp: vitals?.maxMp ?? 0,
        };
      });
      if (!payload) {
        continue;
      }
      this.bridge.broadcastToRoom(this.bridge.partyRoomId(partyId), WS_WORLD_EVENTS.PARTY_UPDATE, payload);
    }
  }
}
