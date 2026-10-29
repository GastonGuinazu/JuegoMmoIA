import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type { InventoryItemRowDto } from '../../../../../../libs/shared-types/src/inventory-api';
import { PlayerCharacterStateService } from '../../core/player-character-state.service';
import {
  GEAR_SLOT_LABELS,
  INVENTORY_GRID_COLS,
  INVENTORY_SLOT_COUNT,
  PAPERDOLL_LAYOUT,
} from './gear-slots';
import {
  displayItemTitle as displayItemTitleUtil,
  gradeColor as gradeColorUtil,
  gradeLabel as gradeLabelUtil,
  gradeToneClass as gradeToneClassUtil,
  hasPlusLevel as hasPlusLevelUtil,
  isIconPath as isIconPathUtil,
  isStubIcon as isStubIconUtil,
  itemToneClass as itemToneClassUtil,
  plusLevel as plusLevelUtil,
  type ItemGradeLabel,
} from './item-display.util';

@Component({
  selector: 'app-inventory-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './inventory-panel.component.html',
  styleUrl: './inventory-panel.component.scss',
})
export class InventoryPanelComponent {
  readonly characterId = input.required<string>();
  @ViewChild('floatingTooltip')
  private floatingTooltipRef?: ElementRef<HTMLElement>;

  readonly state = inject(PlayerCharacterStateService);
  private readonly hostEl = inject(ElementRef<HTMLElement>);

  readonly pos = signal({ x: 24, y: 120 });
  readonly dragging = signal(false);
  private dragOrigin = { mx: 0, my: 0, px: 0, py: 0 };

  /** Ítems cuyo `img` falló al cargar → mostrar nombre encima del slot. */
  private readonly failedIconIds = signal(new Set<string>());

  readonly paperdollSlots = PAPERDOLL_LAYOUT;
  readonly slotLabels = GEAR_SLOT_LABELS;
  readonly gridCols = INVENTORY_GRID_COLS;
  readonly activeSubSlotRoot = signal<string | null>(null);
  readonly hoveredTooltipItem = signal<InventoryItemRowDto | null>(null);
  readonly tooltipStyle = signal<Record<string, string>>({
    left: '0px',
    top: '0px',
  });

  readonly equippedBySlot = computed(() => {
    const map = new Map<string, InventoryItemRowDto>();
    for (const item of this.state.inventoryItems()) {
      if (item.location === 'EQUIPPED' && item.gearSlot) {
        map.set(item.gearSlot, item);
      }
    }
    return map;
  });

  readonly bagSlots = computed(() => {
    const bag = this.state
      .inventoryItems()
      .filter((i) => i.location === 'INVENTORY')
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const cells: (InventoryItemRowDto | null)[] = [];
    for (let i = 0; i < INVENTORY_SLOT_COUNT; i++) {
      cells.push(bag[i] ?? null);
    }
    return cells;
  });

  readonly inventoryById = computed(() => {
    return new Map(this.state.inventoryItems().map((item) => [item.id, item]));
  });

  panelStyle = computed(() => {
    const p = this.pos();
    return {
      left: `${p.x}px`,
      top: `${p.y}px`,
    };
  });

  isIconPath(icon: string | null | undefined): boolean {
    return isIconPathUtil(icon);
  }

  isStubIcon(icon: string | null | undefined): boolean {
    return isStubIconUtil(icon);
  }

  showNameFallback(item: InventoryItemRowDto): boolean {
    return this.isStubIcon(item.icon) || this.failedIconIds().has(item.id);
  }

  onIconError(item: InventoryItemRowDto): void {
    this.failedIconIds.update((prev) => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
  }

  statLines(item: InventoryItemRowDto): string[] {
    const lines = item.statLines ?? [];
    const nested = (item.subItems ?? []).map((sub) => `- ${sub.name}`);
    if (nested.length === 0) {
      return lines;
    }
    return [...lines, `Talismanes:`, ...nested];
  }

  plusLevel(item: InventoryItemRowDto): number {
    return plusLevelUtil(item);
  }

  hasPlusLevel(item: InventoryItemRowDto): boolean {
    return hasPlusLevelUtil(item);
  }

  displayItemTitle(item: InventoryItemRowDto): string {
    return displayItemTitleUtil(item);
  }

  gradeLabel(item: InventoryItemRowDto): ItemGradeLabel {
    return gradeLabelUtil(item);
  }

  gradeToneClass(item: InventoryItemRowDto): string {
    return gradeToneClassUtil(item);
  }

  gradeColor(item: InventoryItemRowDto): string {
    return gradeColorUtil(item);
  }

  paperdollSlotBorderColor(slot: string): string | null {
    const item = this.equippedBySlot().get(slot);
    return item ? this.gradeColor(item) : null;
  }

  bagSlotBorderColor(item: InventoryItemRowDto | null): string | null {
    return item ? this.gradeColor(item) : null;
  }

  itemToneClass(item: InventoryItemRowDto): string {
    return itemToneClassUtil(item);
  }

  onHeaderPointerDown(ev: PointerEvent): void {
    ev.preventDefault();
    (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId);
    const p = this.pos();
    this.dragOrigin = { mx: ev.clientX, my: ev.clientY, px: p.x, py: p.y };
    this.dragging.set(true);
  }

  @HostListener('document:pointerup')
  onPointerUp(): void {
    this.dragging.set(false);
  }

  @HostListener('document:pointermove', ['$event'])
  onPointerMove(ev: PointerEvent): void {
    if (!this.dragging()) {
      return;
    }
    const dx = ev.clientX - this.dragOrigin.mx;
    const dy = ev.clientY - this.dragOrigin.my;
    this.pos.set(this.clampPosition({
      x: this.dragOrigin.px + dx,
      y: this.dragOrigin.py + dy,
    }));
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.pos.update((curr) => this.clampPosition(curr));
  }

  /**
   * Mochila: un solo clic derecho — consumible → usar; si no, equipable → equipar.
   */
  onBagItemContextMenu(ev: MouseEvent, item: InventoryItemRowDto | null): void {
    ev.preventDefault();
    if (!item || item.location !== 'INVENTORY') {
      return;
    }
    if (this.state.equipBusy() || this.state.useItemBusy()) {
      return;
    }
    if (item.consumable) {
      this.state.requestUseConsumable(this.characterId(), item.id);
      return;
    }
    if (item.parentSlotType) {
      const target = this.resolveActiveParentForNestedItem(item.parentSlotType);
      if (target) {
        const freeIdx = this.nextFreeSubSlot(target);
        if (freeIdx !== null) {
          this.state.requestEquip(this.characterId(), item.id, freeIdx, target.id);
          return;
        }
      }
    }
    if (item.baseSlot) {
      const slot = this.pickDefaultPaperdollSlot(item.baseSlot);
      this.state.requestEquip(this.characterId(), item.id, slot);
    }
  }

  onEquipSlotContextMenu(ev: MouseEvent, slot: string): void {
    const it = this.equippedBySlot().get(slot);
    if (!it) {
      return;
    }
    ev.preventDefault();
    this.state.requestUnequip(this.characterId(), it.id);
  }

  onPaperdollSlotHover(slot: string): void {
    const parent = this.equippedBySlot().get(slot);
    if (!parent?.hasSubSlots) {
      return;
    }
    this.activeSubSlotRoot.set(parent.id);
  }

  onPaperdollSlotLeave(_slot: string): void {
    // keep popover stable; users can also toggle it with click.
  }

  togglePaperdollSubSlots(slot: string): void {
    const parent = this.equippedBySlot().get(slot);
    if (!parent?.hasSubSlots) {
      return;
    }
    this.activeSubSlotRoot.update((curr) => (curr === parent.id ? null : parent.id));
  }

  shouldShowSubSlots(slot: string): boolean {
    const parent = this.equippedBySlot().get(slot);
    if (!parent?.hasSubSlots) {
      return false;
    }
    return this.activeSubSlotRoot() === parent.id;
  }

  subSlotsFor(parent: InventoryItemRowDto): (InventoryItemRowDto | null)[] {
    const max = Math.max(0, parent.maxSubSlots ?? 0);
    const cells: (InventoryItemRowDto | null)[] = Array.from({ length: max }, () => null);
    for (const child of this.state.inventoryItems()) {
      if (child.parentItemInstanceId !== parent.id) {
        continue;
      }
      const idx = child.parentSubSlotIndex ?? -1;
      if (idx < 0 || idx >= max) {
        continue;
      }
      cells[idx] = child;
    }
    return cells;
  }

  onSubSlotContextMenu(
    ev: MouseEvent,
    parent: InventoryItemRowDto,
    index: number,
  ): void {
    ev.preventDefault();
    const item = this.subSlotsFor(parent)[index];
    if (!item) {
      return;
    }
    this.state.requestUnequip(this.characterId(), item.id);
  }

  bagSlotTitle(item: InventoryItemRowDto | null): string {
    if (!item) {
      return 'Vacío';
    }
    const title = this.displayItemTitle(item);
    if (item.consumable) {
      return `${title} — clic derecho: usar`;
    }
    if (item.parentSlotType) {
      return `${title} — clic derecho: equipar en sub-slot activo`;
    }
    if (item.baseSlot) {
      return `${title} — clic derecho: equipar`;
    }
    return title;
  }

  trackSlot(_i: number, item: InventoryItemRowDto | null): string {
    return item?.id ?? `empty-${_i}`;
  }

  formatAdena(raw: string | null): string {
    if (raw === null || raw === '') {
      return '—';
    }
    try {
      return BigInt(raw).toLocaleString('es-AR');
    } catch {
      return raw;
    }
  }

  showFloatingTooltip(ev: MouseEvent, item: InventoryItemRowDto): void {
    this.hoveredTooltipItem.set(item);
    this.updateFloatingTooltipPositionFromEvent(ev);
    requestAnimationFrame(() => {
      this.updateFloatingTooltipPositionFromEvent(ev);
    });
  }

  moveFloatingTooltip(ev: MouseEvent): void {
    if (!this.hoveredTooltipItem()) {
      return;
    }
    this.updateFloatingTooltipPositionFromEvent(ev);
  }

  hideFloatingTooltip(): void {
    this.hoveredTooltipItem.set(null);
  }

  private updateFloatingTooltipPositionFromEvent(ev: MouseEvent): void {
    this.positionFloatingTooltipFromPointer(ev.clientX, ev.clientY);
  }

  private resolveActiveParentForNestedItem(
    parentSlotType: string,
  ): InventoryItemRowDto | null {
    const active = this.activeSubSlotRoot();
    if (active) {
      const activeItem = this.inventoryById().get(active);
      if (activeItem?.subSlotType === parentSlotType) {
        return activeItem;
      }
    }
    for (const slot of this.paperdollSlots) {
      const item = this.equippedBySlot().get(slot.slot);
      if (item?.subSlotType === parentSlotType) {
        return item;
      }
    }
    return null;
  }

  private nextFreeSubSlot(parent: InventoryItemRowDto): number | null {
    const cells = this.subSlotsFor(parent);
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) {
        return i;
      }
    }
    return null;
  }

  private pickDefaultPaperdollSlot(baseSlot: string): string {
    if (baseSlot === 'RING_1' || baseSlot === 'RING_2') {
      return this.equippedBySlot().has('RING_1') ? 'RING_2' : 'RING_1';
    }
    if (baseSlot === 'EARRING_1' || baseSlot === 'EARRING_2') {
      return this.equippedBySlot().has('EARRING_1') ? 'EARRING_2' : 'EARRING_1';
    }
    if (baseSlot === 'BRACELET_1' || baseSlot === 'BRACELET_2') {
      return this.equippedBySlot().has('BRACELET_1') ? 'BRACELET_2' : 'BRACELET_1';
    }
    return baseSlot;
  }

  private positionFloatingTooltipFromPointer(pointerX: number, pointerY: number): void {
    const tooltipEl = this.floatingTooltipRef?.nativeElement;
    if (!tooltipEl || typeof window === 'undefined') {
      return;
    }

    const tooltipRect = tooltipEl.getBoundingClientRect();
    const safe = {
      left: 8,
      top: 8,
      right: window.innerWidth - 8,
      bottom: window.innerHeight - 8,
    };
    const offset = 10;
    let left = pointerX + offset;
    let top = pointerY + offset;

    if (left + tooltipRect.width > safe.right) {
      left = pointerX - tooltipRect.width - offset;
    }
    if (top + tooltipRect.height > safe.bottom) {
      top = pointerY - tooltipRect.height - offset;
    }

    left = Math.min(Math.max(left, safe.left), safe.right - tooltipRect.width);
    top = Math.min(Math.max(top, safe.top), safe.bottom - tooltipRect.height);

    this.tooltipStyle.set({
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
    });
  }

  private clampPosition(next: { x: number; y: number }): { x: number; y: number } {
    if (typeof window === 'undefined') {
      return next;
    }
    const margin = 8;
    const panelRect = this.hostEl.nativeElement.getBoundingClientRect();
    const panelWidth = panelRect.width || 0;
    const panelHeight = panelRect.height || 0;
    const maxX = Math.max(margin, window.innerWidth - panelWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - panelHeight - margin);
    return {
      x: Math.min(Math.max(next.x, margin), maxX),
      y: Math.min(Math.max(next.y, margin), maxY),
    };
  }
}
