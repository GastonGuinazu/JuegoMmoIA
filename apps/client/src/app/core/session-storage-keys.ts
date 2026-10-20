/** Compartida entre el login (`/login`) y el viewport (`/`): sin esto cada lado
 * podía quedar con su propia copia del string y desincronizarse en un rename. */
export const CHARACTER_ID_STORAGE_KEY = 'aetheris.characterId';
