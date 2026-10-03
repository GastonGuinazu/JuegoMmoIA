import { Injectable } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { normalizeZoneId } from './world-zone.util';

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
