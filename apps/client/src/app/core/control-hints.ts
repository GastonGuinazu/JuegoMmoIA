/** Atajos públicos (sin comandos GM, que son solo para cuentas `isAdmin`). */
export interface ControlHint {
  key: string;
  action: string;
}

/**
 * Atajos que no cambian según la clase conectada. Las teclas 1-5/Space (ataque, skills,
 * pociones, dash) se arman en `game-viewport.component.ts` a partir de `actionBarSlots`,
 * la misma fuente de verdad que ya usa el hotbar — así el panel de Esc nunca queda
 * desincronizado de lo que el jugador realmente tiene en pantalla (antes mostraba siempre
 * Power Strike/Rageful Blow, aunque la clase conectada fuera otra).
 */
export const CONTROL_HINTS_PRE_ACTIONS: readonly ControlHint[] = [
  { key: 'Click izq.', action: 'Seleccionar objetivo, recoger ítem, tienda o hablar con el guía' },
  { key: 'Click der.', action: 'Moverse al punto señalado' },
];

export const CONTROL_HINTS_POST_ACTIONS: readonly ControlHint[] = [
  { key: 'Tab / I', action: 'Inventario' },
  { key: 'P', action: 'Ficha de personaje' },
  { key: 'O', action: 'Síntesis' },
  { key: 'Enter', action: 'Chat' },
  { key: 'Esc', action: 'Cancelar selección / menú' },
];
