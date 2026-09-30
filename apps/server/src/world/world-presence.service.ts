import { Injectable } from '@nestjs/common';

/** Personajes con socket `/world` conectado (regen y optimizaciones Warden). */
@Injectable()
export class WorldPresenceService {
  private readonly ids = new Set<string>();
  /** Auto-ataque: mob instancia seleccionado por personaje (UUID mob). */
  private readonly activeMobTargetByCharacter = new Map<string, string>();
  /** HP del jugador pendiente de flush a DB (evita regen leyendo fila vieja). */
  private readonly characterHpDirty = new Set<string>();

  register(characterId: string): void {
    this.ids.add(characterId);
  }

  isConnected(characterId: string): boolean {
    return this.ids.has(characterId);
  }

  unregister(characterId: string): void {
    this.ids.delete(characterId);
    this.activeMobTargetByCharacter.delete(characterId);
    this.characterHpDirty.delete(characterId);
  }

  markCharacterHpDirty(characterId: string): void {
    this.characterHpDirty.add(characterId);
  }

  clearCharacterHpDirty(characterId: string): void {
    this.characterHpDirty.delete(characterId);
  }

  isCharacterHpDirty(characterId: string): boolean {
    return this.characterHpDirty.has(characterId);
  }

  setActiveMobTarget(characterId: string, mobInstanceId: string | null): void {
    if (mobInstanceId === null) {
      this.activeMobTargetByCharacter.delete(characterId);
    } else {
      this.activeMobTargetByCharacter.set(characterId, mobInstanceId);
    }
  }

  getActiveMobTarget(characterId: string): string | undefined {
    return this.activeMobTargetByCharacter.get(characterId);
  }

  clearAllCharactersTargetingMob(mobInstanceId: string): void {
    for (const [cid, mid] of this.activeMobTargetByCharacter.entries()) {
      if (mid === mobInstanceId) {
        this.activeMobTargetByCharacter.delete(cid);
      }
    }
  }

  snapshot(): readonly string[] {
    return [...this.ids];
  }
}
