import type { InventoryItemRowDto } from '../../../../../../libs/shared-types/src/inventory-api';

/**
 * Presentación de ítems (grado/+N/ícono) compartida entre el inventario y cualquier otro
 * panel que tenga que dibujar un slot de ítem igual (ej. `synthesis.component.ts`) — antes
 * vivía duplicado/solo en `InventoryPanelComponent`.
 */

export function isIconPath(icon: string | null | undefined): boolean {
  const s = (icon ?? '').trim();
  if (!s) {
    return false;
  }
  return (
    s.startsWith('/') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('http://') ||
    s.startsWith('https://')
  );
}

export function isStubIcon(icon: string | null | undefined): boolean {
  const s = (icon ?? '').toLowerCase();
  return s.includes('stub');
}

export function plusLevel(item: InventoryItemRowDto): number {
  if (typeof item.plusLevel !== 'number' || !Number.isFinite(item.plusLevel)) {
    return 0;
  }
  return Math.max(0, Math.floor(item.plusLevel));
}

export function hasPlusLevel(item: InventoryItemRowDto): boolean {
  return plusLevel(item) > 0;
}

export function displayItemTitle(item: InventoryItemRowDto): string {
  const plus = plusLevel(item);
  if (plus <= 0) {
    return item.name;
  }
  return `${item.name} +${plus}`;
}

export type ItemGradeLabel = 'None' | 'D' | 'C' | 'B' | 'A' | 'S';

export function gradeLabel(item: InventoryItemRowDto): ItemGradeLabel {
  const grade = item.grade;
  if (
    grade === 'D' ||
    grade === 'C' ||
    grade === 'B' ||
    grade === 'A' ||
    grade === 'S' ||
    grade === 'None'
  ) {
    return grade;
  }
  return 'None';
}

export function gradeToneClass(item: InventoryItemRowDto): string {
  return `item-grade--${gradeLabel(item).toLowerCase()}`;
}

export function gradeColor(item: InventoryItemRowDto): string {
  const grade = gradeLabel(item);
  if (grade === 'D') {
    return '#d4af37';
  }
  if (grade === 'C') {
    return '#e5e4e2';
  }
  if (grade === 'B') {
    return '#0077be';
  }
  if (grade === 'A') {
    return '#50c878';
  }
  if (grade === 'S') {
    return '#ff4500';
  }
  return '#2f3848';
}

export function itemToneClass(item: InventoryItemRowDto): string {
  if (item.consumable) {
    return 'slot-visual--potion';
  }
  const typeHint = `${item.catalogKey ?? ''} ${item.itemTemplateId}`.toLowerCase();
  if (typeHint.includes('drop') || typeHint.includes('loot')) {
    return 'slot-visual--drop';
  }
  return 'slot-visual--gear';
}
