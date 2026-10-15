import {
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  GearSlot,
  ItemInstanceLocation,
  Prisma,
  type Character,
} from '@prisma/client';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import {
  WS_WORLD_EVENTS,
  type WsAttackMobClientPayload,
  type WsAttackPlayerClientPayload,
  type WsAttackMobDeniedPayload,
  type WsAttackMobResultPayload,
  type WsBuyItemClientPayload,
  type WsCastSkillClientPayload,
  type WsCombatTargetClientPayload,
  type WsCombatTargetResultPayload,
  type WsDistributeStatAckPayload,
  type WsDistributeStatClientPayload,
  type WsEquipItemAckPayload,
  type WsEquipItemClientPayload,
  type WsGetMobDropPreviewAckPayload,
  type WsGetMobDropPreviewClientPayload,
  type WsRequestSynthesisAckPayload,
  type WsRequestSynthesisClientPayload,
  type WsSynthesisQuoteAckPayload,
  type WsNpcInteractAckPayload,
  type WsNpcInteractClientPayload,
  type WsOpenMerchantStoreClientPayload,
  type WsPlayerMoveClientPayload,
  type WsPlayerMovedPayload,
  type WsPlayerVisualStatePayload,
  type WsPlayerPositionCorrectedPayload,
  type WsPickItemAckPayload,
  type WsPickItemClientPayload,
  type WsLevelUpPayload,
  type WsPlayerStatsUpdatePayload,
  type WsPlayerVitalsPayload,
  type WsPlayerTargetVitalsPayload,
  type WsRequestPlayerTargetVitalsPayload,
  type WsSellItemClientPayload,
  type WsShopTxnAckPayload,
  type WsUnequipItemAckPayload,
  type WsUnequipItemClientPayload,
  type WsUseItemAckPayload,
  type WsUseItemClientPayload,
  type WsPlayerConsumableHealPayload,
  type WsWorldDropRemovedPayload,
  type WsWorldDropSnapshot,
  type WsZoneNpcSnapshot,
  type WsZoneSnapshotPayload,
  type WsPortalTravelClientPayload,
  type WsPortalTravelDeniedPayload,
  type WsPlayerLeftZonePayload,
  type WsPlayerDeathPayload,
  type WsPlayerRespawnPayload,
  type WsRequestRespawnAckPayload,
  type WsExecuteGmCommandAckPayload,
  type WsExecuteGmCommandClientPayload,
  type WsPartyInviteClientPayload,
  type WsPartyAcceptClientPayload,
  type WsPartyDeclineClientPayload,
  type WsPartyKickClientPayload,
  type WsPartyActionAckPayload,
  type WsPartyInviteReceivedPayload,
  type WsChatSendClientPayload,
  type WsChatSendAckPayload,
  type WsChatMessagePayload,
  CHAT_MESSAGE_MAX_LENGTH,
  type WsDungeonEnterRequestClientPayload,
  type WsDungeonRoomActionClientPayload,
  type WsDungeonSessionAckPayload,
} from '@aetheris/shared-types';
import type { CharacterRespawnResolution } from '../character/character.service';
import { CharacterService, isDeadHp } from '../character/character.service';
import { StatEngineService } from '../character/stat-engine.service';
import { CombatService } from '../combat/combat.service';
import { PenaltyManagerService } from '../combat/penalty-manager.service';
import { PlayerCombatRuntimeService } from '../combat/player-combat-runtime.service';
import { parseConsumableHealMeta } from '../inventory/consumable-template.util';
import {
  buildMobDropPreviewRows,
  collectDropCatalogKeysFromMobTable,
  type ItemTemplateDropRoll,
} from '../ledger/loot.service';
import {
  getMobLevelForTemplateKey,
  isGreyMobNoBenefitPenalty,
} from '../mob/mob-config.loaders';
import { buildCharacterSheetDto } from '../inventory/inventory-character-dto.util';
import { mapInventoryItemInstanceToRow } from '../inventory/inventory-item-row.mapper';
import { InventoryService } from '../inventory/inventory.service';
import { parseItemGradeFromBaseStats } from '../items/item-grade.util';
import { MobService } from '../mob/mob.service';
import { PrismaService } from '../prisma/prisma.service';
import { SynthesisService } from '../synthesis/synthesis.service';
import { toPlusLevelFromStoredSynthesisLevel } from '../synthesis/synthesis-level-normalizer';
import { WorldSpatialService } from './world-spatial.service';
import { WorldPresenceService } from './world-presence.service';
import { WorldDropService } from './world-drop.service';
import { NpcShopService } from './npc-shop.service';
import { WorldSocketBridgeService } from './world-socket-bridge.service';
import { GmCommandService } from '../gm/gm-command.service';
import { PartyService } from '../party/party.service';
import { StarterKitService } from '../items/starter-kit.service';
import { DungeonService } from '../dungeon/dungeon.service';
import { findMapPortalById } from '../combat/combat-config.loaders';
import { computeSwingCooldownMs } from '../combat/combat-timing.loaders';
import { getWorldZoneDefinition, clampAxisToPlayable } from './config/world-zones.loaders';
import { resolveRespawnTarget } from './config/world-spawn.loaders';
import {
  normalizeZoneId,
  prismaCharacterZoneFilter,
  prismaMobZoneFilter,
  prismaNpcZoneFilter,
  prismaWorldDropZoneFilter,
  zonesMatch,
} from './world-zone.util';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Anti-flood simple: un mensaje cada ~350ms por personaje, nada más sofisticado. */
const CHAT_MIN_GAP_MS = 350;

/**
 * Diagnóstico temporal (The Warden): con `WORLD_MOVEMENT_GOD_MODE=1` no se ejecuta
 * validateMovementIntent (SPEED_OR_TELEPORT / VERTICAL_TELEPORT / etc.); se acepta
 * cualquier posición finita que envíe el cliente. Quitar o desactivar en producción.
 */
function isWorldMovementGodMode(): boolean {
  const v = process.env.WORLD_MOVEMENT_GOD_MODE;
  return v === '1' || v === 'true';
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

@WebSocketGateway({
  namespace: '/world',
  cors: { origin: '*' },
})
export class WorldGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WorldGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly prisma: PrismaService,
    private readonly combat: CombatService,
    private readonly penaltyManager: PenaltyManagerService,
    private readonly spatial: WorldSpatialService,
    private readonly bridge: WorldSocketBridgeService,
    private readonly statEngine: StatEngineService,
    private readonly characterService: CharacterService,
    private readonly mobService: MobService,
    private readonly presence: WorldPresenceService,
    private readonly playerCombatRuntime: PlayerCombatRuntimeService,
    private readonly inventoryService: InventoryService,
    private readonly worldDropService: WorldDropService,
    private readonly npcShop: NpcShopService,
    private readonly synthesisService: SynthesisService,
    private readonly gmCommandService: GmCommandService,
    private readonly party: PartyService,
    private readonly starterKit: StarterKitService,
    private readonly dungeonService: DungeonService,
  ) {}

  afterInit(): void {
    this.bridge.setServer(this.server);
  }

  /**
   * Snapshot autoritativo de zona (mobs, NPC, drops, otros jugadores) para ZONE_SNAPSHOT / portales.
   */
  private async buildZoneSnapshotPayload(
    characterId: string,
    zoneId: string,
  ): Promise<{ snapshot: WsZoneSnapshotPayload; row: Character } | null> {
    const row = await this.prisma.character.findUnique({
      where: { id: characterId },
    });
    if (!row) {
      return null;
    }

    const zoneWhere = prismaMobZoneFilter(zoneId);
    const mobsInZone = await this.prisma.mobInstance.findMany({
      where: { isAlive: true, AND: [zoneWhere] },
      include: { template: true },
    });

    const npcZoneWhere = prismaNpcZoneFilter(zoneId);
    const npcsInZone = await this.prisma.npcInstance.findMany({
      where: { AND: [npcZoneWhere] },
    });

    const dropZoneWhere = prismaWorldDropZoneFilter(zoneId);
    const worldDropRows = await this.prisma.itemInstance.findMany({
      where: {
        location: ItemInstanceLocation.WORLD_DROP,
        AND: [dropZoneWhere],
      },
      include: { template: true },
    });

    const charZoneWhere = prismaCharacterZoneFilter(zoneId);
    // La fila de personaje persiste en la base incluso sin nadie jugándola: sin el
    // filtro de presencia, cualquier personaje que haya existido alguna vez en la
    // zona reaparece como "otro jugador" fantasma en TODO snapshot nuevo (recarga
    // de página, portal, reconexión), sin importar si su socket sigue conectado.
    const othersInZoneRows = await this.prisma.character.findMany({
      where: {
        AND: [charZoneWhere, { id: { not: characterId } }],
      },
      select: {
        id: true,
        name: true,
        worldPosX: true,
        worldPosY: true,
        worldPosZ: true,
        worldFacingYaw: true,
        karmaTier: true,
        items: {
          where: {
            location: ItemInstanceLocation.EQUIPPED,
            gearSlot: GearSlot.WEAPON,
          },
          select: { synthesisLevel: true },
          take: 1,
        },
      },
    });
    const othersInZone = othersInZoneRows.filter((c) => this.presence.isConnected(c.id));

    const moveSpeed = this.spatial.getEffectiveWorldMoveSpeed(row.derivedAtkSpeed);
    const vitals = await this.statEngine.getCombatVitals(characterId);
    const runtimeVitals = this.playerCombatRuntime.getRuntimeVitals(characterId);

    const npcs: WsZoneNpcSnapshot[] = npcsInZone.map((n) => ({
      npcInstanceId: n.id,
      npcTemplateKey: n.npcTemplateKey,
      displayName: n.displayName,
      npcRole: this.npcShop.isMerchantTemplate(n.npcTemplateKey) ? 'MERCHANT' : 'GENERIC',
      pos: { x: n.posX, y: n.posY, z: n.posZ },
    }));

    const worldDrops: WsWorldDropSnapshot[] = worldDropRows.map((d) => ({
      itemInstanceId: d.id,
      catalogKey: d.template.catalogKey ?? null,
      itemName: d.template.name,
      icon: d.template.icon,
      grade: parseItemGradeFromBaseStats(d.template.baseStats),
      quantity: d.quantity,
      pos: {
        x: d.worldDropPosX ?? 0,
        y: d.worldDropPosY ?? 0,
        z: d.worldDropPosZ ?? 0,
      },
      reservedForCharacterId: d.worldDropReservedForCharacterId,
      reservedUntilEpochMs: d.worldDropReservedUntil?.getTime() ?? null,
    }));

    const snapshot: WsZoneSnapshotPayload = {
      zoneId,
      self: {
        characterId,
        worldPos: {
          x: row.worldPosX,
          y: row.worldPosY,
          z: row.worldPosZ,
        },
        worldFacingYaw: row.worldFacingYaw,
        movementSpeedUnitsPerSecond: moveSpeed,
        currentHp: vitals.currentHp,
        maxHp: vitals.maxHp,
        currentMp: runtimeVitals?.currentMp ?? 0,
        maxMp: runtimeVitals?.maxMp ?? 0,
      },
      others: othersInZone.map((o) => ({
        characterId: o.id,
        name: o.name,
        worldPos: {
          x: o.worldPosX,
          y: o.worldPosY,
          z: o.worldPosZ,
        },
        worldFacingYaw: o.worldFacingYaw,
        karmaFlag: this.penaltyManager.getKarmaFlagFromTier(o.karmaTier),
        weaponEquipped: o.items.length > 0,
        weaponPlusLevel: toPlusLevelFromStoredSynthesisLevel(
          o.items[0]?.synthesisLevel ?? 1,
        ),
      })),
      mobs: mobsInZone.map((m) => ({
        mobInstanceId: m.id,
        mobTemplateKey: m.template.templateKey,
        displayName: m.template.displayName,
        mobLevel: getMobLevelForTemplateKey(m.template.templateKey),
        pos: { x: m.posX, y: m.posY, z: m.posZ },
        worldFacingYaw: m.worldFacingYaw,
        currentHp: m.currentHp,
        maxHp: m.template.maxHp,
        isAlive: m.isAlive,
        aiState: m.aiState as 'IDLE' | 'PATROL' | 'CHASE',
        attackRange: m.template.attackRange ?? 2.5,
      })),
      npcs,
      worldDrops,
    };

    return { snapshot, row };
  }

  private async resolveCharacterVisualState(
    characterId: string,
  ): Promise<WsPlayerVisualStatePayload | null> {
    const row = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: {
        id: true,
        karmaTier: true,
        items: {
          where: {
            location: ItemInstanceLocation.EQUIPPED,
            gearSlot: GearSlot.WEAPON,
          },
          select: { synthesisLevel: true },
          take: 1,
        },
      },
    });
    if (!row) {
      return null;
    }
    return {
      characterId: row.id,
      karmaFlag: this.penaltyManager.getKarmaFlagFromTier(row.karmaTier),
      weaponEquipped: row.items.length > 0,
      weaponPlusLevel: toPlusLevelFromStoredSynthesisLevel(
        row.items[0]?.synthesisLevel ?? 1,
      ),
    };
  }

  private async emitCharacterVisualState(characterId: string, zoneId: string): Promise<void> {
    const visual = await this.resolveCharacterVisualState(characterId);
    if (!visual) {
      return;
    }
    this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.PLAYER_VISUAL_STATE, visual);
    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.PLAYER_VISUAL_STATE, visual);
  }

  /**
   * Nunca dejar que un fallo (típicamente DB caída/pausada) escape como excepción no
   * capturada: Socket.io no la atrapa en un handler `async`, y una promesa rechazada sin
   * catch tumba **todo el proceso Node**, desconectando a todos los jugadores ya en juego
   * por el intento de conexión de uno solo.
   */
  async handleConnection(client: Socket): Promise<void> {
    try {
      await this.handleConnectionInternal(client);
    } catch (error) {
      this.logger.error(
        `handleConnection failed for socket ${client.id}: ${(error as Error)?.message ?? error}`,
        (error as Error)?.stack,
      );
      client.emit(WS_WORLD_EVENTS.ATTACK_MOB_DENIED, {
        code: 'SERVER_UNAVAILABLE',
        message: 'No se pudo establecer la conexión (servidor u origen de datos no disponible).',
      } satisfies WsAttackMobDeniedPayload);
      client.disconnect(true);
    }
  }

  private async handleConnectionInternal(client: Socket): Promise<void> {
    // Deliberadamente NO se lee `zoneId` del handshake: la zona autoritativa sale
    // siempre de `character.currentZoneId` en DB. Un cliente modificado podría
    // mandar cualquier zoneId para spawnear en zonas restringidas por nivel.
    const auth = client.handshake.auth as {
      characterId?: unknown;
    };

    if (!isUuid(auth.characterId)) {
      client.emit(WS_WORLD_EVENTS.ATTACK_MOB_DENIED, {
        code: 'AUTH_INVALID_CHARACTER',
        message: 'handshake.auth.characterId must be a valid UUID',
      } satisfies WsAttackMobDeniedPayload);
      client.disconnect(true);
      return;
    }

    const characterId = auth.characterId;
    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
    });

    if (!character) {
      client.emit(WS_WORLD_EVENTS.ATTACK_MOB_DENIED, {
        code: 'AUTH_CHARACTER_NOT_FOUND',
        message: 'Character does not exist',
      } satisfies WsAttackMobDeniedPayload);
      client.disconnect(true);
      return;
    }

    // Autoritativo: la última zona persistida por el propio servidor (muerte, portal, respawn).
    // El handshake del cliente no puede alterarla; sólo se normalizan alias legacy (`default`/null).
    const zoneId = normalizeZoneId(character.currentZoneId);
    if (zoneId !== character.currentZoneId) {
      await this.prisma.character.update({
        where: { id: characterId },
        data: { currentZoneId: zoneId },
      });
    }

    const room = this.bridge.zoneRoomId(zoneId);
    await client.join(room);

    client.data.characterId = characterId;
    client.data.characterName = character.name;
    client.data.zoneId = zoneId;
    client.data.lastMoveSampleAtMs = Date.now();

    this.presence.register(characterId);
    const vitalsState =
      await this.characterService.initializeCurrentHpIfUnset(characterId);
    await this.playerCombatRuntime.seedCharacterCombatState(characterId);

    // Reconexión con grupo ya formado: recuperar la sala y reenviar el estado actual
    // (si no, el panel de party quedaría vacío hasta el próximo cambio de membresía).
    const existingPartyId = this.party.getPartyIdForCharacter(characterId);
    if (existingPartyId) {
      await client.join(this.bridge.partyRoomId(existingPartyId));
      client.emit(WS_WORLD_EVENTS.PARTY_UPDATE, this.buildPartyUpdatePayload(existingPartyId));
    }

    const built = await this.buildZoneSnapshotPayload(characterId, zoneId);
    if (!built) {
      return;
    }

    client.emit(WS_WORLD_EVENTS.ZONE_SNAPSHOT, built.snapshot);

    // Reconexión estando muerto: re-emitir el estado de muerte para que el Weaver
    // vuelva a mostrar la pantalla de respawn en lugar de dejar un cadáver jugable.
    if (vitalsState.dead) {
      const target = resolveRespawnTarget(zoneId);
      client.emit(WS_WORLD_EVENTS.PLAYER_DEATH, {
        characterId,
        displayName: built.row.name,
        experienceLost: 0,
        newExperience: built.row.experience,
        worldPos: {
          x: built.row.worldPosX,
          y: built.row.worldPosY,
          z: built.row.worldPosZ,
        },
        worldFacingYaw: built.row.worldFacingYaw,
        currentHp: 0,
        maxHp: built.snapshot.self.maxHp,
        respawnZoneId: target.zoneId,
        respawnWorldPos: target.worldPos,
      } satisfies WsPlayerDeathPayload);
    }

    const visualState = await this.resolveCharacterVisualState(characterId);
    const spawnNotice: WsPlayerMovedPayload = {
      characterId,
      worldPos: {
        x: built.row.worldPosX,
        y: built.row.worldPosY,
        z: built.row.worldPosZ,
      },
      worldFacingYaw: built.row.worldFacingYaw,
      displayName: built.row.name,
      karmaFlag: visualState?.karmaFlag,
      weaponPlusLevel: visualState?.weaponPlusLevel,
      weaponEquipped: visualState?.weaponEquipped,
    };
    void client.to(room).emit(WS_WORLD_EVENTS.PLAYER_MOVED, spawnNotice);
    await this.emitCharacterVisualState(characterId, zoneId);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const id = client.data.characterId as string | undefined;
    if (id) {
      // Sin esto, un cierre de pestaña / corte de red (a diferencia de portal o respawn
      // a otra zona) nunca avisaba a la sala: el personaje quedaba parado como un
      // "fantasma" para todo el que ya estuviera conectado en esa zona.
      const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);
      this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.PLAYER_LEFT_ZONE, {
        characterId: id,
      } satisfies WsPlayerLeftZonePayload);
      await this.playerCombatRuntime.onCharacterDisconnect(id);
      this.presence.unregister(id);
      void this.mobService.clearAggroTargetingCharacter(id);
      // No tiene sentido dejar esperando una invitación a alguien que ya se fue.
      this.party.clearPendingInviteTo(id);
      this.lastChatSentAtMs.delete(id);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PLAYER_MOVE)
  async handlePlayerMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsPlayerMoveClientPayload,
  ): Promise<void> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return;
    }

    if (!body?.worldPos) {
      return;
    }

    const { x: rawX, y: rawY, z: rawZ } = body.worldPos;
    if (
      typeof rawX !== 'number' ||
      typeof rawY !== 'number' ||
      typeof rawZ !== 'number' ||
      ![rawX, rawY, rawZ].every((n) => Number.isFinite(n))
    ) {
      return;
    }

    const ch = await this.prisma.character.findUnique({
      where: { id: characterId },
    });
    if (!ch) {
      return;
    }

    // Un cadáver no se mueve: se ancla al punto de caída hasta `REQUEST_RESPAWN`.
    if (isDeadHp(ch.currentHp)) {
      client.emit(WS_WORLD_EVENTS.PLAYER_POSITION_CORRECTED, {
        worldPos: { x: ch.worldPosX, y: ch.worldPosY, z: ch.worldPosZ },
        worldFacingYaw: ch.worldFacingYaw,
        reason: 'CHARACTER_DEAD',
      } satisfies WsPlayerPositionCorrectedPayload);
      return;
    }

    const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);
    if (!zonesMatch(ch.currentZoneId, zoneId)) {
      client.emit(
        WS_WORLD_EVENTS.PLAYER_POSITION_CORRECTED,
        {
          worldPos: {
            x: ch.worldPosX,
            y: ch.worldPosY,
            z: ch.worldPosZ,
          },
          worldFacingYaw: ch.worldFacingYaw,
          reason: 'ZONE_MISMATCH',
        } satisfies WsPlayerPositionCorrectedPayload,
      );
      return;
    }

    const now = Date.now();

    if (!isWorldMovementGodMode()) {
      const lastAt =
        typeof client.data.lastMoveSampleAtMs === 'number'
          ? client.data.lastMoveSampleAtMs
          : now;
      const rawDtMs = Math.max(0, now - lastAt);
      const rapidPacketBypass = rawDtMs < 50;

      let dt = rawDtMs / 1000;
      const minDt = this.spatial.getMovementMinDtSeconds();
      const maxDt = this.spatial.getMovementMaxDtSeconds();
      dt = Math.max(minDt, Math.min(dt, maxDt));

      const from = {
        x: ch.worldPosX,
        y: ch.worldPosY,
        z: ch.worldPosZ,
      };
      const to = { x: rawX, y: rawY, z: rawZ };
      const maxSpeed = this.spatial.getEffectiveWorldMoveSpeed(ch.derivedAtkSpeed);

      const check = this.spatial.validateMovementIntent({
        from,
        to,
        dtSeconds: dt,
        maxSpeedUnitsPerSecond: maxSpeed,
        skipHorizontalSpeedCheck: rapidPacketBypass,
      });

      if (!check.accepted) {
        if (
          check.reason === 'SPEED_OR_TELEPORT' &&
          check.horizontalDistance !== undefined &&
          check.maxAllowedHorizontal !== undefined
        ) {
          this.logger.warn(
            `[Movement] Rejected: distance=${check.horizontalDistance}, maxAllowed=${check.maxAllowedHorizontal}`,
          );
        }
        client.emit(WS_WORLD_EVENTS.PLAYER_POSITION_CORRECTED, {
          worldPos: {
            x: ch.worldPosX,
            y: ch.worldPosY,
            z: ch.worldPosZ,
          },
          worldFacingYaw: ch.worldFacingYaw,
          reason: check.reason ?? 'MOVEMENT_REJECTED',
        } satisfies WsPlayerPositionCorrectedPayload);
        return;
      }
    }

    const from = {
      x: ch.worldPosX,
      y: ch.worldPosY,
      z: ch.worldPosZ,
    };
    const obstacleCheck = this.spatial.resolveMoveTargetAgainstObstacles({
      from,
      to: { x: rawX, y: rawY, z: rawZ },
      zoneId,
    });
    const x = clampAxisToPlayable(zoneId, obstacleCheck.corrected.x);
    const y = obstacleCheck.corrected.y;
    const z = clampAxisToPlayable(zoneId, obstacleCheck.corrected.z);
    if (obstacleCheck.blocked) {
      client.emit(WS_WORLD_EVENTS.PLAYER_POSITION_CORRECTED, {
        worldPos: { x, y, z },
        worldFacingYaw: ch.worldFacingYaw,
        reason: 'WORLD_COLLISION',
      } satisfies WsPlayerPositionCorrectedPayload);
      if (Math.hypot(x - from.x, z - from.z) < 1e-4) {
        return;
      }
    }

    const yaw =
      typeof body.worldFacingYaw === 'number' &&
      Number.isFinite(body.worldFacingYaw)
        ? body.worldFacingYaw
        : ch.worldFacingYaw;

    await this.prisma.character.update({
      where: { id: characterId },
      data: {
        worldPosX: x,
        worldPosY: y,
        worldPosZ: z,
        worldFacingYaw: yaw,
      },
    });

    client.data.lastMoveSampleAtMs = now;

    this.playerCombatRuntime.recordPoseFromMove(characterId, { x, y, z }, yaw, zoneId);

    const broadcast: WsPlayerMovedPayload = {
      characterId,
      worldPos: { x, y, z },
      worldFacingYaw: yaw,
      displayName: ch.name,
      karmaFlag: this.penaltyManager.getKarmaFlagFromTier(ch.karmaTier),
    };

    this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.PLAYER_MOVED, broadcast);
    /* Garantizar eco al socket del jugador: según adapter, to(room) puede no incluir al emisor y el cliente quedaría con authoritative desfasado → rubber-band al atacar / mover. */
    this.bridge.emitToCharacter(characterId, WS_WORLD_EVENTS.PLAYER_MOVED, broadcast);

    /* Debounce: cada move sample disparaba aggro sobre muchos MobInstance; competía con attackMob. */
    const lastAggro =
      typeof client.data.lastAggroAtMs === 'number' ? client.data.lastAggroAtMs : 0;
    if (now - lastAggro >= 350) {
      client.data.lastAggroAtMs = now;
      void this.mobService.updateAggroForPlayerPosition(zoneId, characterId, {
        x,
        y,
        z,
      });
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.COMBAT_TARGET)
  async handleCombatTarget(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsCombatTargetClientPayload,
  ): Promise<void> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return;
    }
    const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);

    if (body?.mobInstanceId === null) {
      await this.playerCombatRuntime.setCombatTarget(characterId, zoneId, null);
      client.emit(WS_WORLD_EVENTS.COMBAT_TARGET_RESULT, {
        ok: true,
        mobInstanceId: null,
      } satisfies WsCombatTargetResultPayload);
      return;
    }

    if (typeof body?.mobInstanceId !== 'string' || !isUuid(body.mobInstanceId)) {
      client.emit(WS_WORLD_EVENTS.COMBAT_TARGET_RESULT, {
        ok: false,
        mobInstanceId: null,
        code: 'INVALID_PAYLOAD',
        message: 'mobInstanceId must be a UUID or null',
      } satisfies WsCombatTargetResultPayload);
      return;
    }

    if (await this.isCharacterDead(characterId)) {
      client.emit(WS_WORLD_EVENTS.COMBAT_TARGET_RESULT, {
        ok: false,
        mobInstanceId: null,
        code: 'CHARACTER_DEAD',
        message: 'Estás muerto: pedí respawn antes de fijar objetivo',
      } satisfies WsCombatTargetResultPayload);
      return;
    }

    const r = await this.playerCombatRuntime.setCombatTarget(
      characterId,
      zoneId,
      body.mobInstanceId,
    );
    if (r.ok) {
      client.emit(WS_WORLD_EVENTS.COMBAT_TARGET_RESULT, {
        ok: true,
        mobInstanceId: body.mobInstanceId,
      } satisfies WsCombatTargetResultPayload);
    } else {
      client.emit(WS_WORLD_EVENTS.COMBAT_TARGET_RESULT, {
        ok: false,
        mobInstanceId: body.mobInstanceId,
        code: r.code,
        message: r.message,
      } satisfies WsCombatTargetResultPayload);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.EQUIP_ITEM)
  async handleEquipItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsEquipItemClientPayload,
  ): Promise<WsEquipItemAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || typeof body.itemId !== 'string' || !isUuid(body.itemId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'itemId (UUID) is required',
      };
    }
    if (typeof body.slot !== 'string' && typeof body.slot !== 'number') {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'slot is required',
      };
    }
    if (body.parentItemId !== undefined && !isUuid(body.parentItemId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'parentItemId must be a UUID',
      };
    }
    try {
      const result = await this.inventoryService.equipItem(
        characterId,
        body.itemId,
        body.slot,
        body.parentItemId,
      );
      const vitals = await this.statEngine.getCombatVitals(characterId);
      const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
      const character = buildCharacterSheetDto(
        result.character,
        vitals,
        this.statEngine,
        effectiveCore,
      );
      const payload: WsPlayerVitalsPayload = {
        characterId,
        currentHp: vitals.currentHp,
        maxHp: vitals.maxHp,
      };
      const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);
      this.bridge.emitPlayerVitals(payload, zoneId);
      await this.playerCombatRuntime.refreshDerivedStatsAfterEquipmentChange(characterId);
      await this.emitCharacterVisualState(characterId, zoneId);
      return {
        ok: true,
        equippedItemId: result.inventory.equippedItemId,
        gearSlot: result.inventory.gearSlot,
        displacedItemId: result.inventory.displacedItemId,
        parentItemId: result.inventory.parentItemId,
        parentSubSlotIndex: result.inventory.parentSubSlotIndex,
        character,
      };
    } catch (e) {
      return this.mapInventoryErrorToEquipAck(e);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.UNEQUIP_ITEM)
  async handleUnequipItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsUnequipItemClientPayload,
  ): Promise<WsUnequipItemAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || typeof body.itemId !== 'string' || !isUuid(body.itemId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'itemId (UUID) is required',
      };
    }
    try {
      const result = await this.inventoryService.unequipItem(characterId, body.itemId);
      const vitals = await this.statEngine.getCombatVitals(characterId);
      const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
      const character = buildCharacterSheetDto(
        result.character,
        vitals,
        this.statEngine,
        effectiveCore,
      );
      const payload: WsPlayerVitalsPayload = {
        characterId,
        currentHp: vitals.currentHp,
        maxHp: vitals.maxHp,
      };
      const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);
      this.bridge.emitPlayerVitals(payload, zoneId);
      await this.playerCombatRuntime.refreshDerivedStatsAfterEquipmentChange(characterId);
      await this.emitCharacterVisualState(characterId, zoneId);
      return {
        ok: true,
        unequippedItemId: result.inventory.unequippedItemId,
        previousGearSlot: result.inventory.previousGearSlot,
        character,
      };
    } catch (e) {
      return this.mapInventoryErrorToUnequipAck(e);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PICK_ITEM)
  async handlePickItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsPickItemClientPayload,
  ): Promise<WsPickItemAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || typeof body.itemInstanceId !== 'string' || !isUuid(body.itemInstanceId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'itemInstanceId (UUID) is required',
      };
    }

    const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);
    const result = await this.worldDropService.pickWorldDrop(characterId, body.itemInstanceId);
    if (!result.ok) {
      return result;
    }

    const vitals = result.vitals;
    const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
    const character = buildCharacterSheetDto(
      result.character,
      vitals,
      this.statEngine,
      effectiveCore,
    );
    const removed: WsWorldDropRemovedPayload = { itemInstanceId: body.itemInstanceId };
    this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.WORLD_DROP_REMOVED, removed);

    return {
      ok: true,
      character,
      items: result.itemRows,
      adena: result.adena,
      pickedItemDisplayName: result.pickedItemDisplayName,
      pickedQuantity: result.pickedQuantity,
    };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.GET_MOB_DROP_PREVIEW)
  async handleGetMobDropPreview(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsGetMobDropPreviewClientPayload,
  ): Promise<WsGetMobDropPreviewAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || typeof body.mobInstanceId !== 'string' || !isUuid(body.mobInstanceId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'mobInstanceId (UUID) is required',
      };
    }
    const [character, mob] = await Promise.all([
      this.prisma.character.findUnique({
        where: { id: characterId },
        select: { id: true, level: true, currentZoneId: true },
      }),
      this.prisma.mobInstance.findUnique({
        where: { id: body.mobInstanceId },
        include: { template: true },
      }),
    ]);
    if (!character) {
      return {
        ok: false,
        code: 'CHARACTER_NOT_FOUND',
        message: 'Character not found',
      };
    }
    if (!mob || !mob.isAlive) {
      return {
        ok: false,
        code: 'MOB_INVALID',
        message: 'Mob is not a valid living target',
      };
    }
    if (!zonesMatch(character.currentZoneId, mob.zoneId)) {
      return {
        ok: false,
        code: 'ZONE_MISMATCH',
        message: 'Character and mob are not in the same zone',
      };
    }

    const mobLevel = getMobLevelForTemplateKey(mob.template.templateKey);
    const levelPenaltyActive = isGreyMobNoBenefitPenalty(
      character.level,
      mobLevel,
    );
    const keys = collectDropCatalogKeysFromMobTable(mob.template.dropTable);
    const templates =
      keys.length === 0
        ? []
        : await this.prisma.itemTemplate.findMany({
            where: { catalogKey: { in: keys } },
            select: {
              id: true,
              catalogKey: true,
              name: true,
              icon: true,
              baseStats: true,
            },
          });
    const map = new Map<string, ItemTemplateDropRoll>();
    for (const t of templates) {
      if (!t.catalogKey) {
        continue;
      }
      map.set(t.catalogKey, {
        id: t.id,
        catalogKey: t.catalogKey,
        name: t.name,
        icon: t.icon,
        grade: parseItemGradeFromBaseStats(t.baseStats),
      });
    }
    const items = buildMobDropPreviewRows({
      dropTable: mob.template.dropTable,
      templatesByCatalog: map,
      levelPenaltyActive,
    });
    return {
      ok: true,
      mobInstanceId: mob.id,
      mobTemplateKey: mob.template.templateKey,
      mobLevel,
      levelPenaltyActive,
      items,
    };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.OPEN_MERCHANT_STORE)
  async handleOpenMerchantStore(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsOpenMerchantStoreClientPayload,
  ): Promise<WsNpcInteractAckPayload> {
    return this.handleNpcInteract(client, body);
  }

  @SubscribeMessage(WS_WORLD_EVENTS.NPC_INTERACT)
  async handleNpcInteract(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsNpcInteractClientPayload,
  ): Promise<WsNpcInteractAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || typeof body.npcInstanceId !== 'string' || !isUuid(body.npcInstanceId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'npcInstanceId (UUID) is required',
      };
    }
    return this.npcShop.previewNpcShop(characterId, body.npcInstanceId);
  }

  @SubscribeMessage(WS_WORLD_EVENTS.BUY_ITEM)
  async handleBuyItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsBuyItemClientPayload,
  ): Promise<WsShopTxnAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (
      !body ||
      typeof body.npcInstanceId !== 'string' ||
      !isUuid(body.npcInstanceId) ||
      typeof body.catalogKey !== 'string' ||
      body.catalogKey.length === 0
    ) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'npcInstanceId (UUID) and catalogKey are required',
      };
    }
    const qty =
      typeof body.quantity === 'number' && Number.isFinite(body.quantity)
        ? body.quantity
        : 1;
    const r = await this.npcShop.buyFromNpc({
      characterId,
      npcInstanceId: body.npcInstanceId,
      catalogKey: body.catalogKey,
      quantity: qty,
    });
    if (!r.ok) {
      return r;
    }
    const vitals = await this.statEngine.getCombatVitals(characterId);
    const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
    const character = buildCharacterSheetDto(
      r.character,
      vitals,
      this.statEngine,
      effectiveCore,
    );
    return {
      ok: true,
      character,
      items: r.items,
      adena: r.adena,
    };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.SELL_ITEM)
  async handleSellItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsSellItemClientPayload,
  ): Promise<WsShopTxnAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (
      !body ||
      typeof body.npcInstanceId !== 'string' ||
      !isUuid(body.npcInstanceId) ||
      typeof body.itemInstanceId !== 'string' ||
      !isUuid(body.itemInstanceId)
    ) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'npcInstanceId and itemInstanceId (UUID) are required',
      };
    }
    const qty =
      typeof body.quantity === 'number' && Number.isFinite(body.quantity)
        ? body.quantity
        : 1;
    const r = await this.npcShop.sellToNpc({
      characterId,
      npcInstanceId: body.npcInstanceId,
      itemInstanceId: body.itemInstanceId,
      quantity: qty,
    });
    if (!r.ok) {
      return r;
    }
    const vitals = await this.statEngine.getCombatVitals(characterId);
    const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
    const character = buildCharacterSheetDto(
      r.character,
      vitals,
      this.statEngine,
      effectiveCore,
    );
    return {
      ok: true,
      character,
      items: r.items,
      adena: r.adena,
    };
  }

  /** UI cerró la tienda; reservado para telemetría o estado server-side futuro. */
  @SubscribeMessage(WS_WORLD_EVENTS.NPC_CLOSE_INTERACT)
  handleNpcCloseInteract(@ConnectedSocket() client: Socket): void {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return;
    }
    this.logger.debug(`[Shop] NPC_CLOSE_INTERACT characterId=${characterId}`);
  }

  @SubscribeMessage(WS_WORLD_EVENTS.USE_ITEM)
  async handleUseItem(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsUseItemClientPayload,
  ): Promise<WsUseItemAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || typeof body.itemInstanceId !== 'string' || !isUuid(body.itemInstanceId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'itemInstanceId (UUID) is required',
      };
    }

    const cd = this.playerCombatRuntime.checkConsumableUseCooldown(characterId);
    if (!cd.ok) {
      return cd;
    }

    const item = await this.prisma.itemInstance.findUnique({
      where: { id: body.itemInstanceId },
      include: { template: true },
    });
    if (!item || item.ownerId !== characterId) {
      return {
        ok: false,
        code: 'ITEM_NOT_FOUND',
        message: 'Item not found or not owned by this character',
      };
    }
    const meta = parseConsumableHealMeta(item.template.baseStats);
    if (!meta) {
      return {
        ok: false,
        code: 'ITEM_NOT_CONSUMABLE_HEAL',
        message: 'Este ítem no es un consumible de curación usable',
      };
    }

    const canUse = await this.playerCombatRuntime.assertCanUseConsumable(characterId, meta);
    if (!canUse.ok) {
      return canUse;
    }

    try {
      const { character } = await this.inventoryService.consumeOneInventoryStack(
        characterId,
        body.itemInstanceId,
      );
      let hpRestored = 0;
      if (meta.healAmount > 0) {
        hpRestored = this.playerCombatRuntime.applyHealFromConsumable(
          characterId,
          meta.healAmount,
        ).actualHeal;
      }
      let mpRestored = 0;
      if (meta.manaAmount > 0) {
        mpRestored = this.playerCombatRuntime.applyManaRestoreFromConsumable(
          characterId,
          meta.manaAmount,
        ).actualRestore;
      }
      this.playerCombatRuntime.touchConsumableUseCooldown(characterId);
      const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);
      if (hpRestored > 0 || mpRestored > 0) {
        const healBroadcast: WsPlayerConsumableHealPayload = {
          characterId,
          hpRestored,
          mpRestored,
        };
        this.bridge.broadcastToZone(zoneId, WS_WORLD_EVENTS.PLAYER_CONSUMABLE_HEAL, healBroadcast);
      }

      const wallet = await this.prisma.wallet.findUnique({
        where: { accountId: character.accountId },
        select: { adena: true },
      });
      const adena = (wallet?.adena ?? 0n).toString();
      // `assertCanUseConsumable` ya sembró el estado de combate en RAM si hacía falta.
      const vitals = this.playerCombatRuntime.getRuntimeVitals(characterId);
      if (!vitals) {
        return { ok: false, code: 'NO_COMBAT_STATE', message: 'Personaje sin estado de combate' };
      }
      const characterDto = buildCharacterSheetDto(
        character,
        { currentHp: vitals.currentHp, maxHp: vitals.maxHp },
        this.statEngine,
        await this.statEngine.getEffectiveCoreStats(characterId),
      );
      const items = character.items.map((row) =>
        mapInventoryItemInstanceToRow(row, character.items),
      );
      return {
        ok: true,
        character: characterDto,
        items,
        adena,
        hpRestored,
        mpRestored,
      };
    } catch (e) {
      return this.mapInventoryErrorToUseItemAck(e);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.ATTACK_MOB)
  async handleAttackMob(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsAttackMobClientPayload,
  ): Promise<void> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      this.emitDenied(client, {
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      });
      return;
    }

    if (!body || !isUuid(body.mobInstanceId)) {
      this.emitDenied(client, {
        code: 'INVALID_PAYLOAD',
        message: 'mobInstanceId (UUID) is required',
      });
      return;
    }

    if (await this.isCharacterDead(characterId)) {
      this.emitDenied(client, {
        code: 'CHARACTER_DEAD',
        message: 'Estás muerto: pedí respawn antes de atacar',
      });
      return;
    }

    try {
      if (
        typeof body.attackerFacingYaw === 'number' &&
        Number.isFinite(body.attackerFacingYaw)
      ) {
        await this.prisma.character.update({
          where: { id: characterId },
          data: { worldFacingYaw: body.attackerFacingYaw },
        });
      }

      const character = await this.prisma.character.findUnique({
        where: { id: characterId },
      });
      if (!character) {
        throw new NotFoundException(`Character not found: ${characterId}`);
      }

      const mob = await this.prisma.mobInstance.findUnique({
        where: { id: body.mobInstanceId },
        include: { template: true },
      });
      if (!mob) {
        throw new NotFoundException(
          `MobInstance not found: ${body.mobInstanceId}`,
        );
      }

      if (!zonesMatch(character.currentZoneId, mob.zoneId)) {
        throw new BadRequestException({
          code: 'ZONE_MISMATCH',
          message: 'Character and mob are not in the same zone',
        });
      }

      const backstab = this.spatial.isBackstabFromRearCone({
        targetForwardYaw: mob.worldFacingYaw,
        targetPosition: { x: mob.posX, y: mob.posY, z: mob.posZ },
        attackerPosition: {
          x: character.worldPosX,
          y: character.worldPosY,
          z: character.worldPosZ,
        },
      });
      const facingMult = backstab
        ? this.spatial.getBackstabDamageMultiplier()
        : 1;

      const result = await this.combat.attackMob(characterId, body.mobInstanceId, {
        facingDamageMultiplier: facingMult,
      });

      const broadcast: WsAttackMobResultPayload = {
        attackerCharacterId: characterId,
        mobInstanceId: body.mobInstanceId,
        damage: result.damage,
        critical: result.critical,
        backstab,
        mobKilled: result.mobKilled,
        mobHpAfter: result.mobHpAfter,
        mobTemplateKey: result.mobTemplateKey,
      };

      this.bridge.broadcastToZone(
        mob.zoneId ?? character.currentZoneId,
        WS_WORLD_EVENTS.ATTACK_MOB_RESULT,
        broadcast,
      );

      if (result.mobKilled && result.rewards) {
        client.emit(WS_WORLD_EVENTS.ATTACK_MOB_REWARDS, result.rewards);
        if (result.rewards.levelsGained > 0) {
          const vitals = await this.statEngine.getCombatVitals(characterId);
          const levelRow = await this.prisma.character.findUnique({
            where: { id: characterId },
            select: { availableStatPoints: true },
          });
          const vitalsPayload: WsPlayerVitalsPayload = {
            characterId,
            currentHp: vitals.currentHp,
            maxHp: vitals.maxHp,
          };
          this.bridge.emitPlayerVitals(vitalsPayload, mob.zoneId ?? character.currentZoneId);
          const levelPayload: WsLevelUpPayload = {
            characterId,
            newLevel: result.rewards.level,
            experience: result.rewards.experience,
            experienceRequiredForNext: result.rewards.experienceRequiredForNext,
            availableStatPoints: levelRow?.availableStatPoints ?? 0,
            currentHp: vitals.currentHp,
            maxHp: vitals.maxHp,
          };
          this.bridge.emitToCharacter(
            characterId,
            WS_WORLD_EVENTS.LEVEL_UP,
            levelPayload,
          );
          await this.playerCombatRuntime.seedCharacterCombatState(characterId);
        }
      }
    } catch (e) {
      this.emitDeniedFromError(client, e);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.CAST_SKILL)
  async handleCastSkill(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsCastSkillClientPayload,
  ): Promise<void> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return;
    }
    if (
      !body ||
      typeof body.skillId !== 'string' ||
      body.skillId.length === 0 ||
      !isUuid(body.targetId)
    ) {
      return;
    }
    if (await this.isCharacterDead(characterId)) {
      this.emitDenied(client, {
        code: 'CHARACTER_DEAD',
        message: 'Estás muerto: pedí respawn antes de castear',
      });
      return;
    }
    if (body.targetKind === 'player') {
      if (this.isSamePartyAttack(characterId, body.targetId)) {
        this.emitDenied(client, {
          code: 'TARGET_IS_PARTY_MEMBER',
          message: 'No podés atacar a un miembro de tu grupo',
        });
        return;
      }
      // Mismo motivo que en `handleAttackPlayer`: una skill contra jugador termina
      // llamando a `combat.attackCharacter`, que es la misma transacción PvP — no debe
      // solaparse con un auto-ataque básico en curso del mismo atacante.
      if (this.pvpAttacksInFlight.has(characterId)) {
        this.emitDenied(client, {
          code: 'ATTACK_ON_COOLDOWN',
          message: 'Melee swing on cooldown',
        });
        return;
      }
      this.pvpAttacksInFlight.add(characterId);
      try {
        const cast = await this.playerCombatRuntime.tryCastSkillOnPlayerForCharacter(
          characterId,
          body.skillId,
          body.targetId,
          (otherCharacterId) => this.isSamePartyAttack(characterId, otherCharacterId),
        );
        if (!cast.ok) {
          this.emitDenied(client, { code: cast.code, message: cast.message });
        }
      } catch (e) {
        this.emitDeniedFromError(client, e);
      } finally {
        this.pvpAttacksInFlight.delete(characterId);
      }
      return;
    }
    const cast = await this.playerCombatRuntime.tryCastSkillForCharacter(
      characterId,
      body.skillId,
      body.targetId,
    );
    if (!cast.ok) {
      this.emitDenied(client, {
        code: cast.code,
        message: cast.message,
      });
    }
  }

  /**
   * Fuego amigo: sin esto, un compañero de grupo se ataca exactamente igual que cualquier
   * otro jugador (mismo pipeline, mismo daño, mismo karma), tanto con ataque básico como
   * con skill. El cliente ya no deja targetear "como atacar" a un miembro propio, pero la
   * autoridad es el Warden: esto cubre un cliente modificado o un target que quedó stale.
   */
  private isSamePartyAttack(attackerCharacterId: string, targetCharacterId: string): boolean {
    const partyId = this.party.getPartyIdForCharacter(attackerCharacterId);
    return !!partyId && partyId === this.party.getPartyIdForCharacter(targetCharacterId);
  }

  // TODO: pendiente verificar el delay de golpe-a-golpe en PvP (jugador vs jugador):
  // el usuario reportó percibir demora entre personajes; no confirmado aún si es la
  // misma familia de bug que el teletransporte de mobs (ver fix en mob-ai-tick.service.ts)
  // o simplemente latencia de red / el swing-cooldown (`timing.baseSwingCooldownMs`).
  @SubscribeMessage(WS_WORLD_EVENTS.ATTACK_PLAYER)
  async handleAttackPlayer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsAttackPlayerClientPayload,
  ): Promise<void> {
    const attackerCharacterId = client.data.characterId as string | undefined;
    if (!attackerCharacterId) {
      this.emitDenied(client, {
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      });
      return;
    }
    if (!body || !isUuid(body.targetCharacterId)) {
      this.emitDenied(client, {
        code: 'INVALID_PAYLOAD',
        message: 'targetCharacterId (UUID) is required',
      });
      return;
    }
    if (await this.isCharacterDead(attackerCharacterId)) {
      this.emitDenied(client, {
        code: 'CHARACTER_DEAD',
        message: 'Estás muerto: pedí respawn antes de atacar',
      });
      return;
    }
    if (this.isSamePartyAttack(attackerCharacterId, body.targetCharacterId)) {
      this.emitDenied(client, {
        code: 'TARGET_IS_PARTY_MEMBER',
        message: 'No podés atacar a un miembro de tu grupo',
      });
      return;
    }
    if (
      typeof body.attackerFacingYaw === 'number' &&
      Number.isFinite(body.attackerFacingYaw)
    ) {
      await this.prisma.character.update({
        where: { id: attackerCharacterId },
        data: { worldFacingYaw: body.attackerFacingYaw },
      });
    }
    // Un golpe PvP en curso por atacante: los solapados sólo harían cola sobre las mismas filas
    // (bloqueos, timeouts) y de todos modos caerían en el enfriamiento.
    if (this.pvpAttacksInFlight.has(attackerCharacterId)) {
      this.emitDenied(client, {
        code: 'ATTACK_ON_COOLDOWN',
        message: 'Melee swing on cooldown',
      });
      return;
    }
    this.pvpAttacksInFlight.add(attackerCharacterId);
    try {
      await this.combat.attackCharacter(
        attackerCharacterId,
        body.targetCharacterId,
      );
    } catch (e) {
      this.emitDeniedFromError(client, e);
    } finally {
      this.pvpAttacksInFlight.delete(attackerCharacterId);
    }
  }

  /**
   * Al seleccionar a otro jugador como target: HP/maxHP/nivel ya mismo, sin esperar a
   * golpearlo. Respuesta privada solo al que pidió (no `broadcastToZone`) — la tarjeta de
   * target de cualquier otro que ya lo tenga seleccionado se actualiza sola vía
   * `emitPlayerVitals` cuando el HP de ese jugador cambie por cualquier motivo.
   */
  @SubscribeMessage(WS_WORLD_EVENTS.REQUEST_PLAYER_TARGET_VITALS)
  async handleRequestPlayerTargetVitals(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsRequestPlayerTargetVitalsPayload,
  ): Promise<void> {
    const requesterCharacterId = client.data.characterId as string | undefined;
    if (!requesterCharacterId) {
      return;
    }
    if (!body || !isUuid(body.targetCharacterId)) {
      return;
    }
    try {
      const [vitals, target] = await Promise.all([
        this.statEngine.getCombatVitals(body.targetCharacterId),
        this.prisma.character.findUnique({
          where: { id: body.targetCharacterId },
          select: { level: true },
        }),
      ]);
      if (!target) {
        return;
      }
      this.bridge.emitToCharacter(requesterCharacterId, WS_WORLD_EVENTS.PLAYER_TARGET_VITALS, {
        characterId: body.targetCharacterId,
        currentHp: vitals.currentHp,
        maxHp: vitals.maxHp,
        level: target.level,
      } satisfies WsPlayerTargetVitalsPayload);
    } catch {
      /* target ya no existe / carrera: ignorar, la tarjeta se queda sin datos */
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.REQUEST_SYNTHESIS_QUOTE)
  async handleRequestSynthesisQuote(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsRequestSynthesisClientPayload,
  ): Promise<WsSynthesisQuoteAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || !isUuid(body.itemAId) || !isUuid(body.itemBId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'itemAId and itemBId (UUID) are required',
      };
    }
    try {
      const quote = await this.synthesisService.getSynthesisQuote(
        characterId,
        body.itemAId,
        body.itemBId,
      );
      return { ok: true, ...quote };
    } catch (e) {
      return this.mapInventoryErrorToAck(e);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.REQUEST_SYNTHESIS)
  async handleRequestSynthesis(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsRequestSynthesisClientPayload,
  ): Promise<WsRequestSynthesisAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || !isUuid(body.itemAId) || !isUuid(body.itemBId)) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'itemAId and itemBId (UUID) are required',
      };
    }
    try {
      const result = await this.synthesisService.performSynthesis(
        characterId,
        body.itemAId,
        body.itemBId,
      );
      const snapshot = await this.inventoryService.getProgressSnapshot(characterId);
      const vitals = await this.statEngine.getCombatVitals(characterId);
      const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
      const character = buildCharacterSheetDto(
        snapshot.character,
        vitals,
        this.statEngine,
        effectiveCore,
      );
      const items = snapshot.character.items.map((row) =>
        mapInventoryItemInstanceToRow(row, snapshot.character.items),
      );

      if (result.success) {
        await this.playerCombatRuntime.refreshDerivedStatsAfterEquipmentChange(
          characterId,
        );
        const zoneId = normalizeZoneId(client.data.zoneId as string | undefined);
        await this.emitCharacterVisualState(characterId, zoneId);
        const statsPayload: WsPlayerStatsUpdatePayload = {
          characterId,
          derived: character.derived,
          vitals: character.vitals,
        };
        this.bridge.emitToCharacter(
          characterId,
          WS_WORLD_EVENTS.PLAYER_STATS_UPDATE,
          statsPayload,
        );
      }

      const vitalsPayload: WsPlayerVitalsPayload = {
        characterId,
        currentHp: vitals.currentHp,
        maxHp: vitals.maxHp,
      };
      this.bridge.emitPlayerVitals(
        vitalsPayload,
        normalizeZoneId(client.data.zoneId as string | undefined),
      );

      return {
        ok: true,
        success: result.success,
        forcedByPity: result.forcedByPity,
        newItemLevel: toPlusLevelFromStoredSynthesisLevel(result.synthesisLevel),
        pityCount: result.synthesisPityConsecutiveFails,
        adenaSpent: result.adenaSpent,
        adenaAfter: result.adenaAfter,
        baseSuccessPercent: result.baseSuccessPercent,
        effectiveSuccessPercent: result.effectiveSuccessPercent,
        pityMaxFails: result.pityMaxFails,
        pityBonusPerFailPercent: result.pityBonusPerFailPercent,
        character,
        items,
        adena: result.adenaAfter,
      };
    } catch (e) {
      return this.mapInventoryErrorToAck(e);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.EXECUTE_GM_COMMAND)
  async handleExecuteGmCommand(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsExecuteGmCommandClientPayload,
  ): Promise<WsExecuteGmCommandAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (!body || typeof body.command !== 'string' || !body.command.trim()) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'command is required',
      };
    }
    const args = Array.isArray(body.args)
      ? body.args.filter((a) => typeof a === 'string')
      : [];

    const result = await this.gmCommandService.execute(
      characterId,
      body.command,
      args,
    );

    if (!result.ok) {
      return result;
    }

    await this.emitGmFollowUp(characterId, result.command, result.previousLevel);

    return { ok: true };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PARTY_INVITE)
  async handlePartyInvite(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsPartyInviteClientPayload,
  ): Promise<WsPartyActionAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    if (!body || !isUuid(body.targetCharacterId)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: 'targetCharacterId (UUID) is required' };
    }
    if (!this.presence.isConnected(body.targetCharacterId)) {
      return { ok: false, code: 'TARGET_OFFLINE', message: 'Ese jugador no está conectado' };
    }
    const inviter = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { name: true, characterClass: true },
    });
    if (!inviter) {
      return { ok: false, code: 'NOT_FOUND', message: 'Personaje no encontrado' };
    }
    const result = this.party.createInvite({
      fromCharacterId: characterId,
      fromName: inviter.name,
      fromClass: inviter.characterClass,
      targetCharacterId: body.targetCharacterId,
    });
    if (!result.ok) {
      return result;
    }
    // Si `createInvite` acaba de crear el grupo (el que invita todavía no tenía uno),
    // ese socket nunca se sumó a la sala `party:*` — solo lo hace quien acepta en
    // `handlePartyAccept`. Sin este join, el líder no recibiría ningún `party-update`
    // futuro (ni el de la propia aceptación) hasta reconectar.
    await client.join(this.bridge.partyRoomId(result.partyId));
    this.bridge.emitToCharacter(
      body.targetCharacterId,
      WS_WORLD_EVENTS.PARTY_INVITE_RECEIVED,
      { fromCharacterId: characterId, fromName: inviter.name } satisfies WsPartyInviteReceivedPayload,
    );
    return { ok: true };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PARTY_ACCEPT)
  async handlePartyAccept(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsPartyAcceptClientPayload,
  ): Promise<WsPartyActionAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    if (!body || !isUuid(body.fromCharacterId)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: 'fromCharacterId (UUID) is required' };
    }
    const accepter = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { name: true, characterClass: true },
    });
    if (!accepter) {
      return { ok: false, code: 'NOT_FOUND', message: 'Personaje no encontrado' };
    }
    const result = this.party.acceptInvite({
      targetCharacterId: characterId,
      fromCharacterId: body.fromCharacterId,
      targetName: accepter.name,
      targetClass: accepter.characterClass,
    });
    if (!result.ok) {
      return result;
    }
    await client.join(this.bridge.partyRoomId(result.partyId));
    this.broadcastPartyUpdate(result.partyId);
    return { ok: true };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PARTY_DECLINE)
  handlePartyDecline(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsPartyDeclineClientPayload,
  ): WsPartyActionAckPayload {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    if (!body || !isUuid(body.fromCharacterId)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: 'fromCharacterId (UUID) is required' };
    }
    this.party.declineInvite(characterId, body.fromCharacterId);
    return { ok: true };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PARTY_LEAVE)
  handlePartyLeave(@ConnectedSocket() client: Socket): WsPartyActionAckPayload {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    const result = this.party.leaveParty(characterId);
    if (!result) {
      return { ok: false, code: 'NOT_IN_PARTY', message: 'No estás en un grupo' };
    }
    this.bridge.leaveCharacterFromRoom(characterId, this.bridge.partyRoomId(result.partyId));
    client.emit(WS_WORLD_EVENTS.PARTY_UPDATE, null);
    if (!result.disbanded) {
      this.broadcastPartyUpdate(result.partyId);
    } else {
      // Si quedó un solo miembro, el grupo se disolvió entero: a ese también se le limpia el panel.
      for (const affectedId of result.affectedCharacterIds) {
        if (affectedId === characterId) {
          continue;
        }
        this.bridge.leaveCharacterFromRoom(affectedId, this.bridge.partyRoomId(result.partyId));
        this.bridge.emitToCharacter(affectedId, WS_WORLD_EVENTS.PARTY_UPDATE, null);
      }
    }
    return { ok: true };
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PARTY_KICK)
  handlePartyKick(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsPartyKickClientPayload,
  ): WsPartyActionAckPayload {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    if (!body || !isUuid(body.targetCharacterId)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: 'targetCharacterId (UUID) is required' };
    }
    const result = this.party.kickMember(characterId, body.targetCharacterId);
    if (!result.ok) {
      return result;
    }
    this.bridge.leaveCharacterFromRoom(body.targetCharacterId, this.bridge.partyRoomId(result.partyId));
    this.bridge.emitToCharacter(body.targetCharacterId, WS_WORLD_EVENTS.PARTY_UPDATE, null);
    if (!result.disbanded) {
      this.broadcastPartyUpdate(result.partyId);
    } else {
      for (const affectedId of result.affectedCharacterIds) {
        if (affectedId === body.targetCharacterId) {
          continue;
        }
        this.bridge.leaveCharacterFromRoom(affectedId, this.bridge.partyRoomId(result.partyId));
        this.bridge.emitToCharacter(affectedId, WS_WORLD_EVENTS.PARTY_UPDATE, null);
      }
    }
    return { ok: true };
  }

  /** Combina el estado puro de `PartyService` con conexión/vitals en RAM (ver `PartyVitalsTickService`). */
  private buildPartyUpdatePayload(partyId: string) {
    return this.party.buildUpdatePayload(partyId, (characterId) => {
      const online = this.presence.isConnected(characterId);
      const vitals = online ? this.playerCombatRuntime.getRuntimeVitals(characterId) : null;
      return {
        online,
        currentHp: vitals?.currentHp ?? 0,
        maxHp: vitals?.maxHp ?? 0,
        currentMp: vitals?.currentMp ?? 0,
        maxMp: vitals?.maxMp ?? 0,
      };
    });
  }

  private broadcastPartyUpdate(partyId: string): void {
    this.bridge.broadcastToRoom(
      this.bridge.partyRoomId(partyId),
      WS_WORLD_EVENTS.PARTY_UPDATE,
      this.buildPartyUpdatePayload(partyId),
    );
  }

  @SubscribeMessage(WS_WORLD_EVENTS.CHAT_SEND)
  async handleChatSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsChatSendClientPayload,
  ): Promise<WsChatSendAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    const rawText = typeof body?.text === 'string' ? body.text.trim() : '';
    // Comando (ej. "/kit"): nunca se difunde como mensaje de chat, la validación de canal
    // de abajo no aplica. Se resuelve antes de tocar el rate-limit de chat normal.
    if (rawText.startsWith('/')) {
      return this.handleChatCommand(characterId, rawText);
    }
    if (!body || (body.channel !== 'global' && body.channel !== 'party')) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: 'channel must be "global" or "party"' };
    }
    const text = rawText;
    if (!text) {
      return { ok: false, code: 'EMPTY_MESSAGE', message: 'El mensaje está vacío' };
    }
    if (text.length > CHAT_MESSAGE_MAX_LENGTH) {
      return {
        ok: false,
        code: 'MESSAGE_TOO_LONG',
        message: `El mensaje supera los ${CHAT_MESSAGE_MAX_LENGTH} caracteres`,
      };
    }
    const now = Date.now();
    const lastSentAt = this.lastChatSentAtMs.get(characterId) ?? 0;
    if (now - lastSentAt < CHAT_MIN_GAP_MS) {
      return { ok: false, code: 'RATE_LIMITED', message: 'Estás enviando mensajes muy rápido' };
    }
    let partyId: string | undefined;
    if (body.channel === 'party') {
      partyId = this.party.getPartyIdForCharacter(characterId);
      if (!partyId) {
        return { ok: false, code: 'NOT_IN_PARTY', message: 'No estás en un grupo' };
      }
    }
    this.lastChatSentAtMs.set(characterId, now);
    const payload: WsChatMessagePayload = {
      channel: body.channel,
      characterId,
      name: (client.data.characterName as string | undefined) ?? '???',
      text,
      atMs: now,
    };
    if (body.channel === 'global') {
      this.bridge.broadcastToAll(WS_WORLD_EVENTS.CHAT_MESSAGE, payload);
    } else {
      this.bridge.broadcastToRoom(this.bridge.partyRoomId(partyId!), WS_WORLD_EVENTS.CHAT_MESSAGE, payload);
    }
    return { ok: true };
  }

  /**
   * Comandos de chat accesibles a cualquier jugador (sin `isAdmin`, a diferencia de
   * `execute-gm-command`). El feedback vuelve solo al que lo tipeó vía el ack — nunca se
   * difunde como `CHAT_MESSAGE`.
   */
  private async handleChatCommand(
    characterId: string,
    rawText: string,
  ): Promise<WsChatSendAckPayload> {
    const [command] = rawText.slice(1).trim().split(/\s+/);
    switch (command?.toLowerCase()) {
      case 'kit': {
        const result = await this.starterKit.grantIfMissing(characterId);
        if (result.granted.length === 0) {
          return { ok: true, message: '[/kit] Ya tenés el kit inicial.' };
        }
        return {
          ok: true,
          message: `[/kit] Te di: ${result.granted.join(', ')} (revisá tu inventario).`,
        };
      }
      default:
        return {
          ok: false,
          code: 'UNKNOWN_COMMAND',
          message: `Comando desconocido: /${command ?? ''}`,
        };
    }
  }

  /**
   * Tras un comando GM exitoso: stats/vitals, opcional LEVEL_UP y estado visual (karma / plus).
   */
  private async emitGmFollowUp(
    characterId: string,
    command: string,
    previousLevel?: number,
  ): Promise<void> {
    const zoneId = normalizeZoneId(
      (
        await this.prisma.character.findUnique({
          where: { id: characterId },
          select: { currentZoneId: true, level: true, experience: true },
        })
      )?.currentZoneId,
    );

    await this.playerCombatRuntime.refreshDerivedStatsAfterEquipmentChange(
      characterId,
    );

    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
    });
    if (!character) {
      return;
    }

    const vitals = await this.statEngine.getCombatVitals(characterId);
    const statsPayload: WsPlayerStatsUpdatePayload = {
      characterId,
      derived: {
        pAtk: character.derivedPAtk,
        mAtk: character.derivedMAtk,
        pDef: character.derivedPDef,
        atkSpeed: character.derivedAtkSpeed,
        critRate: character.derivedCritRate,
        pvpSwingCooldownMs: computeSwingCooldownMs(character.derivedAtkSpeed),
      },
      vitals: {
        currentHp: vitals.currentHp,
        maxHp: vitals.maxHp,
      },
    };
    this.bridge.emitToCharacter(
      characterId,
      WS_WORLD_EVENTS.PLAYER_STATS_UPDATE,
      statsPayload,
    );

    const vitalsPayload: WsPlayerVitalsPayload = {
      characterId,
      currentHp: vitals.currentHp,
      maxHp: vitals.maxHp,
    };
    this.bridge.emitPlayerVitals(vitalsPayload, character.currentZoneId);

    if (
      command === 'setlevel' &&
      previousLevel !== undefined &&
      character.level > previousLevel
    ) {
      const levelRow = await this.prisma.character.findUnique({
        where: { id: characterId },
        select: { availableStatPoints: true },
      });
      const levelPayload: WsLevelUpPayload = {
        characterId,
        newLevel: character.level,
        experience: character.experience,
        experienceRequiredForNext:
          this.statEngine.experienceRequiredForNextOrZero(character.level),
        availableStatPoints: levelRow?.availableStatPoints ?? 0,
        currentHp: vitals.currentHp,
        maxHp: vitals.maxHp,
      };
      this.bridge.emitToCharacter(
        characterId,
        WS_WORLD_EVENTS.LEVEL_UP,
        levelPayload,
      );
      await this.playerCombatRuntime.seedCharacterCombatState(characterId);
    }

    if (command === 'setplus' || command === 'setkarma') {
      await this.emitCharacterVisualState(characterId, zoneId);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.DISTRIBUTE_STAT)
  async handleDistributeStat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsDistributeStatClientPayload,
  ): Promise<WsDistributeStatAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_BOUND',
        message: 'Socket is not bound to a character',
      };
    }
    if (
      !body ||
      !['STR', 'AGI', 'VIT', 'ENE'].includes(body.statName) ||
      typeof body.amount !== 'number' ||
      !Number.isFinite(body.amount)
    ) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'statName and amount are required',
      };
    }
    try {
      const character = await this.characterService.distributeStatPoints(
        characterId,
        body.statName,
        body.amount,
      );
      const vitals = await this.statEngine.getCombatVitals(characterId);
      const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
      await this.playerCombatRuntime.refreshDerivedStatsAfterEquipmentChange(characterId);
      return {
        ok: true,
        character: buildCharacterSheetDto(
          character,
          vitals,
          this.statEngine,
          effectiveCore,
        ),
      };
    } catch (e) {
      return this.mapInventoryErrorToAck(e);
    }
  }

  @SubscribeMessage(WS_WORLD_EVENTS.PORTAL_TRAVEL)
  async handlePortalTravel(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsPortalTravelClientPayload,
  ): Promise<void> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId || !body?.portalId || typeof body.portalId !== 'string') {
      return;
    }

    const portal = findMapPortalById(body.portalId);
    if (!portal || portal.kind !== 'portal') {
      client.emit(WS_WORLD_EVENTS.PORTAL_TRAVEL_DENIED, {
        code: 'PORTAL_NOT_FOUND',
        message: 'Portal no válido',
      } satisfies WsPortalTravelDeniedPayload);
      return;
    }

    const ch = await this.prisma.character.findUnique({
      where: { id: characterId },
    });
    if (!ch) {
      return;
    }

    const socketZone = normalizeZoneId(client.data.zoneId as string | undefined);
    if (!zonesMatch(ch.currentZoneId, socketZone)) {
      client.emit(WS_WORLD_EVENTS.PLAYER_POSITION_CORRECTED, {
        worldPos: {
          x: ch.worldPosX,
          y: ch.worldPosY,
          z: ch.worldPosZ,
        },
        worldFacingYaw: ch.worldFacingYaw,
        reason: 'ZONE_MISMATCH',
      } satisfies WsPlayerPositionCorrectedPayload);
      return;
    }

    if (isDeadHp(ch.currentHp)) {
      client.emit(WS_WORLD_EVENTS.PORTAL_TRAVEL_DENIED, {
        code: 'CHARACTER_DEAD',
        message: 'No podés usar portales estando muerto',
      } satisfies WsPortalTravelDeniedPayload);
      return;
    }

    const portalZone = normalizeZoneId(portal.zoneId);
    if (!zonesMatch(ch.currentZoneId, portalZone)) {
      client.emit(WS_WORLD_EVENTS.PORTAL_TRAVEL_DENIED, {
        code: 'PORTAL_WRONG_ZONE',
        message: 'Este portal no está en tu zona actual',
      } satisfies WsPortalTravelDeniedPayload);
      return;
    }

    const targetDef = getWorldZoneDefinition(portal.targetZoneId);
    if (!targetDef) {
      client.emit(WS_WORLD_EVENTS.PORTAL_TRAVEL_DENIED, {
        code: 'ZONE_UNKNOWN',
        message: 'Zona de destino no configurada',
      } satisfies WsPortalTravelDeniedPayload);
      return;
    }

    if (ch.level < targetDef.minCharacterLevel) {
      client.emit(WS_WORLD_EVENTS.PORTAL_TRAVEL_DENIED, {
        code: 'LEVEL_TOO_LOW',
        message: 'Nivel insuficiente para esta zona',
      } satisfies WsPortalTravelDeniedPayload);
      return;
    }

    const playerPos = { x: ch.worldPosX, y: ch.worldPosY, z: ch.worldPosZ };
    const portalPos = portal.position;
    const interactR =
      typeof portal.interactionRadiusMeters === 'number' &&
      Number.isFinite(portal.interactionRadiusMeters) &&
      portal.interactionRadiusMeters > 0
        ? portal.interactionRadiusMeters
        : 4;
    if (this.spatial.distance3d(playerPos, portalPos) > interactR) {
      client.emit(WS_WORLD_EVENTS.PORTAL_TRAVEL_DENIED, {
        code: 'PORTAL_OUT_OF_RANGE',
        message: 'Demasiado lejos del portal',
      } satisfies WsPortalTravelDeniedPayload);
      return;
    }

    const prevZone = normalizeZoneId(ch.currentZoneId);
    const newZoneId = normalizeZoneId(portal.targetZoneId);
    if (prevZone === newZoneId) {
      return;
    }

    const spawn = targetDef.entrySpawn;

    await this.playerCombatRuntime.setCombatTarget(characterId, prevZone, null);
    void this.mobService.clearAggroTargetingCharacter(characterId);

    await this.prisma.character.update({
      where: { id: characterId },
      data: {
        currentZoneId: newZoneId,
        worldPosX: spawn.worldPos.x,
        worldPosY: spawn.worldPos.y,
        worldPosZ: spawn.worldPos.z,
        worldFacingYaw: spawn.worldFacingYaw,
      },
    });

    await this.playerCombatRuntime.seedCharacterCombatState(characterId);

    const oldRoom = this.bridge.zoneRoomId(prevZone);
    const newRoom = this.bridge.zoneRoomId(newZoneId);
    await client.leave(oldRoom);
    await client.join(newRoom);
    client.data.zoneId = newZoneId;

    const left: WsPlayerLeftZonePayload = { characterId };
    void this.server.to(oldRoom).emit(WS_WORLD_EVENTS.PLAYER_LEFT_ZONE, left);

    const built = await this.buildZoneSnapshotPayload(characterId, newZoneId);
    if (!built) {
      return;
    }

    client.emit(WS_WORLD_EVENTS.ZONE_SNAPSHOT, built.snapshot);

    const arriveVisual = await this.resolveCharacterVisualState(characterId);
    const arrive: WsPlayerMovedPayload = {
      characterId,
      worldPos: {
        x: built.row.worldPosX,
        y: built.row.worldPosY,
        z: built.row.worldPosZ,
      },
      worldFacingYaw: built.row.worldFacingYaw,
      displayName: built.row.name,
      karmaFlag: arriveVisual?.karmaFlag,
      weaponPlusLevel: arriveVisual?.weaponPlusLevel,
      weaponEquipped: arriveVisual?.weaponEquipped,
    };
    void client.to(newRoom).emit(WS_WORLD_EVENTS.PLAYER_MOVED, arrive);
    await this.emitCharacterVisualState(characterId, newZoneId);
  }

  /**
   * Misma coreografía socket que el final de `handlePortalTravel` (leave/join de sala,
   * snapshot, `PLAYER_MOVED` de llegada) pero reutilizable: la actualización de
   * `Character.currentZoneId`/posición ya la hizo `DungeonService` en su propia transacción,
   * así que esto solo sincroniza el socket y lo que ve el resto de la zona.
   */
  private async finishDungeonZoneSwitch(
    client: Socket,
    characterId: string,
    prevZoneId: string | null,
    newZoneId: string,
  ): Promise<void> {
    await this.playerCombatRuntime.setCombatTarget(
      characterId,
      normalizeZoneId(prevZoneId),
      null,
    );
    void this.mobService.clearAggroTargetingCharacter(characterId);
    await this.playerCombatRuntime.seedCharacterCombatState(characterId);

    const oldRoom = this.bridge.zoneRoomId(prevZoneId);
    const newRoom = this.bridge.zoneRoomId(newZoneId);
    await client.leave(oldRoom);
    await client.join(newRoom);
    client.data.zoneId = newZoneId;

    const left: WsPlayerLeftZonePayload = { characterId };
    void this.server.to(oldRoom).emit(WS_WORLD_EVENTS.PLAYER_LEFT_ZONE, left);

    const built = await this.buildZoneSnapshotPayload(characterId, newZoneId);
    if (!built) {
      return;
    }
    client.emit(WS_WORLD_EVENTS.ZONE_SNAPSHOT, built.snapshot);

    const arriveVisual = await this.resolveCharacterVisualState(characterId);
    const arrive: WsPlayerMovedPayload = {
      characterId,
      worldPos: {
        x: built.row.worldPosX,
        y: built.row.worldPosY,
        z: built.row.worldPosZ,
      },
      worldFacingYaw: built.row.worldFacingYaw,
      displayName: built.row.name,
      karmaFlag: arriveVisual?.karmaFlag,
      weaponPlusLevel: arriveVisual?.weaponPlusLevel,
      weaponEquipped: arriveVisual?.weaponEquipped,
    };
    void client.to(newRoom).emit(WS_WORLD_EVENTS.PLAYER_MOVED, arrive);
    await this.emitCharacterVisualState(characterId, newZoneId);
  }

  /** Cliente → servidor: hablar con el NPC guía en Zone_0. Consume el ticket diario si hay. */
  @SubscribeMessage(WS_WORLD_EVENTS.DUNGEON_ENTER_REQUEST)
  async handleDungeonEnterRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsDungeonEnterRequestClientPayload,
  ): Promise<WsDungeonSessionAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    if (!body || typeof body.npcInstanceId !== 'string' || !isUuid(body.npcInstanceId)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: 'npcInstanceId (UUID) is required' };
    }
    if (await this.isCharacterDead(characterId)) {
      return {
        ok: false,
        code: 'CHARACTER_DEAD',
        message: 'Estás muerto: pedí respawn antes de entrar a la mazmorra',
      };
    }
    const outcome = await this.dungeonService.requestEntry(characterId, body.npcInstanceId);
    if (!outcome.ok) {
      return outcome;
    }
    await this.finishDungeonZoneSwitch(
      client,
      characterId,
      outcome.previousZoneId,
      outcome.zoneId,
    );
    return {
      ok: true,
      exited: false,
      zoneId: outcome.zoneId,
      chamberType: outcome.chamberType,
      chamberDisplayName: outcome.chamberDisplayName,
      expiresAtEpochMs: outcome.expiresAtEpochMs,
    };
  }

  /** Cliente → servidor: hablar con el NPC de sala. `next_room` no cobra ticket; `exit` termina la corrida. */
  @SubscribeMessage(WS_WORLD_EVENTS.DUNGEON_ROOM_ACTION)
  async handleDungeonRoomAction(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: WsDungeonRoomActionClientPayload,
  ): Promise<WsDungeonSessionAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return { ok: false, code: 'NOT_BOUND', message: 'Socket is not bound to a character' };
    }
    if (
      !body ||
      typeof body.npcInstanceId !== 'string' ||
      !isUuid(body.npcInstanceId) ||
      (body.action !== 'next_room' && body.action !== 'exit')
    ) {
      return {
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'npcInstanceId (UUID) y action son requeridos',
      };
    }
    if (await this.isCharacterDead(characterId)) {
      return {
        ok: false,
        code: 'CHARACTER_DEAD',
        message: 'Estás muerto: pedí respawn antes de seguir en la mazmorra',
      };
    }
    const outcome = await this.dungeonService.requestRoomAction(
      characterId,
      body.npcInstanceId,
      body.action,
    );
    if (!outcome.ok) {
      return outcome;
    }
    await this.finishDungeonZoneSwitch(
      client,
      characterId,
      outcome.previousZoneId,
      outcome.zoneId,
    );
    if (outcome.exited) {
      return { ok: true, exited: true, zoneId: outcome.zoneId };
    }
    return {
      ok: true,
      exited: false,
      zoneId: outcome.zoneId,
      chamberType: outcome.chamberType,
      chamberDisplayName: outcome.chamberDisplayName,
      expiresAtEpochMs: outcome.expiresAtEpochMs,
    };
  }

  /**
   * Muerte autoritativa sin golpe extra a DB: la RAM del Warden manda cuando está hidratada.
   */
  private async isCharacterDead(characterId: string): Promise<boolean> {
    const ram = this.playerCombatRuntime.getRuntimeVitals(characterId);
    if (ram) {
      return isDeadHp(ram.currentHp);
    }
    const row = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { currentHp: true },
    });
    return row !== null && isDeadHp(row.currentHp);
  }

  /**
   * Resurrección pedida por el cliente. El Warden decide zona y coordenadas (`entrySpawn`);
   * el cliente sólo expresa la intención, así que la pantalla de muerte puede durar lo que quiera.
   */
  @SubscribeMessage(WS_WORLD_EVENTS.REQUEST_RESPAWN)
  async handleRequestRespawn(
    @ConnectedSocket() client: Socket,
  ): Promise<WsRequestRespawnAckPayload> {
    const characterId = client.data.characterId as string | undefined;
    if (!characterId) {
      return {
        ok: false,
        code: 'NOT_AUTHENTICATED',
        message: 'Socket sin personaje asociado',
      };
    }

    let respawn: CharacterRespawnResolution;
    try {
      respawn = await this.prisma.$transaction(
        (tx) => this.characterService.respawnCharacterInTx(tx, characterId),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (e) {
      return this.mapInventoryErrorToAck(e) as WsRequestRespawnAckPayload;
    }

    const prevZone = normalizeZoneId(client.data.zoneId as string | undefined);

    // La zona destino puede diferir de la de muerte: migrar rooms antes de emitir estado.
    if (!zonesMatch(prevZone, respawn.zoneId)) {
      const oldRoom = this.bridge.zoneRoomId(prevZone);
      const newRoom = this.bridge.zoneRoomId(respawn.zoneId);
      await client.leave(oldRoom);
      await client.join(newRoom);
      void this.server
        .to(oldRoom)
        .emit(WS_WORLD_EVENTS.PLAYER_LEFT_ZONE, {
          characterId,
        } satisfies WsPlayerLeftZonePayload);
    }
    client.data.zoneId = respawn.zoneId;
    client.data.lastMoveSampleAtMs = Date.now();

    await this.playerCombatRuntime.setCombatTarget(characterId, prevZone, null);
    void this.mobService.clearAggroTargetingCharacter(characterId);
    await this.playerCombatRuntime.seedCharacterCombatState(characterId);
    this.playerCombatRuntime.recordPoseFromMove(
      characterId,
      respawn.worldPos,
      respawn.worldFacingYaw,
      respawn.zoneId,
    );

    const built = await this.buildZoneSnapshotPayload(characterId, respawn.zoneId);
    if (built) {
      client.emit(WS_WORLD_EVENTS.ZONE_SNAPSHOT, built.snapshot);
    }

    const visual = await this.resolveCharacterVisualState(characterId);
    const respawnPayload: WsPlayerRespawnPayload = {
      characterId,
      displayName: built?.row.name,
      zoneId: respawn.zoneId,
      worldPos: respawn.worldPos,
      worldFacingYaw: respawn.worldFacingYaw,
      currentHp: respawn.currentHp,
      maxHp: respawn.maxHp,
    };
    this.bridge.broadcastToZone(
      respawn.zoneId,
      WS_WORLD_EVENTS.PLAYER_RESPAWN,
      respawnPayload,
    );
    this.bridge.emitToCharacter(
      characterId,
      WS_WORLD_EVENTS.PLAYER_RESPAWN,
      respawnPayload,
    );

    this.bridge.broadcastToZone(respawn.zoneId, WS_WORLD_EVENTS.PLAYER_MOVED, {
      characterId,
      worldPos: respawn.worldPos,
      worldFacingYaw: respawn.worldFacingYaw,
      displayName: built?.row.name,
      karmaFlag: visual?.karmaFlag,
      weaponPlusLevel: visual?.weaponPlusLevel,
      weaponEquipped: visual?.weaponEquipped,
    } satisfies WsPlayerMovedPayload);
    await this.emitCharacterVisualState(characterId, respawn.zoneId);

    this.logger.log(
      `[Respawn] ${characterId} → ${respawn.zoneId} entrySpawn (zoneChanged=${respawn.zoneChanged})`,
    );

    return {
      ok: true,
      zoneId: respawn.zoneId,
      worldPos: respawn.worldPos,
      worldFacingYaw: respawn.worldFacingYaw,
      currentHp: respawn.currentHp,
      maxHp: respawn.maxHp,
      zoneChanged: respawn.zoneChanged,
    };
  }

  private mapInventoryErrorToEquipAck(e: unknown): WsEquipItemAckPayload {
    return this.mapInventoryErrorToAck(e);
  }

  private mapInventoryErrorToUnequipAck(e: unknown): WsUnequipItemAckPayload {
    return this.mapInventoryErrorToAck(e);
  }

  private mapInventoryErrorToUseItemAck(e: unknown): WsUseItemAckPayload {
    return this.mapInventoryErrorToAck(e) as WsUseItemAckPayload;
  }

  private mapInventoryErrorToAck(
    e: unknown,
  ): { ok: false; code: string; message: string } {
    if (e instanceof BadRequestException) {
      const r = e.getResponse();
      if (typeof r === 'object' && r !== null && 'code' in r) {
        const o = r as { code?: string; message?: string };
        return {
          ok: false,
          code: o.code ?? 'BAD_REQUEST',
          message: o.message ?? e.message,
        };
      }
      return {
        ok: false,
        code: 'BAD_REQUEST',
        message: typeof r === 'string' ? r : e.message,
      };
    }
    if (e instanceof NotFoundException) {
      return { ok: false, code: 'NOT_FOUND', message: e.message };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034') {
      return {
        ok: false,
        code: 'SERIALIZATION_CONFLICT',
        message: 'Inventario ocupado; probá de nuevo en un instante.',
      };
    }
    this.logger.warn(
      `[InventorySocket] ${e instanceof Error ? e.message : String(e)}`,
    );
    return {
      ok: false,
      code: 'INTERNAL',
      message: 'Unexpected error processing inventory action',
    };
  }

  /** Atacantes con un `attack-player` en proceso (ver `handleAttackPlayer`). */
  private readonly pvpAttacksInFlight = new Set<string>();
  /** Último chat enviado por personaje (anti-flood simple, ver `handleChatSend`). */
  private readonly lastChatSentAtMs = new Map<string, number>();

  private emitDenied(client: Socket, payload: WsAttackMobDeniedPayload): void {
    client.emit(WS_WORLD_EVENTS.ATTACK_MOB_DENIED, payload);
  }

  private emitDeniedFromError(client: Socket, e: unknown): void {
    if (e instanceof BadRequestException) {
      const r = e.getResponse();
      if (typeof r === 'object' && r !== null && 'code' in r) {
        const o = r as { code?: string; message?: string };
        this.emitDenied(client, {
          code: o.code ?? 'BAD_REQUEST',
          message: o.message ?? e.message,
        });
        return;
      }
      this.emitDenied(client, {
        code: 'BAD_REQUEST',
        message: typeof r === 'string' ? r : e.message,
      });
      return;
    }
    if (e instanceof NotFoundException) {
      this.emitDenied(client, {
        code: 'NOT_FOUND',
        message: e.message,
      });
      return;
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2034') {
        this.emitDenied(client, {
          code: 'SERIALIZATION_CONFLICT',
          message: 'Combate ocupado; probá de nuevo en un instante.',
        });
        return;
      }
      this.logger.warn(
        `[Attack] Prisma ${e.code}: ${e.message} (meta=${JSON.stringify(e.meta)})`,
      );
      this.emitDenied(client, {
        code: 'DATABASE',
        message: 'Error de persistencia en el ataque.',
      });
      return;
    }
    if (e instanceof HttpException) {
      const res = e.getResponse();
      const msg =
        typeof res === 'string'
          ? res
          : typeof res === 'object' &&
              res !== null &&
              'message' in res &&
              typeof (res as { message: unknown }).message === 'string'
            ? (res as { message: string }).message
            : e.message;
      this.emitDenied(client, {
        code: 'HTTP_EXCEPTION',
        message: msg,
      });
      return;
    }
    this.logger.error(
      `[Attack] Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
      e instanceof Error ? e.stack : undefined,
    );
    this.emitDenied(client, {
      code: 'INTERNAL',
      message: 'Unexpected error processing attack',
    });
  }
}
