import { CommonModule } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { InventoryItemRowDto } from '../../../../../../libs/shared-types/src/inventory-api';
import type { WsNpcShopOfferDto } from '../../../../../../libs/shared-types/src/world-socket';
import { NpcShopUiService } from '../../core/npc-shop-ui.service';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';
import { WorldSocketService } from '../../core/world-socket.service';

function mapShopError(code: string, message: string): string {
  switch (code) {
    case 'INSUFFICIENT_ADENA':
      return 'No tenés suficiente Adena.';
    case 'TOO_FAR':
      return 'Estás demasiado lejos del mercader.';
    case 'INVENTORY_STACK_CAP':
      return 'No hay espacio en el stack de ese ítem.';
    case 'NOT_IN_STOCK':
      return 'Ese ítem no está en el catálogo del mercader.';
    case 'INVALID_QUANTITY':
      return 'Cantidad inválida.';
    case 'ZONE_MISMATCH':
      return 'El mercader no está en tu zona.';
    case 'NO_SOCKET':
      return 'No hay conexión con el mundo.';
    case 'SOCKET_TIMEOUT':
      return 'La petición tardó demasiado; probá de nuevo.';
    default:
      return message || code;
  }
}

@Component({
  selector: 'app-npc-shop-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './npc-shop-panel.component.html',
  styleUrl: './npc-shop-panel.component.scss',
})
export class NpcShopPanelComponent {
  readonly ui = inject(NpcShopUiService);
  readonly player = inject(PlayerCharacterStateService);
  readonly worldSocket = inject(WorldSocketService);

  readonly buyQtyByCatalog = signal<Record<string, number>>({});
  readonly sellQtyByItem = signal<Record<string, number>>({});
  readonly busy = signal(false);
  readonly shopToast = signal<string | null>(null);

  private toastClearId: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      if (this.ui.shop() !== null) {
        return;
      }
      this.buyQtyByCatalog.set({});
      this.sellQtyByItem.set({});
      this.clearToast();
    });
  }

  /** Cierre explícito: avisa al servidor y limpia UI. */
  close(): void {
    this.worldSocket.emitNpcCloseInteract();
    this.ui.close();
    this.clearToast();
  }

  onBackdropClick(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) {
      this.close();
    }
  }

  getBuyQty(catalogKey: string): number {
    const q = this.buyQtyByCatalog()[catalogKey];
    return typeof q === 'number' && q >= 1 ? q : 1;
  }

  setBuyQty(catalogKey: string, value: number): void {
    const n = Math.floor(Number(value));
    const v = !Number.isFinite(n) || n < 1 ? 1 : Math.min(999, n);
    this.buyQtyByCatalog.update((m) => ({ ...m, [catalogKey]: v }));
  }

  getSellQty(itemId: string): number {
    const q = this.sellQtyByItem()[itemId];
    return typeof q === 'number' && q >= 1 ? q : 1;
  }

  setSellQty(itemId: string, value: number, max: number): void {
    const n = Math.floor(Number(value));
    const v = !Number.isFinite(n) || n < 1 ? 1 : Math.min(max, Math.min(999, n));
    this.sellQtyByItem.update((m) => ({ ...m, [itemId]: v }));
  }

  sellableBagItemsForShop(shop: { offers: { catalogKey: string }[] }): InventoryItemRowDto[] {
    const keys = new Set(shop.offers.map((o) => o.catalogKey));
    return this.player
      .inventoryItems()
      .filter((i) => i.location === 'INVENTORY' && i.catalogKey && keys.has(i.catalogKey));
  }

  canAffordOffer(offer: WsNpcShopOfferDto): boolean {
    const adenaStr = this.player.adena();
    if (adenaStr == null || adenaStr === '') {
      return false;
    }
    try {
      const have = BigInt(adenaStr);
      const unit = BigInt(offer.buyPriceAdena);
      const qty = BigInt(this.getBuyQty(offer.catalogKey));
      return have >= unit * qty;
    } catch {
      return false;
    }
  }

  buyDisabled(offer: WsNpcShopOfferDto): boolean {
    return this.busy() || !this.canAffordOffer(offer);
  }

  /**
   * Compra autoritativa: `emitBuyItemWithAck` + feedback en log / toast si falla.
   */
  onBuyItem(offer: WsNpcShopOfferDto): void {
    const shop = this.ui.shop();
    if (!shop || !this.worldSocket.socketConnected() || this.busy()) {
      return;
    }
    if (!this.canAffordOffer(offer)) {
      const msg = 'No tenés suficiente Adena para esta compra.';
      this.showToast(msg);
      this.player.pushSystemLogLine(`[Tienda] ${msg}`);
      return;
    }
    const qty = this.getBuyQty(offer.catalogKey);
    this.busy.set(true);
    this.worldSocket.emitBuyItemWithAck(
      {
        npcInstanceId: shop.npcInstanceId,
        catalogKey: offer.catalogKey,
        quantity: qty,
      },
      (r) => {
        this.busy.set(false);
        if (!r.ok) {
          const friendly = mapShopError(r.code, r.message);
          this.showToast(friendly);
          this.player.pushSystemLogLine(`[Tienda] ${friendly}`);
          return;
        }
        this.player.mergeFromShopAck(r);
        const total = (BigInt(offer.buyPriceAdena) * BigInt(qty)).toString();
        this.player.pushSystemLogLine(
          `[Tienda] Compraste ${offer.itemDisplayName} x${qty} por ${total} adena.`,
        );
        this.playCoinClink();
        this.ui.requestLootFloater(`+${offer.itemDisplayName}${qty > 1 ? ` x${qty}` : ''}`);
      },
    );
  }

  onSellItem(item: InventoryItemRowDto): void {
    const shop = this.ui.shop();
    if (!shop || !this.worldSocket.socketConnected() || this.busy()) {
      return;
    }
    const qty = Math.min(item.quantity, this.getSellQty(item.id));
    this.busy.set(true);
    this.worldSocket.emitSellItemWithAck(
      {
        npcInstanceId: shop.npcInstanceId,
        itemInstanceId: item.id,
        quantity: qty,
      },
      (r) => {
        this.busy.set(false);
        if (!r.ok) {
          const friendly = mapShopError(r.code, r.message);
          this.showToast(friendly);
          this.player.pushSystemLogLine(`[Tienda] ${friendly}`);
          return;
        }
        this.player.mergeFromShopAck(r);
        this.player.pushSystemLogLine(`[Tienda] Vendiste ${item.name} x${qty}.`);
      },
    );
  }

  private showToast(msg: string): void {
    if (this.toastClearId !== undefined) {
      clearTimeout(this.toastClearId);
    }
    this.shopToast.set(msg);
    this.toastClearId = setTimeout(() => {
      this.shopToast.set(null);
      this.toastClearId = undefined;
    }, 3400);
  }

  private clearToast(): void {
    if (this.toastClearId !== undefined) {
      clearTimeout(this.toastClearId);
      this.toastClearId = undefined;
    }
    this.shopToast.set(null);
  }

  /** Sonido breve opcional al comprar (sin assets externos). */
  private playCoinClink(): void {
    try {
      const ACtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!ACtx) {
        return;
      }
      const ctx = new ACtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 920;
      gain.gain.value = 0.035;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.07);
      osc.onended = () => {
        void ctx.close();
      };
    } catch {
      /* noop */
    }
  }
}
