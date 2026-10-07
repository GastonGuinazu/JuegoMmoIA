import { Injectable } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { normalizeZoneId } from './world-zone.util';
import {
  WS_WORLD_EVENTS,
  type WsPlayerTargetVitalsPayload,
  type WsPlayerVitalsPayload,
} from '@aetheris/shared-types';

@Injectable()
export class WorldSocketBridgeService {
  private server: Namespace | null = null;

  setServer(server: Namespace): void {
    this.server = server;
  }

  zoneRoomId(zoneId: string | null | undefined): string {
    return `zone:${normalizeZoneId(zoneId)}`;
  }

  /** Sala por grupo (Party): separada de `zone:*` porque los miembros pueden estar en zonas distintas. */
  partyRoomId(partyId: string): string {
    return `party:${partyId}`;
  }

  broadcastToZone(
    zoneId: string | null | undefined,
    event: string,
    payload: unknown,
  ): void {
    if (!this.server) {
      return;
    }
    void this.server.to(this.zoneRoomId(zoneId)).emit(event, payload);
  }

  broadcastToRoom(room: string, event: string, payload: unknown): void {
    if (!this.server) {
      return;
    }
    void this.server.to(room).emit(event, payload);
  }

  /** A todo el namespace `/world` sin filtrar por sala (chat global). */
  broadcastToAll(event: string, payload: unknown): void {
    if (!this.server) {
      return;
    }
    void this.server.emit(event, payload);
  }

  /** Emite solo a los sockets del namespace `/world` ligados a `characterId`. */
  emitToCharacter(
    characterId: string,
    event: string,
    payload: unknown,
  ): void {
    if (!this.server) {
      return;
    }
    for (const socket of this.server.sockets.values()) {
      if (socket.data?.characterId === characterId) {
        socket.emit(event, payload);
      }
    }
  }

  /**
   * Único punto por el que debería salir `PLAYER_VITALS`: además de la entrega privada de
   * siempre (al dueño del personaje), difunde una versión pública y recortada (sin `currentMp`
   * /`maxMp`) a la sala de zona del personaje como `PLAYER_TARGET_VITALS` — así la barra de
   * vida de la tarjeta de target se mantiene al día para cualquiera que lo tenga seleccionado,
   * sin importar la causa del cambio (golpe, regen, poción). `zoneId` es opcional: si el
   * caller ya lo tiene a mano (p. ej. `combat.service.ts` ya resolvió `outcome.zoneId`) evita
   * el barrido de sockets para resolverlo.
   */
  emitPlayerVitals(payload: WsPlayerVitalsPayload, zoneId?: string | null): void {
    this.emitToCharacter(payload.characterId, WS_WORLD_EVENTS.PLAYER_VITALS, payload);
    const resolvedZoneId = zoneId ?? this.findCharacterZoneId(payload.characterId);
    if (!resolvedZoneId) {
      return;
    }
    this.broadcastToZone(resolvedZoneId, WS_WORLD_EVENTS.PLAYER_TARGET_VITALS, {
      characterId: payload.characterId,
      currentHp: payload.currentHp,
      maxHp: payload.maxHp,
    } satisfies WsPlayerTargetVitalsPayload);
  }

  private findCharacterZoneId(characterId: string): string | null {
    if (!this.server) {
      return null;
    }
    for (const socket of this.server.sockets.values()) {
      if (socket.data?.characterId === characterId) {
        return (socket.data?.zoneId as string | undefined) ?? null;
      }
    }
    return null;
  }

  /**
   * Suma/saca del socket de `characterId` una sala arbitraria (ej. `party:*`).
   * Igual que `emitToCharacter`: barrido O(sockets conectados), aceptable porque
   * solo se llama en acciones puntuales de grupo (invitar/aceptar/salir), nunca
   * por tick.
   */
  joinCharacterToRoom(characterId: string, room: string): void {
    if (!this.server) {
      return;
    }
    for (const socket of this.server.sockets.values()) {
      if (socket.data?.characterId === characterId) {
        void socket.join(room);
      }
    }
  }

  leaveCharacterFromRoom(characterId: string, room: string): void {
    if (!this.server) {
      return;
    }
    for (const socket of this.server.sockets.values()) {
      if (socket.data?.characterId === characterId) {
        void socket.leave(room);
      }
    }
  }
}
