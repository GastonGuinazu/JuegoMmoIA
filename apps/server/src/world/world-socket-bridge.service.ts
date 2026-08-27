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
}
