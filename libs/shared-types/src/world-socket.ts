/**
 * Contrato Weaver ↔ Warden para eventos de mundo / combate en tiempo real.
 * SSOT único: el servidor lo consume como paquete (`@aetheris/shared-types`) y el
 * cliente Angular desde estas fuentes. No crear espejos por app.
 */

import type { CharacterSheetDto, InventoryItemRowDto } from './inventory-api';

export const WS_WORLD_NAMESPACE = '/world' as const;

export const WS_WORLD_EVENTS = {
  /** Servidor → cliente (solo al conectado): estado inicial de la zona para render */
  ZONE_SNAPSHOT: 'zone-snapshot',
  /** Cliente → servidor: intención de ataque PvE */
  ATTACK_MOB: 'attack-mob',
  ATTACK_PLAYER: 'attack-player',
  /** Cliente → servidor: intención de castear una skill activa sobre target. */
  CAST_SKILL: 'cast-skill',
  /** Cliente → servidor: fijar o limpiar objetivo de auto-ataque (mob UUID o null). */
  COMBAT_TARGET: 'combat-target',
  /** Servidor → socket: resultado de fijar objetivo. */
  COMBAT_TARGET_RESULT: 'combat-target-result',
  /** Sala zone:* : resultado autoritativo del ataque */
  ATTACK_MOB_RESULT: 'attack-mob-result',
  ATTACK_PLAYER_RESULT: 'attack-player-result',
  /** Sala zone:* : resultado autoritativo de skill activa. */
  SKILL_HIT_RESULT: 'skill-hit-result',
  /** Sala zone:* : muerte instantánea en RAM (FX / sync; loot sigue en `attack-mob-rewards`). */
  MOB_DEATH: 'mob-death',
  /** Solo al asesino: loot/exp (no va a la sala completa). */
  ATTACK_MOB_REWARDS: 'attack-mob-rewards',
  /** Solo al socket que atacó si la validación falla */
  ATTACK_MOB_DENIED: 'attack-mob-denied',
  /** Sala zone:* : mob reapareció tras respawn */
  MOB_RESPAWN: 'mob-respawn',
  MOB_MOVED: 'mob-moved',
  /** Sala zone:* : swing melee autoritativo del mob (Weaver: clip de ataque). */
  MOB_MELEE_RESULT: 'mob-melee-result',
  /**
   * Cliente → servidor: equipar ítem (misma validación que HTTP).
   * Respuesta vía **ack** de Socket.IO (valor de retorno del handler Nest).
   */
  EQUIP_ITEM: 'equip-item',
  /**
   * Cliente → servidor: desequipar ítem.
   * Respuesta vía **ack** de Socket.IO.
   */
  UNEQUIP_ITEM: 'unequip-item',
  /** Cliente → servidor: recoger botín del suelo (autoritativo). Ack con ficha actualizada. */
  PICK_ITEM: 'pick-item',
  /** Cliente -> servidor: pedir previsualización de drop para mob seleccionado (ack). */
  GET_MOB_DROP_PREVIEW: 'get-mob-drop-preview',
  /** Sala zone:* : apareció un drop en el suelo. */
  WORLD_DROP_SPAWN: 'world-drop-spawn',
  /** Sala zone:* : un drop fue recogido o dejó de existir. */
  WORLD_DROP_REMOVED: 'world-drop-removed',
  /** Cliente → servidor: muestra de posición / intención de movimiento (validada) */
  PLAYER_MOVE: 'player-move',
  /** Sala zone:* : jugador se movió (autoritativo) */
  PLAYER_MOVED: 'player-moved',
  /** Sala zone:* : actualización visual de flag/arma para nombre y glow. */
  PLAYER_VISUAL_STATE: 'player-visual-state',
  /** Solo al socket: reposición al último punto válido (anti-cheat / teleport) */
  PLAYER_POSITION_CORRECTED: 'player-position-corrected',
  /** Servidor → socket del personaje: HP / maxHP (post-equip, combate futuro, etc.) */
  PLAYER_VITALS: 'player-vitals',
  /** Servidor -> socket del personaje: refresh atómico de stats derivados + vitals. */
  PLAYER_STATS_UPDATE: 'player-stats-update',
  /** Servidor -> socket: penalización por grado de equipo activo/inactivo. */
  GRADE_PENALTY_STATUS: 'grade-penalty-status',
  /**
   * Sala zone:* : el personaje murió y queda en HP 0. NO hay reposición automática:
   * el Weaver muestra la pantalla de muerte y el cliente debe enviar `REQUEST_RESPAWN`.
   */
  PLAYER_DEATH: 'player-death',
  /** Cliente → servidor: intención de resucitar (ack). Solo válida si el personaje está muerto. */
  REQUEST_RESPAWN: 'request-respawn',
  /** Sala zone:* : el personaje revivió en el `entrySpawn` de su zona destino. */
  PLAYER_RESPAWN: 'player-respawn',
  LEVEL_UP: 'level-up',
  /** Cliente → servidor: abrir tienda de mercader (ack con ofertas). */
  OPEN_MERCHANT_STORE: 'open-merchant-store',
  /**
   * Alias legado (compat): mantiene clientes viejos durante migración.
   * Nuevo código debe usar `OPEN_MERCHANT_STORE`.
   */
  NPC_INTERACT: 'npc-interact',
  /** Cliente → servidor: comprar al NPC (ack con inventario + adena). */
  BUY_ITEM: 'buy-item',
  /** Cliente → servidor: vender al NPC (ack con inventario + adena). */
  SELL_ITEM: 'sell-item',
  /** Cliente → servidor: el jugador cerró la UI de tienda (telemetría / futuro estado). */
  NPC_CLOSE_INTERACT: 'npc-close-interact',
  /** Cliente → servidor: usar consumible del inventario (ack). */
  USE_ITEM: 'use-item',
  /** Sala zone:* : feedback de curación por consumible (texto flotante / FX). */
  PLAYER_CONSUMABLE_HEAL: 'player-consumable-heal',
  /** Cliente -> servidor: gastar puntos de atributo disponibles. */
  DISTRIBUTE_STAT: 'distribute-stat',
  /** Cliente -> servidor: intención de síntesis 2x1 (Ledger autoritativo). */
  REQUEST_SYNTHESIS: 'REQUEST_SYNTHESIS',
  /** Cliente -> servidor: quote previa de síntesis (costo/chance/pity). */
  REQUEST_SYNTHESIS_QUOTE: 'REQUEST_SYNTHESIS_QUOTE',
  /** Cliente → servidor: usar portal (validación de rango y nivel en Warden). */
  PORTAL_TRAVEL: 'portal-travel',
  /** Solo al socket: portal rechazado (nivel, rango, config). */
  PORTAL_TRAVEL_DENIED: 'portal-travel-denied',
  /** Sala zone:* : un jugador salió de la zona hacia otra instancia. */
  PLAYER_LEFT_ZONE: 'player-left-zone',
  /**
   * Cliente → servidor (solo `Character.isAdmin`): intención GM local para QA.
   * Respuesta vía ack Socket.IO; el Warden valida permisos — nunca aplicar stats desde UI sin ACK.
   */
  EXECUTE_GM_COMMAND: 'execute-gm-command',
} as const;

export type WsMobAiState = 'IDLE' | 'PATROL' | 'CHASE';

export type WsZoneMobSnapshot = {
  mobInstanceId: string;
  mobTemplateKey: string;
  /** Nombre de UI (mobs.json `displayName`). No usar `templateKey` en HUD. */
  displayName: string;
  /** Nivel PvE autoritativo (mobs.json / Warden). */
  mobLevel: number;
  pos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  currentHp: number;
  maxHp: number;
  isAlive: boolean;
  aiState: WsMobAiState;
  /** Alcance melee del template (Warden). El Weaver lo usa sólo para gating visual. */
  attackRange: number;
};

export type WsZoneNpcSnapshot = {
  npcInstanceId: string;
  npcTemplateKey: string;
  displayName: string;
  npcRole: 'MERCHANT' | 'GENERIC';
  pos: { x: number; y: number; z: number };
};

export type WsOtherPlayerSnapshot = {
  characterId: string;
  name: string;
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  karmaFlag?: WsKarmaFlag;
  weaponPlusLevel?: number;
  /** True si hay un ítem en el slot WEAPON; el Weaver elige mesh horneado vs paperdoll. */
  weaponEquipped?: boolean;
};

export type WsKarmaFlag = 'WHITE' | 'PURPLE' | 'RED';

export type WsZoneSnapshotPayload = {
  zoneId: string;
  self: {
    characterId: string;
    worldPos: { x: number; y: number; z: number };
    worldFacingYaw: number;
    /** Unidades/s en XZ para predicción cliente (misma fórmula que el Warden). */
    movementSpeedUnitsPerSecond: number;
    currentHp: number;
    maxHp: number;
    currentMp: number;
    maxMp: number;
  };
  others: WsOtherPlayerSnapshot[];
  mobs: WsZoneMobSnapshot[];
  /** Instancias NPC estáticas en la zona (Weaver: mesh + interacción). */
  npcs: WsZoneNpcSnapshot[];
  /** Instancias WORLD_DROP visibles en esta zona. */
  worldDrops: WsWorldDropSnapshot[];
};

export type WsPlayerVitalsPayload = {
  characterId: string;
  currentHp: number;
  maxHp: number;
  currentMp?: number;
  maxMp?: number;
};

export type WsPlayerStatsUpdatePayload = {
  characterId: string;
  derived: {
    pAtk: number;
    mAtk: number;
    pDef: number;
    atkSpeed: number;
    critRate: number;
  };
  vitals: {
    currentHp: number;
    maxHp: number;
  };
};

export type WsGradePenaltyStatusPayload = {
  active: boolean;
};

export type WsLevelUpPayload = {
  characterId: string;
  newLevel: number;
  experience: number;
  experienceRequiredForNext: number;
  availableStatPoints: number;
  currentHp: number;
  maxHp: number;
};

/**
 * Muerte autoritativa. El personaje NO se mueve al morir: `worldPos` es el punto de caída
 * (cadáver / cámara de muerte) y `currentHp` es siempre 0 hasta que llegue `REQUEST_RESPAWN`.
 */
export type WsPlayerDeathPayload = {
  characterId: string;
  displayName?: string;
  experienceLost: number;
  newExperience: number;
  /** Punto de caída, no de respawn. */
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  /** Siempre 0 mientras el personaje esté muerto. */
  currentHp: number;
  maxHp: number;
  /** Destino que aplicará el Warden al resucitar (`entrySpawn` de `world-zones.json`). */
  respawnZoneId: string;
  respawnWorldPos: { x: number; y: number; z: number };
};

/** Resurrección autoritativa tras `REQUEST_RESPAWN`. */
export type WsPlayerRespawnPayload = {
  characterId: string;
  displayName?: string;
  /** Zona destino ya aplicada en `Character.currentZoneId`. */
  zoneId: string;
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  currentHp: number;
  maxHp: number;
};

export type WsRequestRespawnAckPayload =
  | {
      ok: true;
      zoneId: string;
      worldPos: { x: number; y: number; z: number };
      worldFacingYaw: number;
      currentHp: number;
      maxHp: number;
      /** `true` si el respawn cambió de zona (el Weaver ya recibió `ZONE_SNAPSHOT`). */
      zoneChanged: boolean;
    }
  | { ok: false; code: string; message: string };

export type WsExecuteGmCommandClientPayload = {
  command: string;
  args?: string[];
};

export type WsExecuteGmCommandAckPayload =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type WsPortalTravelClientPayload = {
  portalId: string;
};

export type WsPortalTravelDeniedPayload = {
  code?: string;
  message: string;
};

export type WsPlayerLeftZonePayload = {
  characterId: string;
};

export type WsPlayerMoveClientPayload = {
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw?: number;
};

export type WsPlayerMovedPayload = {
  characterId: string;
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  /** Presente al spawn en zona o si el servidor lo incluye en broadcast. */
  displayName?: string;
  karmaFlag?: WsKarmaFlag;
  weaponPlusLevel?: number;
  weaponEquipped?: boolean;
};

export type WsPlayerVisualStatePayload = {
  characterId: string;
  karmaFlag: WsKarmaFlag;
  weaponPlusLevel: number;
  /** Ausente en broadcasts viejos (p. ej. PvP); el cliente conserva el valor previo. */
  weaponEquipped?: boolean;
};

export type WsPlayerPositionCorrectedPayload = {
  worldPos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  reason: string;
};

export type WsAttackMobClientPayload = {
  mobInstanceId: string;
  /** Yaw en radianes (plano XZ); servidor lo persiste como facing autoritativo del personaje. */
  attackerFacingYaw?: number;
};

export type WsAttackPlayerClientPayload = {
  targetCharacterId: string;
  attackerFacingYaw?: number;
};

export type WsCastSkillClientPayload = {
  skillId: string;
  targetId: string;
};

export type WsCombatTargetClientPayload = {
  mobInstanceId: string | null;
};

export type WsCombatTargetResultPayload = {
  ok: boolean;
  mobInstanceId: string | null;
  code?: string;
  message?: string;
};

export type WsAttackMobResultPayload = {
  attackerCharacterId: string;
  mobInstanceId: string;
  damage: number;
  critical: boolean;
  backstab: boolean;
  mobKilled: boolean;
  mobHpAfter: number;
  mobTemplateKey?: string;
};

export type WsAttackPlayerResultPayload = {
  attackerCharacterId: string;
  targetCharacterId: string;
  damage: number;
  critical: boolean;
  targetHpAfter: number;
  targetKilled: boolean;
};

export type WsSkillHitResultPayload = {
  attackerCharacterId: string;
  targetId: string;
  skillId: string;
  skillName: string;
  damage: number;
  critical: boolean;
  backstab: boolean;
  targetKilled: boolean;
  targetHpAfter: number;
  manaCost: number;
  mpAfter: number;
};

export type WsAttackMobRewardsPayload = {
  mobInstanceId: string;
  experienceGained: number;
  adenaGranted: string;
  itemInstanceIds: string[];
  levelsGained: number;
  level: number;
  experience: number;
  experienceRequiredForNext: number;
  /** Eco del servidor; la sala también recibe `WORLD_DROP_SPAWN`. */
  worldDropSpawns?: WsWorldDropSpawnPayload[];
};

/** Muerte optimista (cliente): mismo tick visual que el último `attack-mob-result` con kill. */
export type WsMobDeathPayload = {
  mobInstanceId: string;
  killerCharacterId: string;
  mobTemplateKey: string;
  pos: { x: number; y: number; z: number };
};

export type WsAttackMobDeniedPayload = {
  code: string;
  message: string;
};

export type WsMobRespawnPayload = {
  mobInstanceId: string;
  mobTemplateKey: string;
  /** Nombre de UI; opcional por compatibilidad con payloads viejos. */
  displayName?: string;
  mobLevel: number;
  currentHp: number;
  maxHp: number;
  pos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  aiState: WsMobAiState;
  /** Alcance melee del template; opcional por compatibilidad con payloads viejos. */
  attackRange?: number;
};

export type WsMobMovedPayload = {
  mobInstanceId: string;
  pos: { x: number; y: number; z: number };
  worldFacingYaw: number;
  aiState: WsMobAiState;
  currentHp: number;
  maxHp: number;
};

/** Swing melee PvE del mob; el daño ya se aplicó en el Warden. */
export type WsMobMeleeResultPayload = {
  mobInstanceId: string;
  targetCharacterId: string;
  damage: number;
};

export type WsWorldDropSnapshot = {
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

export type WsWorldDropSpawnPayload = {
  itemInstanceId: string;
  catalogKey: string | null;
  itemDisplayName: string;
  icon: string;
  grade: 'None' | 'D' | 'C' | 'B' | 'A' | 'S';
  quantity: number;
  pos: { x: number; y: number; z: number };
  reservedForCharacterId: string | null;
  reservedUntilEpochMs: number | null;
};

export type WsWorldDropRemovedPayload = {
  itemInstanceId: string;
};

export type WsPickItemClientPayload = {
  itemInstanceId: string;
};

export type WsGetMobDropPreviewClientPayload = {
  mobInstanceId: string;
};

export type WsMobDropPreviewItemPayload = {
  catalogKey: string;
  itemDisplayName: string;
  icon: string;
  grade: 'None' | 'D' | 'C' | 'B' | 'A' | 'S';
  chance: number;
};

export type WsGetMobDropPreviewAckPayload =
  | {
      ok: true;
      mobInstanceId: string;
      mobTemplateKey: string;
      mobLevel: number;
      levelPenaltyActive: boolean;
      items: WsMobDropPreviewItemPayload[];
    }
  | { ok: false; code: string; message: string };

export type WsPickItemAckPayload =
  | {
      ok: true;
      character: CharacterSheetDto;
      items: InventoryItemRowDto[];
      adena: string;
      pickedItemDisplayName: string;
      pickedQuantity: number;
    }
  | { ok: false; code: string; message: string };

export type WsEquipItemClientPayload = {
  itemId: string;
  slot: string | number;
  parentItemId?: string;
};

export type WsUnequipItemClientPayload = {
  itemId: string;
};

/** Payload de ack tras `EQUIP_ITEM`. */
export type WsEquipItemAckPayload =
  | {
      ok: true;
      equippedItemId: string;
      gearSlot: string | null;
      displacedItemId: string | null;
      parentItemId?: string | null;
      parentSubSlotIndex?: number | null;
      character: CharacterSheetDto;
    }
  | { ok: false; code: string; message: string };

/** Payload de ack tras `UNEQUIP_ITEM`. */
export type WsUnequipItemAckPayload =
  | {
      ok: true;
      unequippedItemId: string;
      previousGearSlot: string | null;
      character: CharacterSheetDto;
    }
  | { ok: false; code: string; message: string };

export type WsOpenMerchantStoreClientPayload = {
  npcInstanceId: string;
};

export type WsNpcInteractClientPayload = {
  npcInstanceId: string;
};

export type WsNpcShopOfferDto = {
  catalogKey: string;
  itemDisplayName: string;
  buyPriceAdena: string;
  /** Precio unitario al vender al NPC (típico: ⌊compra/3⌋). */
  sellPriceAdena: string;
};

export type WsNpcInteractAckPayload =
  | {
      ok: true;
      npcInstanceId: string;
      displayName: string;
      npcTemplateKey: string;
      offers: WsNpcShopOfferDto[];
    }
  | { ok: false; code: string; message: string };

export type WsBuyItemClientPayload = {
  npcInstanceId: string;
  catalogKey: string;
  quantity?: number;
};

export type WsSellItemClientPayload = {
  npcInstanceId: string;
  itemInstanceId: string;
  quantity?: number;
};

export type WsShopTxnAckPayload =
  | {
      ok: true;
      character: CharacterSheetDto;
      items: InventoryItemRowDto[];
      adena: string;
    }
  | { ok: false; code: string; message: string };

export type WsUseItemClientPayload = {
  itemInstanceId: string;
};

export type WsUseItemAckPayload =
  | {
      ok: true;
      character: CharacterSheetDto;
      items: InventoryItemRowDto[];
      adena: string;
      hpRestored: number;
    }
  | { ok: false; code: string; message: string };

export type WsDistributeStatClientPayload = {
  statName: 'STR' | 'AGI' | 'VIT' | 'ENE';
  amount: number;
};

export type WsDistributeStatAckPayload =
  | {
      ok: true;
      character: CharacterSheetDto;
    }
  | { ok: false; code: string; message: string };

/** Broadcast zona: curación efectiva (Weaver: +N HP flotante). */
export type WsPlayerConsumableHealPayload = {
  characterId: string;
  hpRestored: number;
};

export type WsRequestSynthesisClientPayload = {
  itemAId: string;
  itemBId: string;
};

export type WsSynthesisQuoteAckPayload =
  | {
      ok: true;
      adenaCost: string;
      baseSuccessPercent: number;
      effectiveSuccessPercent: number;
      pityCount: number;
      pityMaxFails: number;
      pityBonusPerFailPercent: number;
    }
  | { ok: false; code: string; message: string };

export type WsRequestSynthesisAckPayload =
  | {
      ok: true;
      success: boolean;
      forcedByPity: boolean;
      newItemLevel: number;
      pityCount: number;
      adenaSpent: string;
      adenaAfter: string;
      baseSuccessPercent: number;
      effectiveSuccessPercent: number;
      pityMaxFails: number;
      pityBonusPerFailPercent: number;
      character: CharacterSheetDto;
      items: InventoryItemRowDto[];
      adena: string;
    }
  | { ok: false; code: string; message: string };
