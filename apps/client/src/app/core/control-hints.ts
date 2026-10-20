/** Atajos públicos (sin comandos GM, que son solo para cuentas `isAdmin`). */
export interface ControlHint {
  key: string;
  action: string;
}

export const CONTROL_HINTS: readonly ControlHint[] = [
  { key: 'Click izq.', action: 'Seleccionar objetivo, recoger ítem, tienda o hablar con el guía' },
  { key: 'Click der.', action: 'Moverse al punto señalado' },
  { key: '1', action: 'Ataque básico' },
  { key: '2', action: 'Power Strike' },
  { key: '3', action: 'Rageful Blow' },
  { key: '4', action: 'Poción de Vida' },
  { key: '5', action: 'Poción de Maná' },
  { key: 'Tab / I', action: 'Inventario' },
  { key: 'P', action: 'Ficha de personaje' },
  { key: 'O', action: 'Síntesis' },
  { key: 'Enter', action: 'Chat' },
  { key: 'Space', action: 'Dash (Dark Wizard)' },
  { key: 'Esc', action: 'Cancelar selección / menú' },
];
