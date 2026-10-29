import { CommonModule } from '@angular/common';
import { Component, ElementRef, ViewChild, computed, effect, inject, input, signal } from '@angular/core';
import type { InventoryItemRowDto } from '../../../../../../libs/shared-types/src/inventory-api';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';
import {
  displayItemTitle,
  gradeColor,
  gradeToneClass,
  hasPlusLevel,
  isIconPath,
  isStubIcon,
  itemToneClass,
  plusLevel,
} from './item-display.util';

/** Qué rol ocupa un ítem en el combo actual — maneja el resaltado del grid de candidatos. */
type MaterialSlotRole = 'one' | 'two' | null;

@Component({
  selector: 'app-synthesis',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './synthesis.component.html',
  styleUrl: './synthesis.component.scss',
})
export class SynthesisComponent {
  readonly characterId = input.required<string>();
  readonly state = inject(PlayerCharacterStateService);

  @ViewChild('floatingTooltip')
  private floatingTooltipRef?: ElementRef<HTMLElement>;

  readonly materialOneId = signal<string>('');
  readonly materialTwoId = signal<string>('');
  /** Feedback corto cuando un clic derecho no es un material 2 válido (no reemplaza al
   * `materialHint` permanente, que explica la regla en general). */
  readonly rejectedPickHint = signal<string>('');
  private rejectedPickTimer: ReturnType<typeof setTimeout> | null = null;

  readonly hoveredTooltipItem = signal<InventoryItemRowDto | null>(null);
  readonly tooltipStyle = signal<Record<string, string>>({ left: '0px', top: '0px' });

  /** Mismo criterio que antes: no consumibles, no stackeables, en mochila o equipados. */
  readonly allCandidateItems = computed(() =>
    this.state
      .inventoryItems()
      .filter((item) => !item.consumable && item.quantity === 1)
      .filter((item) => item.location === 'INVENTORY' || item.location === 'EQUIPPED')
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name) || plusLevel(a) - plusLevel(b)),
  );

  readonly selectedMaterialOne = computed(() =>
    this.allCandidateItems().find((item) => item.id === this.materialOneId()) ?? null,
  );

  readonly materialTwoCandidates = computed(() => {
    const one = this.selectedMaterialOne();
    if (!one) {
      return [];
    }
    return this.state
      .inventoryItems()
      .filter((item) => !item.consumable && item.location === 'INVENTORY')
      .filter(
        (item) =>
          item.id !== one.id &&
          item.itemTemplateId === one.itemTemplateId &&
          plusLevel(item) === plusLevel(one),
      );
  });

  readonly selectedMaterialTwo = computed(() =>
    this.materialTwoCandidates().find((item) => item.id === this.materialTwoId()) ?? null,
  );

  /** Mismo motivo que antes del rediseño: sin esto, un material que no aparece en el
   * grid (porque no matchea ítem+nivel) se ve como un bug en vez de la regla del juego. */
  readonly materialHint = computed(() => {
    const one = this.selectedMaterialOne();
    if (!one || this.selectedMaterialTwo()) {
      return '';
    }
    if (this.materialTwoCandidates().length > 0) {
      return '';
    }
    return `Necesitás otro "${one.name}" +${plusLevel(one)} para el Material 2 (mismo ítem, mismo nivel).`;
  });

  readonly quote = computed(() => this.state.synthesisQuote());
  readonly outcome = computed(() => this.state.synthesisOutcome());
  readonly canSynthesize = computed(
    () =>
      !!this.selectedMaterialOne() &&
      !!this.selectedMaterialTwo() &&
      !!this.quote() &&
      !this.state.synthesisBusy(),
  );

  readonly resultPreviewLevel = computed(() => {
    const one = this.selectedMaterialOne();
    if (!one) {
      return null;
    }
    const outcome = this.outcome();
    if (outcome) {
      return outcome.success ? outcome.newItemLevel : plusLevel(one);
    }
    return plusLevel(one) + 1;
  });

  readonly resultFxClass = computed(() => {
    const outcome = this.outcome();
    if (!outcome) {
      return '';
    }
    return outcome.success ? 'result-slot--success' : 'result-slot--fail';
  });

  /**
   * El pity garantiza el éxito (`forcedByPity` en el server) apenas `pityCount` llega a
   * `pityMaxFails` — pero la fórmula (`base + bonus*pityCount`) en ese punto puede seguir
   * dando, por ejemplo, 85% en vez de 100% (ver `synthesis-tiers.json`, tier +1: 75% base,
   * +2%/fallo, tope en 5 fallos → 85%, aunque el 6to intento ya está garantizado). Sin esto
   * el panel mentía por defecto (mostraba menos de lo que en realidad iba a pasar).
   */
  readonly isGuaranteed = computed(() => {
    const q = this.quote();
    return !!q && q.pityCount >= q.pityMaxFails;
  });

  readonly successPercent = computed(() => {
    const q = this.quote();
    if (!q) {
      return 0;
    }
    if (this.isGuaranteed()) {
      return 100;
    }
    return Math.max(0, Math.min(100, q.effectiveSuccessPercent));
  });

  readonly smokeParticles = Array.from({ length: 10 }, (_, i) => i);

  constructor() {
    effect(() => {
      const one = this.selectedMaterialOne();
      const two = this.selectedMaterialTwo();
      if (!one || !two) {
        return;
      }
      this.state.requestSynthesisQuote(one.id, two.id);
    });

    // El material 2 puede dejar de ser válido si el material 1 cambia (otro ítem/nivel).
    effect(() => {
      const two = this.materialTwoId();
      if (!two) {
        return;
      }
      if (!this.materialTwoCandidates().some((item) => item.id === two)) {
        this.materialTwoId.set('');
      }
    });
  }

  /** Rol actual de un ítem del grid de candidatos (resalta el slot correspondiente). */
  roleOf(item: InventoryItemRowDto): MaterialSlotRole {
    if (item.id === this.materialOneId()) {
      return 'one';
    }
    if (item.id === this.materialTwoId()) {
      return 'two';
    }
    return null;
  }

  /**
   * Clic derecho en el grid: primero elige Material 1, segundo clic derecho (en un ítem
   * compatible) elige Material 2. Clic derecho sobre un material ya elegido lo deselecciona.
   * Con los dos ya ocupados, un tercer clic derecho reinicia el combo con ese ítem como
   * Material 1 — más intuitivo que ignorarlo.
   */
  onCandidateContextMenu(ev: MouseEvent, item: InventoryItemRowDto): void {
    ev.preventDefault();
    if (this.state.synthesisBusy()) {
      return;
    }
    const role = this.roleOf(item);
    if (role === 'one') {
      this.clearMaterialOne();
      return;
    }
    if (role === 'two') {
      this.clearMaterialTwo();
      return;
    }
    if (!this.materialOneId()) {
      this.setMaterialOne(item.id);
      return;
    }
    if (!this.materialTwoId()) {
      const one = this.selectedMaterialOne();
      const isValidTwo =
        !!one &&
        item.location === 'INVENTORY' &&
        item.itemTemplateId === one.itemTemplateId &&
        plusLevel(item) === plusLevel(one);
      if (isValidTwo) {
        this.setMaterialTwo(item.id);
      } else {
        this.flashRejectedPick('No combina con el Material 1 (tiene que ser el mismo ítem y mismo nivel).');
      }
      return;
    }
    // Los dos slots ya están ocupados: empezar un combo nuevo con este ítem.
    this.setMaterialOne(item.id);
  }

  /** Clic derecho directo sobre el slot de Material 1 o 2 (arriba): lo limpia. */
  onMaterialSlotContextMenu(ev: MouseEvent, role: 'one' | 'two'): void {
    ev.preventDefault();
    if (role === 'one') {
      this.clearMaterialOne();
    } else {
      this.clearMaterialTwo();
    }
  }

  private setMaterialOne(id: string): void {
    this.materialOneId.set(id);
    this.materialTwoId.set('');
    this.state.synthesisOutcome.set(null);
    this.state.synthesisError.set(null);
  }

  private setMaterialTwo(id: string): void {
    this.materialTwoId.set(id);
    this.state.synthesisOutcome.set(null);
  }

  private clearMaterialOne(): void {
    this.materialOneId.set('');
    this.materialTwoId.set('');
    this.state.synthesisQuote.set(null);
    this.state.synthesisError.set(null);
    this.state.synthesisOutcome.set(null);
  }

  private clearMaterialTwo(): void {
    this.materialTwoId.set('');
    this.state.synthesisOutcome.set(null);
  }

  private flashRejectedPick(message: string): void {
    this.rejectedPickHint.set(message);
    if (this.rejectedPickTimer) {
      clearTimeout(this.rejectedPickTimer);
    }
    this.rejectedPickTimer = setTimeout(() => this.rejectedPickHint.set(''), 2200);
  }

  runSynthesis(): void {
    const one = this.selectedMaterialOne();
    const two = this.selectedMaterialTwo();
    if (!one || !two) {
      return;
    }
    this.state.requestSynthesis(this.characterId(), one.id, two.id);
  }

  formatAdena(raw: string): string {
    try {
      return BigInt(raw).toLocaleString('es-AR');
    } catch {
      return raw;
    }
  }

  // --- Presentación de ítems: delegadas al util compartido con el inventario. ---
  isIconPath = isIconPath;
  isStubIcon = isStubIcon;
  plusLevel = plusLevel;
  hasPlusLevel = hasPlusLevel;
  gradeColor = gradeColor;
  gradeToneClass = gradeToneClass;
  itemToneClass = itemToneClass;
  displayItemTitle = displayItemTitle;

  showNameFallback(item: InventoryItemRowDto): boolean {
    return isStubIcon(item.icon);
  }

  statLines(item: InventoryItemRowDto): string[] {
    return item.statLines ?? [];
  }

  showFloatingTooltip(ev: MouseEvent, item: InventoryItemRowDto): void {
    this.hoveredTooltipItem.set(item);
    this.positionTooltip(ev);
  }

  moveFloatingTooltip(ev: MouseEvent): void {
    if (!this.hoveredTooltipItem()) {
      return;
    }
    this.positionTooltip(ev);
  }

  hideFloatingTooltip(): void {
    this.hoveredTooltipItem.set(null);
  }

  private positionTooltip(ev: MouseEvent): void {
    const el = this.floatingTooltipRef?.nativeElement;
    const width = el?.offsetWidth ?? 160;
    const height = el?.offsetHeight ?? 80;
    const margin = 14;
    let left = ev.clientX + margin;
    let top = ev.clientY + margin;
    if (left + width > window.innerWidth) {
      left = ev.clientX - width - margin;
    }
    if (top + height > window.innerHeight) {
      top = ev.clientY - height - margin;
    }
    this.tooltipStyle.set({ left: `${Math.max(4, left)}px`, top: `${Math.max(4, top)}px` });
  }
}
