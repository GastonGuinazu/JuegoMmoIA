import { Injectable, OnDestroy, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { io, type Socket } from 'socket.io-client';
import {
  WS_WORLD_EVENTS,
  WS_WORLD_NAMESPACE,
  type WsAttackMobClientPayload,
  type WsAttackPlayerClientPayload,
  type WsAttackMobDeniedPayload,
  type WsAttackMobResultPayload,
  type WsAttackPlayerResultPayload,
  type WsAttackMobRewardsPayload,
  type WsMobDeathPayload,
  type WsBuyItemClientPayload,
  type WsCastSkillClientPayload,
  type WsCombatTargetClientPayload,
  type WsCombatTargetResultPayload,
  type WsDistributeStatAckPayload,
  type WsDistributeStatClientPayload,
  type WsEquipItemAckPayload,
  type WsGradePenaltyStatusPayload,
  type WsEquipItemClientPayload,
  type WsGetMobDropPreviewAckPayload,
  type WsGetMobDropPreviewClientPayload,
  type WsMobMovedPayload,
  type WsMobMeleeResultPayload,
  type WsMobRespawnPayload,
  type WsNpcInteractAckPayload,
  type WsNpcInteractClientPayload,
  type WsOpenMerchantStoreClientPayload,
  type WsPickItemAckPayload,
  type WsPickItemClientPayload,
  type WsPlayerMoveClientPayload,
  type WsPlayerMovedPayload,
  type WsPlayerPositionCorrectedPayload,
  type WsPlayerVisualStatePayload,
  type WsPlayerStatsUpdatePayload,
  type WsRequestSynthesisAckPayload,
  type WsRequestSynthesisClientPayload,
  type WsSynthesisQuoteAckPayload,
  type WsPlayerVitalsPayload,
  type WsSellItemClientPayload,
  type WsShopTxnAckPayload,
  type WsUnequipItemAckPayload,
  type WsUnequipItemClientPayload,
  type WsUseItemAckPayload,
  type WsUseItemClientPayload,
  type WsPlayerConsumableHealPayload,
  type WsSkillHitResultPayload,
  type WsWorldDropRemovedPayload,
  type WsWorldDropSpawnPayload,
  type WsZoneSnapshotPayload,
  type WsLevelUpPayload,
  type WsPortalTravelClientPayload,
  type WsPortalTravelDeniedPayload,
  type WsPlayerLeftZonePayload,
  type WsPlayerDeathPayload,
  type WsPlayerRespawnPayload,
  type WsRequestRespawnAckPayload,
  type WsExecuteGmCommandAckPayload,
  type WsExecuteGmCommandClientPayload,
} from '../../../../../libs/shared-types/src/world-socket';

@Injectable({ providedIn: 'root' })
export class WorldSocketService implements OnDestroy {
  readonly socketConnected = signal(false);

  readonly zoneSnapshot$ = new Subject<WsZoneSnapshotPayload>();
  readonly attackMobResult$ = new Subject<WsAttackMobResultPayload>();
  readonly attackPlayerResult$ = new Subject<WsAttackPlayerResultPayload>();
  readonly mobDeath$ = new Subject<WsMobDeathPayload>();
  readonly mobRespawn$ = new Subject<WsMobRespawnPayload>();
  readonly mobMoved$ = new Subject<WsMobMovedPayload>();
  readonly mobMeleeResult$ = new Subject<WsMobMeleeResultPayload>();
  readonly attackDenied$ = new Subject<WsAttackMobDeniedPayload>();
  readonly playerMoved$ = new Subject<WsPlayerMovedPayload>();
  readonly playerPositionCorrected$ =
    new Subject<WsPlayerPositionCorrectedPayload>();
  readonly playerVisualState$ = new Subject<WsPlayerVisualStatePayload>();
  readonly playerVitals$ = new Subject<WsPlayerVitalsPayload>();
  readonly playerStatsUpdate$ = new Subject<WsPlayerStatsUpdatePayload>();
  readonly gradePenaltyStatus$ = new Subject<WsGradePenaltyStatusPayload>();
  readonly attackMobRewards$ = new Subject<WsAttackMobRewardsPayload>();
  readonly skillHitResult$ = new Subject<WsSkillHitResultPayload>();
  readonly levelUp$ = new Subject<WsLevelUpPayload>();
  readonly combatTargetResult$ = new Subject<WsCombatTargetResultPayload>();
  readonly worldDropSpawn$ = new Subject<WsWorldDropSpawnPayload>();
  readonly worldDropRemoved$ = new Subject<WsWorldDropRemovedPayload>();
  readonly playerConsumableHeal$ = new Subject<WsPlayerConsumableHealPayload>();
  readonly portalTravelDenied$ = new Subject<WsPortalTravelDeniedPayload>();
  readonly playerLeftZone$ = new Subject<WsPlayerLeftZonePayload>();
  readonly playerDeath$ = new Subject<WsPlayerDeathPayload>();
  readonly playerRespawn$ = new Subject<WsPlayerRespawnPayload>();

  private socket: Socket | null = null;

  /**
   * `zoneId` no existe: el servidor es la única fuente de verdad de la ubicación
   * (`Character.currentZoneId`) y la entrega en `zone-snapshot`. Mandarla desde el
   * cliente sería una superficie de exploit (falsificar la zona de entrada).
   */
  connect(baseUrl: string, characterId: string): void {
    this.disconnect();
    const url = `${baseUrl.replace(/\/$/, '')}${WS_WORLD_NAMESPACE}`;
    this.socket = io(url, {
      auth: {
        characterId,
      },
      transports: ['websocket', 'polling'],
    });

    this.socket.on(WS_WORLD_EVENTS.ZONE_SNAPSHOT, (p: WsZoneSnapshotPayload) => {
      this.zoneSnapshot$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.ATTACK_MOB_RESULT, (p: WsAttackMobResultPayload) => {
      this.attackMobResult$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.ATTACK_PLAYER_RESULT, (p: WsAttackPlayerResultPayload) => {
      this.attackPlayerResult$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.MOB_DEATH, (p: WsMobDeathPayload) => {
      this.mobDeath$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.MOB_RESPAWN, (p: WsMobRespawnPayload) => {
      this.mobRespawn$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.MOB_MOVED, (p: WsMobMovedPayload) => {
      this.mobMoved$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.MOB_MELEE_RESULT, (p: WsMobMeleeResultPayload) => {
      this.mobMeleeResult$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.ATTACK_MOB_DENIED, (p: WsAttackMobDeniedPayload) => {
      this.attackDenied$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PLAYER_MOVED, (p: WsPlayerMovedPayload) => {
      this.playerMoved$.next(p);
    });
    this.socket.on(
      WS_WORLD_EVENTS.PLAYER_POSITION_CORRECTED,
      (p: WsPlayerPositionCorrectedPayload) => {
        this.playerPositionCorrected$.next(p);
      },
    );
    this.socket.on(WS_WORLD_EVENTS.PLAYER_VISUAL_STATE, (p: WsPlayerVisualStatePayload) => {
      this.playerVisualState$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PLAYER_VITALS, (p: WsPlayerVitalsPayload) => {
      this.playerVitals$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PLAYER_STATS_UPDATE, (p: WsPlayerStatsUpdatePayload) => {
      this.playerStatsUpdate$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.GRADE_PENALTY_STATUS, (p: WsGradePenaltyStatusPayload) => {
      this.gradePenaltyStatus$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.ATTACK_MOB_REWARDS, (p: WsAttackMobRewardsPayload) => {
      this.attackMobRewards$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.SKILL_HIT_RESULT, (p: WsSkillHitResultPayload) => {
      this.skillHitResult$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.LEVEL_UP, (p: WsLevelUpPayload) => {
      this.levelUp$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.COMBAT_TARGET_RESULT, (p: WsCombatTargetResultPayload) => {
      this.combatTargetResult$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.WORLD_DROP_SPAWN, (p: WsWorldDropSpawnPayload) => {
      this.worldDropSpawn$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.WORLD_DROP_REMOVED, (p: WsWorldDropRemovedPayload) => {
      this.worldDropRemoved$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PLAYER_CONSUMABLE_HEAL, (p: WsPlayerConsumableHealPayload) => {
      this.playerConsumableHeal$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PORTAL_TRAVEL_DENIED, (p: WsPortalTravelDeniedPayload) => {
      this.portalTravelDenied$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PLAYER_LEFT_ZONE, (p: WsPlayerLeftZonePayload) => {
      this.playerLeftZone$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PLAYER_DEATH, (p: WsPlayerDeathPayload) => {
      this.playerDeath$.next(p);
    });
    this.socket.on(WS_WORLD_EVENTS.PLAYER_RESPAWN, (p: WsPlayerRespawnPayload) => {
      this.playerRespawn$.next(p);
    });

    this.socketConnected.set(this.socket.connected);
    this.socket.on('connect', () => this.socketConnected.set(true));
    this.socket.on('disconnect', () => this.socketConnected.set(false));
  }

  attackMob(payload: WsAttackMobClientPayload): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(WS_WORLD_EVENTS.ATTACK_MOB, payload);
  }

  attackPlayer(payload: WsAttackPlayerClientPayload): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(WS_WORLD_EVENTS.ATTACK_PLAYER, payload);
  }

  castSkill(payload: WsCastSkillClientPayload): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(WS_WORLD_EVENTS.CAST_SKILL, payload);
  }

  emitCombatTarget(payload: WsCombatTargetClientPayload): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(WS_WORLD_EVENTS.COMBAT_TARGET, payload);
  }

  emitPlayerMove(payload: WsPlayerMoveClientPayload): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(WS_WORLD_EVENTS.PLAYER_MOVE, payload);
  }

  emitPortalTravel(payload: WsPortalTravelClientPayload): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(WS_WORLD_EVENTS.PORTAL_TRAVEL, payload);
  }

  /**
   * Intención de resucitar. El Warden decide zona y coordenadas; el ack sólo confirma.
   */
  emitRequestRespawn(cb: (result: WsRequestRespawnAckPayload) => void): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.REQUEST_RESPAWN, {}, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: 'El servidor no respondió al pedido de respawn',
          });
          return;
        }
        cb(res as WsRequestRespawnAckPayload);
      });
  }

  /**
   * Equipar vía Warden (ack). Misma autoridad que POST /inventory/equip.
   */
  emitEquipItemWithAck(
    payload: WsEquipItemClientPayload,
    cb: (result: WsEquipItemAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.EQUIP_ITEM, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Equip request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsEquipItemAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected equip response from server',
        });
      });
  }

  emitPickItemWithAck(
    payload: WsPickItemClientPayload,
    cb: (result: WsPickItemAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.PICK_ITEM, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Pick request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsPickItemAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected pick response from server',
        });
      });
  }

  emitGetMobDropPreviewWithAck(
    payload: WsGetMobDropPreviewClientPayload,
    cb: (result: WsGetMobDropPreviewAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket.timeout(12_000).emit(
      WS_WORLD_EVENTS.GET_MOB_DROP_PREVIEW,
      payload,
      (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Drop preview request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsGetMobDropPreviewAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected drop-preview response from server',
        });
      },
    );
  }

  emitOpenMerchantStoreWithAck(
    payload: WsOpenMerchantStoreClientPayload,
    cb: (result: WsNpcInteractAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.OPEN_MERCHANT_STORE, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Open merchant store timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsNpcInteractAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected open-merchant-store response from server',
        });
      });
  }

  emitNpcInteractWithAck(
    payload: WsNpcInteractClientPayload,
    cb: (result: WsNpcInteractAckPayload) => void,
  ): void {
    this.emitOpenMerchantStoreWithAck(payload, cb);
  }

  emitBuyItemWithAck(
    payload: WsBuyItemClientPayload,
    cb: (result: WsShopTxnAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.BUY_ITEM, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Buy request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsShopTxnAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected buy response from server',
        });
      });
  }

  emitSellItemWithAck(
    payload: WsSellItemClientPayload,
    cb: (result: WsShopTxnAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.SELL_ITEM, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Sell request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsShopTxnAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected sell response from server',
        });
      });
  }

  /** Aviso al Warden de que la UI de tienda se cerró (sin ack). */
  emitNpcCloseInteract(): void {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(WS_WORLD_EVENTS.NPC_CLOSE_INTERACT, {});
  }

  emitUseItemWithAck(
    payload: WsUseItemClientPayload,
    cb: (result: WsUseItemAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.USE_ITEM, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Use item request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsUseItemAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected use-item response from server',
        });
      });
  }

  emitUnequipItemWithAck(
    payload: WsUnequipItemClientPayload,
    cb: (result: WsUnequipItemAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.UNEQUIP_ITEM, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Unequip request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsUnequipItemAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected unequip response from server',
        });
      });
  }

  emitExecuteGmCommandWithAck(
    payload: WsExecuteGmCommandClientPayload,
    cb: (result: WsExecuteGmCommandAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.EXECUTE_GM_COMMAND, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'GM command request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsExecuteGmCommandAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected GM command response from server',
        });
      });
  }

  emitDistributeStatWithAck(
    payload: WsDistributeStatClientPayload,
    cb: (result: WsDistributeStatAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.DISTRIBUTE_STAT, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Stat distribution request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsDistributeStatAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected distribute-stat response from server',
        });
      });
  }

  emitSynthesisQuoteWithAck(
    payload: WsRequestSynthesisClientPayload,
    cb: (result: WsSynthesisQuoteAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket.timeout(12_000).emit(
      WS_WORLD_EVENTS.REQUEST_SYNTHESIS_QUOTE,
      payload,
      (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Synthesis quote request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsSynthesisQuoteAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected synthesis quote response from server',
        });
      },
    );
  }

  emitRequestSynthesisWithAck(
    payload: WsRequestSynthesisClientPayload,
    cb: (result: WsRequestSynthesisAckPayload) => void,
  ): void {
    if (!this.socket?.connected) {
      cb({ ok: false, code: 'NO_SOCKET', message: 'World socket is not connected' });
      return;
    }
    this.socket
      .timeout(12_000)
      .emit(WS_WORLD_EVENTS.REQUEST_SYNTHESIS, payload, (err: Error | null, res: unknown) => {
        if (err) {
          cb({
            ok: false,
            code: 'SOCKET_TIMEOUT',
            message: err.message || 'Synthesis request timed out',
          });
          return;
        }
        if (res && typeof res === 'object' && 'ok' in res) {
          cb(res as WsRequestSynthesisAckPayload);
          return;
        }
        cb({
          ok: false,
          code: 'INVALID_ACK',
          message: 'Unexpected synthesis response from server',
        });
      });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.socketConnected.set(false);
  }

  ngOnDestroy(): void {
    this.disconnect();
  }
}
