import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { CHARACTER_ID_STORAGE_KEY } from '../core/session-storage-keys';

function hasStoredCharacter(): boolean {
  return !!localStorage.getItem(CHARACTER_ID_STORAGE_KEY)?.trim();
}

/** Ruta del juego (`/`): sin personaje elegido todavía, manda a `/login`. */
export const requireCharacterGuard: CanActivateFn = () => {
  return hasStoredCharacter() ? true : inject(Router).parseUrl('/login');
};

/** Ruta `/login`: si ya hay personaje elegido, no tiene sentido volver a pedir usuario/contraseña. */
export const redirectIfAuthenticatedGuard: CanActivateFn = () => {
  return hasStoredCharacter() ? inject(Router).parseUrl('/') : true;
};
