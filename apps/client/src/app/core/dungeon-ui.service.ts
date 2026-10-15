import { Injectable, computed, signal } from '@angular/core';

export type DungeonActiveChamber = {
  zoneId: string;
  chamberDisplayName: string;
  expiresAtEpochMs: number;
};

/** Estado de UI de la mazmorra activa (solo UI; el cronómetro real vive en el servidor). */
@Injectable({ providedIn: 'root' })
export class DungeonUiService {
  readonly activeChamber = signal<DungeonActiveChamber | null>(null);
  readonly isInDungeon = computed(() => this.activeChamber() !== null);

  /** NPC guía (nexo o sala) con el menú de diálogo abierto; `null` = cerrado. */
  readonly openNpcMenu = signal<{ npcInstanceId: string; kind: 'nexus' | 'room' } | null>(null);

  private readonly feedbackText = signal<string | null>(null);
  readonly feedback = this.feedbackText.asReadonly();

  openNexusMenu(npcInstanceId: string): void {
    this.openNpcMenu.set({ npcInstanceId, kind: 'nexus' });
  }

  openRoomMenu(npcInstanceId: string): void {
    this.openNpcMenu.set({ npcInstanceId, kind: 'room' });
  }

  closeRoomMenu(): void {
    this.openNpcMenu.set(null);
  }

  setActiveChamber(chamber: DungeonActiveChamber): void {
    this.activeChamber.set(chamber);
  }

  clear(): void {
    this.activeChamber.set(null);
  }

  pushFeedback(text: string): void {
    this.feedbackText.set(text);
  }
}
