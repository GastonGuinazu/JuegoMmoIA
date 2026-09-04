import { Injectable } from '@nestjs/common';

/**
 * Reserva RAM de drops antes del commit Prisma: `pickWorldDrop` puede esperar brevemente
 * a que exista la fila `item_instance` si el jugador intenta recoger en el mismo instante.
 */
@Injectable()
export class PendingWorldDropService {
  private readonly pending = new Set<string>();

  registerSpawns(itemInstanceIds: string[]): void {
    for (const id of itemInstanceIds) {
      this.pending.add(id);
    }
  }

  isPending(itemInstanceId: string): boolean {
    return this.pending.has(itemInstanceId);
  }

  clearSpawns(itemInstanceIds: string[]): void {
    for (const id of itemInstanceIds) {
      this.pending.delete(id);
    }
  }
}
