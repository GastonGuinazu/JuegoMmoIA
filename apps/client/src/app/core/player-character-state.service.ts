import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DestroyRef } from '@angular/core';
import type { CharacterSheetDto, InventoryItemRowDto } from '../../../../../libs/shared-types/src/inventory-api';
import type {
  WsLevelUpPayload,
  WsAttackMobRewardsPayload,
  WsPickItemAckPayload,
  WsRequestSynthesisAckPayload,
  WsSynthesisQuoteAckPayload,
  WsPlayerStatsUpdatePayload,
  WsShopTxnAckPayload,
  WsUseItemAckPayload,
  WsZoneSnapshotPayload,
} from '../../../../../libs/shared-types/src/world-socket';
import { InventoryApiService } from './inventory-api.service';
import { WorldSocketService } from './world-socket.service';

@Injectable({ providedIn: 'root' })
export class PlayerCharacterStateService {
  private readonly api = inject(InventoryApiService);
  private readonly worldSocket = inject(WorldSocketService);
  private readonly destroyRef = inject(DestroyRef);

  /** Ficha + inventario desde HTTP. */
  readonly characterSheet = signal<CharacterSheetDto | null>(null);
  readonly inventoryItems = signal<InventoryItemRowDto[]>([]);
  /** Adena (wallet de cuenta), string decimal desde el Ledger. */
  readonly adena = signal<string | null>(null);

  /** Líneas de registro del sistema (pickup, etc.). */
  readonly systemLogLines = signal<{ id: string; text: string }[]>([]);

  /** HP sincronizado con snapshot de zona y `player-vitals` del Warden. */
  readonly vitals = signal<{ currentHp: number; maxHp: number } | null>(null);

  /** Progresión de nivel (autoritativa: HTTP + `attack-mob-rewards` + `level-up`). */
  readonly xpProgress = signal<{
    level: number;
    experience: number;
    experienceRequiredForNext: number;
  } | null>(null);

  /** Banner breve tras `LEVEL_UP` del Warden. */
  readonly levelUpOverlay = signal(false);

  readonly loadError = signal<string | null>(null);
  readonly equipBusy = signal(false);
  readonly equipError = signal<string | null>(null);
  readonly distributeBusy = signal(false);
  readonly distributeError = signal<string | null>(null);
  readonly useItemBusy = signal(false);
  readonly useItemError = signal<string | null>(null);
  readonly synthesisBusy = signal(false);
  readonly synthesisError = signal<string | null>(null);
  readonly synthesisQuote = signal<Extract<WsSynthesisQuoteAckPayload, { ok: true }> | null>(
    null,
  );
  readonly synthesisOutcome = signal<{
    success: boolean;
    forcedByPity: boolean;
    newItemLevel: number;
    pityCount: number;
  } | null>(null);

  /** UUID del personaje conectado al mundo (para filtrar `player-vitals`). */
  private readonly sessionCharacterId = signal<string | null>(null);

  readonly hpPercent = computed(() => {
    const v = this.vitals();
    if (!v || v.maxHp <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (100 * v.currentHp) / v.maxHp));
  });

  /** Solo UI: viene del HTTP `CharacterSheetDto`; el Warden valida `isAdmin` en cada comando GM. */
  readonly isSessionAdmin = computed(() => this.characterSheet()?.isAdmin === true);

  readonly xpBarPercent = computed(() => {
    const x = this.xpProgress();
    if (!x) {
      return 0;
    }
    if (x.experienceRequiredForNext <= 0) {
      return 100;
    }
    return Math.min(
      100,
      Math.max(0, (100 * x.experience) / x.experienceRequiredForNext),
    );
  });

  constructor() {
    this.worldSocket.zoneSnapshot$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((z) => {
      this.applyZoneSelfVitals(z);
    });
    this.worldSocket.playerVitals$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((p) => {
      if (p.characterId !== this.sessionCharacterId()) {
        return;
      }
      this.applyPlayerVitals(p);
    });
    this.worldSocket.playerStatsUpdate$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => this.applyPlayerStatsUpdate(payload));
    this.worldSocket.attackMobRewards$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => this.applyAttackMobRewards(r));
    this.worldSocket.levelUp$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((p) => this.applyLevelUpSocket(p));
  }

  setSessionCharacter(characterId: string | null): void {
    this.sessionCharacterId.set(characterId);
    if (!characterId) {
      this.reset();
      return;
    }
    this.characterSheet.set(null);
    this.inventoryItems.set([]);
    this.adena.set(null);
    this.systemLogLines.set([]);
    this.vitals.set(null);
    this.xpProgress.set(null);
    this.levelUpOverlay.set(false);
    this.loadError.set(null);
    this.equipError.set(null);
    this.distributeBusy.set(false);
    this.distributeError.set(null);
    this.useItemBusy.set(false);
    this.useItemError.set(null);
    this.synthesisBusy.set(false);
    this.synthesisError.set(null);
    this.synthesisQuote.set(null);
    this.synthesisOutcome.set(null);
  }

  reset(): void {
    this.characterSheet.set(null);
    this.inventoryItems.set([]);
    this.adena.set(null);
    this.systemLogLines.set([]);
    this.vitals.set(null);
    this.xpProgress.set(null);
    this.levelUpOverlay.set(false);
    this.loadError.set(null);
    this.equipError.set(null);
    this.distributeBusy.set(false);
    this.distributeError.set(null);
    this.useItemBusy.set(false);
    this.useItemError.set(null);
    this.synthesisBusy.set(false);
    this.synthesisError.set(null);
    this.synthesisQuote.set(null);
    this.synthesisOutcome.set(null);
  }

  applyZoneSelfVitals(snapshot: WsZoneSnapshotPayload): void {
    const s = snapshot.self;
    this.vitals.set({ currentHp: s.currentHp, maxHp: s.maxHp });
  }

  applyPlayerVitals(p: { currentHp: number; maxHp: number }): void {
    this.vitals.set({ currentHp: p.currentHp, maxHp: p.maxHp });
    this.characterSheet.update((cur) =>
      cur
        ? {
            ...cur,
            vitals: { currentHp: p.currentHp, maxHp: p.maxHp },
          }
        : cur,
    );
  }

  /**
   * HP propio tras recibir un golpe PvP (`attack-player-result` / `skill` contra uno mismo),
   * leído directo de ese broadcast en vez de esperar el `player-vitals` que el Warden manda
   * aparte (ese hace un refetch completo a DB para el `maxHp` real — ver combat.service.ts —
   * y sumaba un viaje de ida y vuelta extra SOLO para que la víctima viera bajar su propia
   * vida). `maxHp` no cambia por recibir daño, así que reusar el que ya tenemos es seguro;
   * el `player-vitals` posterior sigue llegando y corrige cualquier divergencia igual.
   */
  applyOwnDamageTaken(currentHp: number): void {
    const cur = this.vitals();
    if (!cur) {
      return;
    }
    const clamped = Math.max(0, Math.min(cur.maxHp, currentHp));
    this.vitals.set({ currentHp: clamped, maxHp: cur.maxHp });
    this.characterSheet.update((sheet) =>
      sheet ? { ...sheet, vitals: { currentHp: clamped, maxHp: sheet.vitals.maxHp } } : sheet,
    );
  }

  applyPlayerStatsUpdate(payload: WsPlayerStatsUpdatePayload): void {
    if (payload.characterId !== this.sessionCharacterId()) {
      return;
    }
    this.vitals.set({
      currentHp: payload.vitals.currentHp,
      maxHp: payload.vitals.maxHp,
    });
    this.characterSheet.update((cur) =>
      cur
        ? {
            ...cur,
            derived: payload.derived,
            vitals: {
              currentHp: payload.vitals.currentHp,
              maxHp: payload.vitals.maxHp,
            },
          }
        : cur,
    );
  }

  mergeFromProgress(body: {
    items: InventoryItemRowDto[];
    character: CharacterSheetDto;
    adena?: string;
  }): void {
    this.inventoryItems.set(body.items);
    this.characterSheet.set(body.character);
    this.vitals.set(body.character.vitals);
    this.syncXpFromCharacterSheet(body.character);
    if (typeof body.adena === 'string') {
      this.adena.set(body.adena);
    }
  }

  /**
   * Ack de `PICK_ITEM`: inventario + adena + ficha en un solo tick (sin esperar HTTP).
   */
  mergeFromPickAck(r: Extract<WsPickItemAckPayload, { ok: true }>): void {
    this.inventoryItems.set(r.items);
    this.characterSheet.set(r.character);
    this.vitals.set(r.character.vitals);
    this.syncXpFromCharacterSheet(r.character);
    this.adena.set(r.adena);
    const line = `[System] Has recogido: ${r.pickedItemDisplayName} x${r.pickedQuantity}`;
    this.pushSystemLogLine(line);
  }

  mergeFromShopAck(r: Extract<WsShopTxnAckPayload, { ok: true }>): void {
    this.inventoryItems.set(r.items);
    this.characterSheet.set(r.character);
    this.vitals.set(r.character.vitals);
    this.syncXpFromCharacterSheet(r.character);
    this.adena.set(r.adena);
  }

  mergeFromSynthesisAck(r: Extract<WsRequestSynthesisAckPayload, { ok: true }>): void {
    this.inventoryItems.set(r.items);
    this.characterSheet.set(r.character);
    this.vitals.set(r.character.vitals);
    this.syncXpFromCharacterSheet(r.character);
    this.adena.set(r.adena);
    this.synthesisQuote.set({
      ok: true,
      adenaCost: r.adenaSpent,
      baseSuccessPercent: r.baseSuccessPercent,
      effectiveSuccessPercent: r.effectiveSuccessPercent,
      pityCount: r.pityCount,
      pityMaxFails: r.pityMaxFails,
      pityBonusPerFailPercent: r.pityBonusPerFailPercent,
    });
    this.synthesisOutcome.set({
      success: r.success,
      forcedByPity: r.forcedByPity,
      newItemLevel: r.newItemLevel,
      pityCount: r.pityCount,
    });
  }

  /** Ack de `USE_ITEM`: inventario + ficha (HP ya llegó por `player-vitals` del Warden). */
  mergeFromUseItemAck(r: Extract<WsUseItemAckPayload, { ok: true }>): void {
    this.mergeFromShopAck({
      ok: true,
      character: r.character,
      items: r.items,
      adena: r.adena,
    });
    if (r.hpRestored > 0) {
      this.pushSystemLogLine(`[System] +${r.hpRestored} HP (poción)`);
    }
  }

  private syncXpFromCharacterSheet(c: CharacterSheetDto): void {
    if (typeof c.experience !== 'number' || typeof c.experienceRequiredForNext !== 'number') {
      return;
    }
    this.xpProgress.set({
      level: c.level,
      experience: c.experience,
      experienceRequiredForNext: c.experienceRequiredForNext,
    });
  }

  private applyAttackMobRewards(r: WsAttackMobRewardsPayload): void {
    if (!this.sessionCharacterId()) {
      return;
    }
    if (r.experienceGained > 0) {
      this.pushSystemLogLine(
        `[System] Has ganado ${r.experienceGained} puntos de experiencia.`,
      );
    }
    this.xpProgress.set({
      level: r.level,
      experience: r.experience,
      experienceRequiredForNext: r.experienceRequiredForNext,
    });
    this.characterSheet.update((cur) =>
      cur
        ? {
            ...cur,
            level: r.level,
            experience: r.experience,
            experienceRequiredForNext: r.experienceRequiredForNext,
          }
        : cur,
    );
  }

  private applyLevelUpSocket(p: WsLevelUpPayload): void {
    if (p.characterId !== this.sessionCharacterId()) {
      return;
    }
    this.xpProgress.set({
      level: p.newLevel,
      experience: p.experience,
      experienceRequiredForNext: p.experienceRequiredForNext,
    });
    this.vitals.set({ currentHp: p.currentHp, maxHp: p.maxHp });
    this.characterSheet.update((cur) =>
      cur
        ? {
            ...cur,
            level: p.newLevel,
            experience: p.experience,
            experienceRequiredForNext: p.experienceRequiredForNext,
            availableStatPoints: p.availableStatPoints,
            vitals: { currentHp: p.currentHp, maxHp: p.maxHp },
          }
        : cur,
    );
    this.levelUpOverlay.set(true);
    setTimeout(() => this.levelUpOverlay.set(false), 2800);
  }

  pushSystemLogLine(text: string): void {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `sys-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.systemLogLines.update((prev) => [...prev.slice(-49), { id, text }]);
  }

  mergeFromEquipResponse(body: {
    character: CharacterSheetDto;
  }): void {
    this.characterSheet.set(body.character);
    this.vitals.set(body.character.vitals);
    this.syncXpFromCharacterSheet(body.character);
  }

  /** Misma forma de ficha que equip (ack HTTP/socket). */
  mergeFromUnequipResponse(body: { character: CharacterSheetDto }): void {
    this.mergeFromEquipResponse(body);
  }

  refreshFromServer(characterId: string): void {
    this.loadError.set(null);
    this.api.fetchProgress(characterId).subscribe({
      next: (r) => this.mergeFromProgress(r),
      error: (e: { error?: { message?: string }; message?: string }) => {
        const msg =
          typeof e?.error?.message === 'string'
            ? e.error.message
            : typeof e?.message === 'string'
              ? e.message
              : 'No se pudo cargar el inventario';
        this.loadError.set(msg);
      },
    });
  }

  requestEquip(
    characterId: string,
    itemId: string,
    slot: string | number,
    parentItemId?: string,
  ): void {
    this.equipError.set(null);
    this.equipBusy.set(true);

    const fail = (msg: string) => {
      this.equipError.set(msg);
      this.equipBusy.set(false);
    };

    if (this.worldSocket.socketConnected()) {
      this.worldSocket.emitEquipItemWithAck({ itemId, slot, parentItemId }, (r) => {
        if (!r.ok) {
          fail(`${r.code}: ${r.message}`);
          return;
        }
        this.mergeFromEquipResponse(r);
        this.equipBusy.set(false);
        this.refreshFromServer(characterId);
      });
      return;
    }

    this.api.equipItem(characterId, itemId, slot, parentItemId).subscribe({
      next: (r) => {
        this.mergeFromEquipResponse(r);
        this.equipBusy.set(false);
        this.refreshFromServer(characterId);
      },
      error: (e: { error?: { code?: string; message?: string }; message?: string }) => {
        const body = e?.error;
        const msg =
          typeof body?.message === 'string'
            ? `${body.code ?? 'ERROR'}: ${body.message}`
            : typeof e?.message === 'string'
              ? e.message
              : 'No se pudo equipar';
        fail(msg);
      },
    });
  }

  requestUseConsumable(characterId: string, itemInstanceId: string): void {
    this.useItemError.set(null);
    this.useItemBusy.set(true);
    const fail = (msg: string) => {
      this.useItemError.set(msg);
      this.useItemBusy.set(false);
    };
    if (!this.worldSocket.socketConnected()) {
      fail('Conectate al mundo para usar ítems.');
      return;
    }
    this.worldSocket.emitUseItemWithAck({ itemInstanceId }, (r) => {
      if (!r.ok) {
        fail(`${r.code}: ${r.message}`);
        return;
      }
      this.mergeFromUseItemAck(r);
      this.useItemBusy.set(false);
      this.refreshFromServer(characterId);
    });
  }

  requestDistributeStat(
    characterId: string,
    statName: 'STR' | 'AGI' | 'VIT' | 'ENE',
    amount = 1,
  ): void {
    this.distributeError.set(null);
    if (this.distributeBusy()) {
      return;
    }
    const current = this.characterSheet();
    if (!current || current.characterId !== characterId) {
      this.distributeError.set('No hay ficha activa para asignar puntos.');
      return;
    }
    if (current.availableStatPoints <= 0) {
      this.distributeError.set('No tienes puntos disponibles.');
      return;
    }
    if (!this.worldSocket.socketConnected()) {
      this.distributeError.set('Conectate al mundo para asignar stats.');
      return;
    }

    this.distributeBusy.set(true);
    this.worldSocket.emitDistributeStatWithAck({ statName, amount }, (r) => {
      if (!r.ok) {
        this.distributeError.set(`${r.code}: ${r.message}`);
        this.distributeBusy.set(false);
        return;
      }
      this.mergeFromEquipResponse({ character: r.character });
      this.distributeBusy.set(false);
      this.refreshFromServer(characterId);
    });
  }

  requestUnequip(characterId: string, itemId: string): void {
    this.equipError.set(null);
    this.equipBusy.set(true);

    const fail = (msg: string) => {
      this.equipError.set(msg);
      this.equipBusy.set(false);
    };

    if (this.worldSocket.socketConnected()) {
      this.worldSocket.emitUnequipItemWithAck({ itemId }, (r) => {
        if (!r.ok) {
          fail(`${r.code}: ${r.message}`);
          return;
        }
        this.mergeFromUnequipResponse(r);
        this.equipBusy.set(false);
        this.refreshFromServer(characterId);
      });
      return;
    }

    this.api.unequipItem(characterId, itemId).subscribe({
      next: (r) => {
        this.mergeFromUnequipResponse(r);
        this.equipBusy.set(false);
        this.refreshFromServer(characterId);
      },
      error: (e: { error?: { code?: string; message?: string }; message?: string }) => {
        const body = e?.error;
        const msg =
          typeof body?.message === 'string'
            ? `${body.code ?? 'ERROR'}: ${body.message}`
            : typeof e?.message === 'string'
              ? e.message
              : 'No se pudo desequipar';
        fail(msg);
      },
    });
  }

  requestSynthesisQuote(itemAId: string, itemBId: string): void {
    this.synthesisError.set(null);
    this.synthesisOutcome.set(null);
    if (!this.worldSocket.socketConnected()) {
      this.synthesisQuote.set(null);
      this.synthesisError.set('Conectate al mundo para consultar síntesis.');
      return;
    }
    this.worldSocket.emitSynthesisQuoteWithAck({ itemAId, itemBId }, (r) => {
      if (!r.ok) {
        this.synthesisQuote.set(null);
        this.synthesisError.set(`${r.code}: ${r.message}`);
        return;
      }
      this.synthesisQuote.set(r);
    });
  }

  requestSynthesis(characterId: string, itemAId: string, itemBId: string): void {
    this.synthesisError.set(null);
    this.synthesisOutcome.set(null);
    if (this.synthesisBusy()) {
      return;
    }
    if (!this.worldSocket.socketConnected()) {
      this.synthesisError.set('Conectate al mundo para sintetizar.');
      return;
    }
    this.synthesisBusy.set(true);
    this.worldSocket.emitRequestSynthesisWithAck({ itemAId, itemBId }, (r) => {
      if (!r.ok) {
        this.synthesisError.set(`${r.code}: ${r.message}`);
        this.synthesisBusy.set(false);
        return;
      }
      this.mergeFromSynthesisAck(r);
      this.pushSystemLogLine(
        r.success
          ? `[Synth] EXITO +${r.newItemLevel} (${r.forcedByPity ? 'Pity' : 'RNG'})`
          : `[Synth] FALLO (Pity ${r.pityCount}/${r.pityMaxFails})`,
      );
      this.synthesisBusy.set(false);
      this.refreshFromServer(characterId);
    });
  }
}
