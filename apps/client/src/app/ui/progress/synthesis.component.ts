import { CommonModule } from '@angular/common';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { InventoryItemRowDto } from '../../../../../../libs/shared-types/src/inventory-api';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';

@Component({
  selector: 'app-synthesis',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './synthesis.component.html',
  styleUrl: './synthesis.component.scss',
})
export class SynthesisComponent {
  readonly characterId = input.required<string>();
  readonly state = inject(PlayerCharacterStateService);

  readonly baseItemId = signal<string>('');
  readonly materialItemId = signal<string>('');

  readonly allCandidateItems = computed(() =>
    this.state
      .inventoryItems()
      .filter((item) => !item.consumable && item.quantity === 1)
      .filter(
        (item) => item.location === 'INVENTORY' || item.location === 'EQUIPPED',
      ),
  );

  readonly baseCandidates = computed(() => this.allCandidateItems());

  readonly selectedBase = computed(() =>
    this.baseCandidates().find((item) => item.id === this.baseItemId()) ?? null,
  );

  readonly materialCandidates = computed(() => {
    const base = this.selectedBase();
    if (!base) {
      return [];
    }
    return this.state
      .inventoryItems()
      .filter((item) => !item.consumable && item.location === 'INVENTORY')
      .filter(
        (item) =>
          item.id !== base.id &&
          item.itemTemplateId === base.itemTemplateId &&
          this.plusLevel(item) === this.plusLevel(base),
      );
  });

  readonly selectedMaterial = computed(() =>
    this.materialCandidates().find((item) => item.id === this.materialItemId()) ??
    null,
  );

  /**
   * El sacrificio debe ser el MISMO ítem y el MISMO nivel +N que la base (regla del
   * servidor, `synthesis.service.ts`): dos +0 se funden entre sí para dar un +1, pero
   * un +0 nunca sirve de sacrificio para una base +7. Sin este texto, un material que
   * no aparece en el desplegable se ve como un bug en vez de la regla del juego.
   */
  readonly materialHint = computed(() => {
    const base = this.selectedBase();
    if (!base) {
      return '';
    }
    if (this.materialCandidates().length > 0) {
      return '';
    }
    return `Necesitás otro "${base.name}" +${this.plusLevel(base)} para usar de sacrificio (mismo ítem y mismo nivel).`;
  });

  readonly quote = computed(() => this.state.synthesisQuote());
  readonly outcome = computed(() => this.state.synthesisOutcome());
  readonly canSynthesize = computed(() => {
    return (
      !!this.selectedBase() &&
      !!this.selectedMaterial() &&
      !!this.quote() &&
      !this.state.synthesisBusy()
    );
  });

  readonly resultLevelLabel = computed(() => {
    const base = this.selectedBase();
    if (!base) {
      return '—';
    }
    const outcome = this.outcome();
    const basePlus = this.plusLevel(base);
    if (!outcome) {
      return `Sintetizar +${basePlus} -> +${basePlus + 1}`;
    }
    if (!outcome.success) {
      return `+${basePlus} (sin cambio)`;
    }
    return `+${outcome.newItemLevel}`;
  });

  readonly resultFxClass = computed(() => {
    const outcome = this.outcome();
    if (!outcome) {
      return '';
    }
    return outcome.success ? 'result-slot--success' : 'result-slot--fail';
  });

  readonly smokeParticles = Array.from({ length: 10 }, (_, i) => i);

  constructor() {
    effect(() => {
      const base = this.selectedBase();
      const material = this.selectedMaterial();
      if (!base || !material) {
        return;
      }
      this.state.requestSynthesisQuote(base.id, material.id);
    });

    effect(() => {
      const base = this.baseItemId();
      const material = this.materialItemId();
      if (!base || !material) {
        return;
      }
      if (!this.materialCandidates().some((item) => item.id === material)) {
        this.materialItemId.set('');
      }
    });
  }

  onBaseSelectionChanged(nextId: string): void {
    this.baseItemId.set(nextId);
    this.materialItemId.set('');
    if (!nextId) {
      this.state.synthesisQuote.set(null);
      this.state.synthesisError.set(null);
      this.state.synthesisOutcome.set(null);
    }
  }

  onMaterialSelectionChanged(nextId: string): void {
    this.materialItemId.set(nextId);
    this.state.synthesisOutcome.set(null);
  }

  runSynthesis(): void {
    const base = this.selectedBase();
    const material = this.selectedMaterial();
    if (!base || !material) {
      return;
    }
    this.state.requestSynthesis(this.characterId(), base.id, material.id);
  }

  formatAdena(raw: string): string {
    try {
      return BigInt(raw).toLocaleString('es-AR');
    } catch {
      return raw;
    }
  }

  displayItem(item: InventoryItemRowDto): string {
    return `${item.name} (+${this.plusLevel(item)})`;
  }

  plusLevel(item: InventoryItemRowDto): number {
    const plus = item.plusLevel;
    if (typeof plus !== 'number' || !Number.isFinite(plus)) {
      return 0;
    }
    return Math.max(0, Math.floor(plus));
  }
}
