import { Injectable, computed, signal } from '@angular/core';
import type { WsNpcInteractAckPayload } from '../../../../../libs/shared-types/src/world-socket';

export type NpcShopOpenState = Extract<WsNpcInteractAckPayload, { ok: true }>;

@Injectable({ providedIn: 'root' })
export class NpcShopUiService {
  /** Estado de la ventana de tienda (solo UI; precios autoritativos vienen del ack de interacción). */
  readonly shop = signal<NpcShopOpenState | null>(null);

  /** Alias reactivo para plantillas (`isOpen()`). */
  readonly isOpen = computed(() => this.shop() !== null);

  private readonly lootFloaterText = signal<string | null>(null);
  /** Pulso para que el Weaver dispare texto flotante (mismo texto repetible). */
  readonly lootFloaterTick = signal(0);

  open(payload: NpcShopOpenState): void {
    this.shop.set(payload);
  }

  close(): void {
    this.shop.set(null);
  }

  /** Texto pendiente para `spawnLootFloater` (consume en el viewport). */
  peekLootFloater(): string | null {
    return this.lootFloaterText();
  }

  clearLootFloater(): void {
    this.lootFloaterText.set(null);
  }

  requestLootFloater(label: string): void {
    this.lootFloaterText.set(label);
    this.lootFloaterTick.update((n) => n + 1);
  }
}
