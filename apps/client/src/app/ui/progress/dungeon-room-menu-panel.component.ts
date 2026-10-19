import { Component, computed, effect, inject, signal } from '@angular/core';
import type { WsDungeonPartyTarget } from '@aetheris/shared-types';
import { DungeonUiService } from '../../core/dungeon-ui.service';
import { NpcShopUiService } from '../../core/npc-shop-ui.service';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';
import { WorldSocketService } from '../../core/world-socket.service';

@Component({
  selector: 'app-dungeon-room-menu-panel',
  standalone: true,
  templateUrl: './dungeon-room-menu-panel.component.html',
  styleUrl: './dungeon-room-menu-panel.component.scss',
})
export class DungeonRoomMenuPanelComponent {
  readonly ui = inject(DungeonUiService);
  private readonly npcShopUi = inject(NpcShopUiService);
  private readonly worldSocket = inject(WorldSocketService);
  private readonly playerState = inject(PlayerCharacterStateService);

  readonly pending = signal(false);
  readonly errorText = signal<string | null>(null);
  /** Compañeros de grupo en la mazmorra en otra cámara; se pide al abrir el diálogo de sala. */
  readonly partyTargets = signal<WsDungeonPartyTarget[]>([]);

  readonly isNexus = computed(() => this.ui.openNpcMenu()?.kind === 'nexus');
  readonly speakerLabel = computed(() =>
    this.isNexus() ? 'Guía de la Mazmorra' : 'Guía de Sala',
  );

  constructor() {
    effect(() => {
      const menu = this.ui.openNpcMenu();
      if (!menu || menu.kind !== 'room') {
        this.partyTargets.set([]);
        return;
      }
      this.worldSocket.emitDungeonPartyTargetsRequestWithAck(
        { npcInstanceId: menu.npcInstanceId },
        (ack) => {
          this.partyTargets.set(ack.ok ? ack.targets : []);
        },
      );
    });
  }

  close(): void {
    this.ui.closeRoomMenu();
    this.errorText.set(null);
  }

  enterDungeon(): void {
    const npcInstanceId = this.ui.openNpcMenu()?.npcInstanceId;
    if (!npcInstanceId || this.pending()) {
      return;
    }
    this.pending.set(true);
    this.errorText.set(null);
    this.worldSocket.emitDungeonEnterRequestWithAck({ npcInstanceId }, (ack) => {
      this.pending.set(false);
      if (!ack.ok || ack.exited) {
        if (!ack.ok) {
          this.errorText.set(ack.message);
          this.playerState.pushSystemLogLine(`[Mazmorra] ${ack.message}`);
        }
        return;
      }
      this.ui.closeRoomMenu();
      this.ui.setActiveChamber({
        zoneId: ack.zoneId,
        chamberDisplayName: ack.chamberDisplayName,
        expiresAtEpochMs: ack.expiresAtEpochMs,
      });
      this.playerState.pushSystemLogLine(`[Mazmorra] Entraste a ${ack.chamberDisplayName}.`);
    });
  }

  changeRoom(): void {
    this.runRoomAction('next_room');
  }

  exitDungeon(): void {
    this.runRoomAction('exit');
  }

  goToPartyMember(targetCharacterId: string): void {
    this.runRoomAction('join_party_member', targetCharacterId);
  }

  /** Reusa el mismo flujo que el mercader (`OPEN_MERCHANT_STORE`): el guía también vende pociones. */
  buyPotions(): void {
    const npcInstanceId = this.ui.openNpcMenu()?.npcInstanceId;
    if (!npcInstanceId || this.pending()) {
      return;
    }
    this.pending.set(true);
    this.errorText.set(null);
    this.worldSocket.emitOpenMerchantStoreWithAck({ npcInstanceId }, (ack) => {
      this.pending.set(false);
      if (!ack.ok) {
        this.errorText.set(ack.message);
        this.playerState.pushSystemLogLine(`[Mazmorra] ${ack.message}`);
        return;
      }
      this.ui.closeRoomMenu();
      this.npcShopUi.open(ack);
    });
  }

  private runRoomAction(
    action: 'next_room' | 'exit' | 'join_party_member',
    targetCharacterId?: string,
  ): void {
    const npcInstanceId = this.ui.openNpcMenu()?.npcInstanceId;
    if (!npcInstanceId || this.pending()) {
      return;
    }
    this.pending.set(true);
    this.errorText.set(null);
    this.worldSocket.emitDungeonRoomActionWithAck({ npcInstanceId, action, targetCharacterId }, (ack) => {
      this.pending.set(false);
      if (!ack.ok) {
        this.errorText.set(ack.message);
        this.playerState.pushSystemLogLine(`[Mazmorra] ${ack.message}`);
        return;
      }
      this.ui.closeRoomMenu();
      if (ack.exited) {
        this.ui.clear();
        this.playerState.pushSystemLogLine('[Mazmorra] Saliste de la mazmorra.');
        return;
      }
      this.ui.setActiveChamber({
        zoneId: ack.zoneId,
        chamberDisplayName: ack.chamberDisplayName,
        expiresAtEpochMs: ack.expiresAtEpochMs,
      });
      this.playerState.pushSystemLogLine(`[Mazmorra] Pasaste a ${ack.chamberDisplayName}.`);
    });
  }
}
