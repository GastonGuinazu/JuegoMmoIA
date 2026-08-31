import { Injectable, signal } from '@angular/core';
import type {
  WsAttackMobResultPayload,
  WsMobAiState,
  WsMobDeathPayload,
  WsMobMovedPayload,
  WsMobRespawnPayload,
  WsOtherPlayerSnapshot,
  WsPlayerVisualStatePayload,
  WsPlayerMovedPayload,
  WsPlayerPositionCorrectedPayload,
  WsWorldDropSnapshot,
  WsWorldDropSpawnPayload,
  WsZoneNpcSnapshot,
  WsZoneSnapshotPayload,
} from '../../../../../libs/shared-types/src/world-socket';

export type PlayerEntityState = {
  characterId: string;
  pos: { x: number; y: number; z: number };
  yaw: number;
};

export type OtherPlayerEntityState = {
  characterId: string;
  name: string;
  pos: { x: number; y: number; z: number };
  yaw: number;
  karmaFlag: 'WHITE' | 'PURPLE' | 'RED';
  weaponPlusLevel: number;
  weaponEquipped: boolean;
};

export type MobEntityState = {
  mobInstanceId: string;
  mobTemplateKey: string;
  /** Nombre de UI del snapshot / respawn (Warden). */
  displayName: string;
  /** Nivel PvE del snapshot / respawn (Warden). */
  mobLevel: number;
  pos: { x: number; y: number; z: number };
  yaw: number;
  currentHp: number;
  maxHp: number;
  visible: boolean;
  /** Si el servidor envía payload viejo, puede faltar; el sync fuerza IDLE. */
  aiState: WsMobAiState;
  /** Alcance melee autoritativo (snapshot / respawn). Fallback visual 2.5. */
  attackRange: number;
};

export type WorldDropEntityState = {
  itemInstanceId: string;
  catalogKey: string | null;
  itemName: string;
  icon: string;
  grade: 'None' | 'D' | 'C' | 'B' | 'A' | 'S';
  quantity: number;
  pos: { x: number; y: number; z: number };
  reservedForCharacterId: string | null;
  reservedUntilEpochMs: number | null;
};

export type NpcEntityState = {
  npcInstanceId: string;
  npcTemplateKey: string;
  displayName: string;
  npcRole: 'MERCHANT' | 'GENERIC';
  pos: { x: number; y: number; z: number };
};

function isFiniteVec3(p: { x: unknown; y: unknown; z: unknown }): p is { x: number; y: number; z: number } {
  return (
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    typeof p.z === 'number' &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z)
  );
}

function safeYaw(y: unknown, fallback = 0): number {
  return typeof y === 'number' && Number.isFinite(y) ? y : fallback;
}

function safeMobAiState(v: unknown): WsMobAiState {
  if (v === 'IDLE' || v === 'PATROL' || v === 'CHASE') {
    return v;
  }
  return 'IDLE';
}

function safeMobLevel(n: unknown, fallback = 1): number {
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return fallback;
}

function safeAttackRange(n: unknown, fallback = 2.5): number {
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) {
    return n;
  }
  return fallback;
}

function safeMobDisplayName(raw: unknown, fallback: string): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
}

function normalizeZoneIdFromServer(z: string | null | undefined): string {
  if (z === null || z === undefined || z === '' || z === 'default') {
    return 'Zone_0';
  }
  return z;
}

/**
 * Estado de entidades de mundo (jugador, mobs, NPC, drops). La malla estática (cajas / portales)
 * no se crea aquí: `WorldMapLoaderService` carga el JSON **de la zona activa** y el viewport reconcilia meshes en Three.js
 * cuando cambia `zoneId`.
 */
@Injectable({ providedIn: 'root' })
export class WorldEntitySyncService {
  readonly zoneId = signal<string | null>(null);
  readonly selfCharacterId = signal<string | null>(null);
  readonly playerMoveSpeed = signal(3);
  readonly player = signal<PlayerEntityState | null>(null);
  readonly otherPlayers = signal<Map<string, OtherPlayerEntityState>>(new Map());
  readonly mobs = signal<Map<string, MobEntityState>>(new Map());
  readonly worldDrops = signal<Map<string, WorldDropEntityState>>(new Map());
  readonly npcs = signal<Map<string, NpcEntityState>>(new Map());

  removeOtherPlayer(characterId: string): void {
    this.otherPlayers.update((prev) => {
      const next = new Map(prev);
      next.delete(characterId);
      return next;
    });
  }

  applyZoneSnapshot(snapshot: WsZoneSnapshotPayload): void {
    console.log('Snapshot recibido:', snapshot);
    try {
      this.applyZoneSnapshotCore(snapshot);
    } catch (e) {
      console.error('[WorldEntitySync] applyZoneSnapshot falló', e);
    }
  }

  private applyZoneSnapshotCore(snapshot: WsZoneSnapshotPayload): void {
    const prevPlayer = this.player();
    const fallbackPos = prevPlayer?.pos ?? { x: 0, y: 0, z: 0 };
    const selfPosRaw = snapshot.self.worldPos;
    const selfPos = isFiniteVec3(selfPosRaw)
      ? { x: selfPosRaw.x, y: selfPosRaw.y, z: selfPosRaw.z }
      : { ...fallbackPos };

    this.zoneId.set(normalizeZoneIdFromServer(snapshot.zoneId));
    this.selfCharacterId.set(snapshot.self.characterId);
    const spd = snapshot.self.movementSpeedUnitsPerSecond;
    this.playerMoveSpeed.set(
      typeof spd === 'number' && Number.isFinite(spd) && spd > 0 ? spd : 3,
    );
    this.player.set({
      characterId: snapshot.self.characterId,
      pos: selfPos,
      yaw: safeYaw(snapshot.self.worldFacingYaw, prevPlayer?.yaw ?? 0),
    });
    const others = new Map<string, OtherPlayerEntityState>();
    for (const o of snapshot.others ?? []) {
      if (!o?.characterId || !isFiniteVec3(o.worldPos)) {
        continue;
      }
      others.set(o.characterId, this.mapOther(o));
    }
    this.otherPlayers.set(others);
    const next = new Map<string, MobEntityState>();
    for (const m of snapshot.mobs ?? []) {
      if (!m?.mobInstanceId || typeof m.mobTemplateKey !== 'string') {
        continue;
      }
      if (!isFiniteVec3(m.pos)) {
        const prevMob = this.mobs().get(m.mobInstanceId);
        if (prevMob) {
          next.set(m.mobInstanceId, {
            ...prevMob,
            mobLevel: safeMobLevel(m.mobLevel, prevMob.mobLevel),
            displayName: safeMobDisplayName(m.displayName, prevMob.displayName),
            visible: Boolean(m.isAlive),
            aiState: safeMobAiState(m.aiState),
            attackRange: safeAttackRange(m.attackRange, prevMob.attackRange),
          });
        }
        continue;
      }
      next.set(m.mobInstanceId, {
        mobInstanceId: m.mobInstanceId,
        mobTemplateKey: m.mobTemplateKey,
        displayName: safeMobDisplayName(m.displayName, m.mobTemplateKey),
        mobLevel: safeMobLevel(m.mobLevel),
        pos: { x: m.pos.x, y: m.pos.y, z: m.pos.z },
        yaw: safeYaw(m.worldFacingYaw),
        currentHp: typeof m.currentHp === 'number' && Number.isFinite(m.currentHp) ? m.currentHp : 0,
        maxHp: typeof m.maxHp === 'number' && Number.isFinite(m.maxHp) && m.maxHp > 0 ? m.maxHp : 1,
        visible: Boolean(m.isAlive),
        aiState: safeMobAiState(m.aiState),
        attackRange: safeAttackRange(m.attackRange),
      });
    }
    this.mobs.set(next);
    const npcMap = new Map<string, NpcEntityState>();
    for (const n of snapshot.npcs ?? []) {
      npcMap.set(n.npcInstanceId, this.mapNpc(n));
    }
    this.npcs.set(npcMap);
    const drops = new Map<string, WorldDropEntityState>();
    for (const d of snapshot.worldDrops ?? []) {
      drops.set(d.itemInstanceId, this.mapWorldDrop(d));
    }
    this.worldDrops.set(drops);
  }

  applyPlayerMoved(p: WsPlayerMovedPayload): void {
    if (!p?.characterId || !isFiniteVec3(p.worldPos)) {
      return;
    }
    const self = this.selfCharacterId();
    if (p.characterId === self) {
      const cur = this.player();
      this.player.set({
        characterId: p.characterId,
        pos: { x: p.worldPos.x, y: p.worldPos.y, z: p.worldPos.z },
        yaw: safeYaw(p.worldFacingYaw, cur?.yaw ?? 0),
      });
      return;
    }
    this.otherPlayers.update((prev) => {
      const next = new Map(prev);
      const cur = next.get(p.characterId);
      const name = p.displayName ?? cur?.name ?? 'Jugador';
      next.set(p.characterId, {
        characterId: p.characterId,
        name,
        pos: { x: p.worldPos.x, y: p.worldPos.y, z: p.worldPos.z },
        yaw: safeYaw(p.worldFacingYaw, cur?.yaw ?? 0),
        karmaFlag:
          p.karmaFlag ?? cur?.karmaFlag ?? 'WHITE',
        weaponPlusLevel:
          typeof p.weaponPlusLevel === 'number' && Number.isFinite(p.weaponPlusLevel)
            ? p.weaponPlusLevel
            : (cur?.weaponPlusLevel ?? 0),
        weaponEquipped:
          typeof p.weaponEquipped === 'boolean' ? p.weaponEquipped : (cur?.weaponEquipped ?? false),
      });
      return next;
    });
  }

  applyPlayerVisualState(p: WsPlayerVisualStatePayload): void {
    const self = this.selfCharacterId();
    if (p.characterId === self) {
      return;
    }
    this.otherPlayers.update((prev) => {
      const cur = prev.get(p.characterId);
      if (!cur) {
        return prev;
      }
      const next = new Map(prev);
      next.set(p.characterId, {
        ...cur,
        karmaFlag: p.karmaFlag,
        weaponPlusLevel: p.weaponPlusLevel,
        weaponEquipped:
          typeof p.weaponEquipped === 'boolean' ? p.weaponEquipped : cur.weaponEquipped,
      });
      return next;
    });
  }

  applyPositionCorrected(p: WsPlayerPositionCorrectedPayload): void {
    const cur = this.player();
    if (!cur || !isFiniteVec3(p.worldPos)) {
      return;
    }
    this.player.set({
      ...cur,
      pos: { x: p.worldPos.x, y: p.worldPos.y, z: p.worldPos.z },
      yaw: safeYaw(p.worldFacingYaw, cur.yaw),
    });
  }

  applyAttackResult(p: WsAttackMobResultPayload): void {
    this.mobs.update((prev) => {
      const cur = prev.get(p.mobInstanceId);
      if (!cur) {
        return prev;
      }
      const next = new Map(prev);
      next.set(p.mobInstanceId, {
        ...cur,
        currentHp: p.mobHpAfter,
        visible: !p.mobKilled,
      });
      return next;
    });
  }

  /** Muerte instantánea (mismo frame que el último hit); idempotente con `applyAttackResult`. */
  applyMobDeath(p: WsMobDeathPayload): void {
    if (!p?.mobInstanceId) {
      return;
    }
    this.mobs.update((prev) => {
      const cur = prev.get(p.mobInstanceId);
      if (!cur) {
        return prev;
      }
      const next = new Map(prev);
      next.set(p.mobInstanceId, {
        ...cur,
        currentHp: 0,
        visible: false,
      });
      return next;
    });
  }

  applyMobRespawn(p: WsMobRespawnPayload): void {
    if (!p?.mobInstanceId || !isFiniteVec3(p.pos)) {
      return;
    }
    this.mobs.update((prev) => {
      const next = new Map(prev);
      const cur = prev.get(p.mobInstanceId);
      next.set(p.mobInstanceId, {
        mobInstanceId: p.mobInstanceId,
        mobTemplateKey: p.mobTemplateKey,
        displayName: safeMobDisplayName(p.displayName, cur?.displayName ?? p.mobTemplateKey),
        mobLevel: safeMobLevel(p.mobLevel),
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
        yaw: safeYaw(p.worldFacingYaw),
        currentHp:
          typeof p.currentHp === 'number' && Number.isFinite(p.currentHp) ? p.currentHp : 0,
        maxHp: typeof p.maxHp === 'number' && Number.isFinite(p.maxHp) && p.maxHp > 0 ? p.maxHp : 1,
        visible: true,
        aiState: safeMobAiState(p.aiState),
        attackRange: safeAttackRange(p.attackRange),
      });
      return next;
    });
  }

  applyMobMoved(p: WsMobMovedPayload): void {
    if (!p?.mobInstanceId || !isFiniteVec3(p.pos)) {
      return;
    }
    this.mobs.update((prev) => {
      const cur = prev.get(p.mobInstanceId);
      if (!cur) {
        return prev;
      }
      const next = new Map(prev);
      next.set(p.mobInstanceId, {
        ...cur,
        pos: { x: p.pos.x, y: p.pos.y, z: p.pos.z },
        yaw: safeYaw(p.worldFacingYaw, cur.yaw),
        currentHp:
          typeof p.currentHp === 'number' && Number.isFinite(p.currentHp) ? p.currentHp : cur.currentHp,
        maxHp:
          typeof p.maxHp === 'number' && Number.isFinite(p.maxHp) && p.maxHp > 0 ? p.maxHp : cur.maxHp,
        aiState: safeMobAiState(p.aiState),
      });
      return next;
    });
  }

  applyWorldDropSpawn(p: WsWorldDropSpawnPayload): void {
    this.worldDrops.update((prev) => {
      const next = new Map(prev);
      next.set(p.itemInstanceId, {
        itemInstanceId: p.itemInstanceId,
        catalogKey: p.catalogKey,
        itemName: p.itemDisplayName,
        icon: p.icon,
        grade: p.grade ?? 'None',
        quantity: p.quantity,
        pos: { ...p.pos },
        reservedForCharacterId: p.reservedForCharacterId,
        reservedUntilEpochMs: p.reservedUntilEpochMs,
      });
      return next;
    });
  }

  applyWorldDropRemoved(itemInstanceId: string): void {
    this.worldDrops.update((prev) => {
      if (!prev.has(itemInstanceId)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(itemInstanceId);
      return next;
    });
  }

  reset(): void {
    this.zoneId.set(null);
    this.selfCharacterId.set(null);
    this.playerMoveSpeed.set(3);
    this.player.set(null);
    this.otherPlayers.set(new Map());
    this.mobs.set(new Map());
    this.npcs.set(new Map());
    this.worldDrops.set(new Map());
  }

  private mapOther(o: WsOtherPlayerSnapshot): OtherPlayerEntityState {
    const pos = isFiniteVec3(o.worldPos) ? { x: o.worldPos.x, y: o.worldPos.y, z: o.worldPos.z } : { x: 0, y: 0, z: 0 };
    return {
      characterId: o.characterId,
      name: o.name,
      pos,
      yaw: safeYaw(o.worldFacingYaw),
      karmaFlag: o.karmaFlag ?? 'WHITE',
      weaponPlusLevel:
        typeof o.weaponPlusLevel === 'number' && Number.isFinite(o.weaponPlusLevel)
          ? o.weaponPlusLevel
          : 0,
      weaponEquipped: o.weaponEquipped === true,
    };
  }

  private mapNpc(n: WsZoneNpcSnapshot): NpcEntityState {
    return {
      npcInstanceId: n.npcInstanceId,
      npcTemplateKey: n.npcTemplateKey,
      displayName: n.displayName,
      npcRole: n.npcRole === 'MERCHANT' ? 'MERCHANT' : 'GENERIC',
      pos: { ...n.pos },
    };
  }

  private mapWorldDrop(d: WsWorldDropSnapshot): WorldDropEntityState {
    return {
      itemInstanceId: d.itemInstanceId,
      catalogKey: d.catalogKey,
      itemName: d.itemName,
      icon: d.icon,
      grade: d.grade ?? 'None',
      quantity: d.quantity,
      pos: { ...d.pos },
      reservedForCharacterId: d.reservedForCharacterId,
      reservedUntilEpochMs: d.reservedUntilEpochMs,
    };
  }
}
