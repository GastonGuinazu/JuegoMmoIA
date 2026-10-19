import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Character, DungeonChamberType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WorldSpatialService } from '../world/world-spatial.service';
import { zonesMatch } from '../world/world-zone.util';
import { getWorldZoneDefinition, type WorldZoneEntrySpawn } from '../world/config/world-zones.loaders';
import {
  getAllChamberTypes,
  getChamberDefinition,
  getChamberDefinitionByZoneId,
  loadDailyDungeonsConfig,
} from './daily-dungeons.loaders';
import { DungeonSessionTickService } from './dungeon-session-tick.service';

const NEXUS_ZONE_ID = 'Zone_0';
const NEXUS_NPC_TEMPLATE_KEY = 'dungeon_nexus_guide';
const ROOM_NPC_TEMPLATE_KEY = 'dungeon_room_guide';

export type DungeonEnterOutcome =
  | {
      ok: true;
      zoneId: string;
      chamberType: DungeonChamberType;
      chamberDisplayName: string;
      expiresAtEpochMs: number;
      entrySpawn: WorldZoneEntrySpawn;
      previousZoneId: string | null;
    }
  | { ok: false; code: string; message: string };

export type DungeonRoomActionOutcome =
  | {
      ok: true;
      exited: false;
      zoneId: string;
      chamberType: DungeonChamberType;
      chamberDisplayName: string;
      expiresAtEpochMs: number;
      entrySpawn: WorldZoneEntrySpawn;
      previousZoneId: string | null;
    }
  | {
      ok: true;
      exited: true;
      zoneId: string;
      entrySpawn: WorldZoneEntrySpawn;
      previousZoneId: string | null;
    }
  | { ok: false; code: string; message: string };

export type DungeonPartyTarget = {
  characterId: string;
  name: string;
  chamberDisplayName: string;
};

function todayUtcDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function pickRandomChamberExcluding(exclude: DungeonChamberType): DungeonChamberType {
  const candidates = getAllChamberTypes().filter((c) => c !== exclude);
  if (candidates.length === 0) {
    return exclude;
  }
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

/**
 * NexusManager: ticket diario (1 por personaje, no acumulable) + sesión activa de mazmorra.
 * El cambio de zona en sí (join/leave de sala, snapshot, `client.data.zoneId`) lo hace
 * `WorldGateway` con el resultado de este servicio — mismo reparto de responsabilidades que
 * ya usa para portales (acá no hay `client`/`Socket` a mano, ni falta).
 */
@Injectable()
export class DungeonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: WorldSpatialService,
    private readonly dungeonTick: DungeonSessionTickService,
  ) {}

  async requestEntry(characterId: string, npcInstanceId: string): Promise<DungeonEnterOutcome> {
    try {
      const npc = await this.prisma.npcInstance.findUnique({ where: { id: npcInstanceId } });
      if (!npc || npc.npcTemplateKey !== NEXUS_NPC_TEMPLATE_KEY) {
        throw new NotFoundException({ code: 'NPC_NOT_FOUND', message: 'NPC no encontrado' });
      }
      const character = await this.prisma.character.findUnique({ where: { id: characterId } });
      if (!character) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Personaje no encontrado' });
      }
      this.assertCharacterNearNpc(character, npc);

      const existingSession = await this.prisma.dungeonSession.findUnique({
        where: { characterId },
      });
      if (existingSession) {
        throw new BadRequestException({
          code: 'ALREADY_IN_DUNGEON',
          message: 'Ya estás dentro de la mazmorra',
        });
      }

      const quotaDate = todayUtcDateOnly();
      const quota = await this.prisma.dungeonQuota.findUnique({
        where: { characterId_quotaDate: { characterId, quotaDate } },
      });
      if (quota?.ticketConsumedAt) {
        throw new BadRequestException({
          code: 'TICKET_ALREADY_USED',
          message: 'Ya usaste tu entrada de hoy a la mazmorra',
        });
      }

      const chamberTypes = getAllChamberTypes();
      const chamberType = chamberTypes[Math.floor(Math.random() * chamberTypes.length)]!;
      const chamberDef = getChamberDefinition(chamberType);
      const zoneDef = getWorldZoneDefinition(chamberDef.zoneId);
      if (!zoneDef) {
        throw new Error(`world-zones.json no tiene definida la cámara ${chamberDef.zoneId}`);
      }
      const ticketExpirySeconds = loadDailyDungeonsConfig().ticketExpirySeconds;
      const expiresAt = new Date(Date.now() + ticketExpirySeconds * 1000);

      await this.prisma.$transaction([
        this.prisma.dungeonQuota.upsert({
          where: { characterId_quotaDate: { characterId, quotaDate } },
          create: { characterId, quotaDate, ticketConsumedAt: new Date(), lastChamberType: chamberType },
          update: { ticketConsumedAt: new Date(), lastChamberType: chamberType },
        }),
        this.prisma.dungeonSession.create({
          data: { characterId, chamberType, expiresAt },
        }),
        this.prisma.character.update({
          where: { id: characterId },
          data: {
            currentZoneId: chamberDef.zoneId,
            worldPosX: zoneDef.entrySpawn.worldPos.x,
            worldPosY: zoneDef.entrySpawn.worldPos.y,
            worldPosZ: zoneDef.entrySpawn.worldPos.z,
            worldFacingYaw: zoneDef.entrySpawn.worldFacingYaw,
          },
        }),
      ]);
      this.dungeonTick.scheduleExpiry(characterId, expiresAt);

      return {
        ok: true,
        zoneId: chamberDef.zoneId,
        chamberType,
        chamberDisplayName: chamberDef.displayName,
        expiresAtEpochMs: expiresAt.getTime(),
        entrySpawn: zoneDef.entrySpawn,
        previousZoneId: character.currentZoneId,
      };
    } catch (e) {
      return this.mapErr(e);
    }
  }

  async requestRoomAction(
    characterId: string,
    npcInstanceId: string,
    action: 'next_room' | 'exit' | 'join_party_member',
    targetCharacterId?: string,
  ): Promise<DungeonRoomActionOutcome> {
    try {
      const npc = await this.prisma.npcInstance.findUnique({ where: { id: npcInstanceId } });
      if (!npc || npc.npcTemplateKey !== ROOM_NPC_TEMPLATE_KEY) {
        throw new NotFoundException({ code: 'NPC_NOT_FOUND', message: 'NPC no encontrado' });
      }
      const character = await this.prisma.character.findUnique({ where: { id: characterId } });
      if (!character) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Personaje no encontrado' });
      }
      this.assertCharacterNearNpc(character, npc);

      const session = await this.prisma.dungeonSession.findUnique({ where: { characterId } });
      if (!session) {
        throw new BadRequestException({
          code: 'NO_ACTIVE_SESSION',
          message: 'No tenés una corrida de mazmorra activa',
        });
      }

      if (action === 'exit') {
        this.dungeonTick.cancelScheduledExpiry(characterId);
        await this.prisma.dungeonSession.delete({ where: { characterId } });
        const nexus = getWorldZoneDefinition(NEXUS_ZONE_ID);
        if (!nexus) {
          throw new Error(`world-zones.json no tiene definida ${NEXUS_ZONE_ID}`);
        }
        await this.prisma.character.update({
          where: { id: characterId },
          data: {
            currentZoneId: NEXUS_ZONE_ID,
            worldPosX: nexus.entrySpawn.worldPos.x,
            worldPosY: nexus.entrySpawn.worldPos.y,
            worldPosZ: nexus.entrySpawn.worldPos.z,
            worldFacingYaw: nexus.entrySpawn.worldFacingYaw,
          },
        });
        return {
          ok: true,
          exited: true,
          zoneId: NEXUS_ZONE_ID,
          entrySpawn: nexus.entrySpawn,
          previousZoneId: character.currentZoneId,
        };
      }

      let nextChamberType: DungeonChamberType;
      if (action === 'join_party_member') {
        if (!targetCharacterId) {
          throw new BadRequestException({
            code: 'INVALID_PAYLOAD',
            message: 'targetCharacterId es requerido para unirte a un compañero',
          });
        }
        const targetSession = await this.prisma.dungeonSession.findUnique({
          where: { characterId: targetCharacterId },
        });
        if (!targetSession) {
          throw new BadRequestException({
            code: 'TARGET_NOT_IN_DUNGEON',
            message: 'Ese compañero ya no está en la mazmorra',
          });
        }
        nextChamberType = targetSession.chamberType;
      } else {
        nextChamberType = pickRandomChamberExcluding(session.chamberType);
      }
      const chamberDef = getChamberDefinition(nextChamberType);
      const zoneDef = getWorldZoneDefinition(chamberDef.zoneId);
      if (!zoneDef) {
        throw new Error(`world-zones.json no tiene definida la cámara ${chamberDef.zoneId}`);
      }

      await this.prisma.$transaction([
        this.prisma.dungeonSession.update({
          where: { characterId },
          data: { chamberType: nextChamberType },
        }),
        this.prisma.character.update({
          where: { id: characterId },
          data: {
            currentZoneId: chamberDef.zoneId,
            worldPosX: zoneDef.entrySpawn.worldPos.x,
            worldPosY: zoneDef.entrySpawn.worldPos.y,
            worldPosZ: zoneDef.entrySpawn.worldPos.z,
            worldFacingYaw: zoneDef.entrySpawn.worldFacingYaw,
          },
        }),
      ]);

      return {
        ok: true,
        exited: false,
        zoneId: chamberDef.zoneId,
        chamberType: nextChamberType,
        chamberDisplayName: chamberDef.displayName,
        expiresAtEpochMs: session.expiresAt.getTime(),
        entrySpawn: zoneDef.entrySpawn,
        previousZoneId: character.currentZoneId,
      };
    } catch (e) {
      return this.mapErr(e);
    }
  }

  /**
   * Compañeros de grupo (ya resueltos por `PartyService` en `WorldGateway` — este servicio no
   * depende de Party para evitar el ciclo Dungeon→Party→Combat→Dungeon) con una `DungeonSession`
   * activa en una cámara distinta de la del que pregunta. Usado por el guía de sala para ofrecer
   * "ir a la sala de fulano" en vez de solo el salto aleatorio.
   */
  async listPartyDungeonTargets(
    askerCharacterId: string,
    partyMemberIds: string[],
  ): Promise<DungeonPartyTarget[]> {
    if (partyMemberIds.length === 0) {
      return [];
    }
    const asker = await this.prisma.character.findUnique({
      where: { id: askerCharacterId },
      select: { currentZoneId: true },
    });
    const sessions = await this.prisma.dungeonSession.findMany({
      where: { characterId: { in: partyMemberIds } },
      include: { character: { select: { name: true, currentZoneId: true } } },
    });
    const targets: DungeonPartyTarget[] = [];
    for (const s of sessions) {
      if (!s.character.currentZoneId || s.character.currentZoneId === asker?.currentZoneId) {
        continue;
      }
      const def = getChamberDefinitionByZoneId(s.character.currentZoneId);
      if (!def) {
        continue;
      }
      targets.push({
        characterId: s.characterId,
        name: s.character.name,
        chamberDisplayName: def.displayName,
      });
    }
    return targets;
  }

  private assertCharacterNearNpc(
    character: Character,
    npc: { posX: number; posY: number; posZ: number; zoneId: string | null },
  ): void {
    if (!zonesMatch(character.currentZoneId, npc.zoneId)) {
      throw new BadRequestException({
        code: 'ZONE_MISMATCH',
        message: 'Ese NPC no está en tu zona',
      });
    }
    const ok = this.spatial.isWithinNpcInteractionRange(
      { x: character.worldPosX, y: character.worldPosY, z: character.worldPosZ },
      { x: npc.posX, y: npc.posY, z: npc.posZ },
    );
    if (!ok) {
      throw new BadRequestException({
        code: 'TOO_FAR',
        message: 'Estás demasiado lejos del NPC',
      });
    }
  }

  private mapErr(e: unknown): { ok: false; code: string; message: string } {
    if (e instanceof NotFoundException || e instanceof BadRequestException) {
      const r = e.getResponse();
      if (typeof r === 'object' && r !== null && 'code' in r) {
        const o = r as { code?: string; message?: string };
        return { ok: false, code: o.code ?? 'ERROR', message: o.message ?? e.message };
      }
      return { ok: false, code: 'ERROR', message: e.message };
    }
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: e instanceof Error ? e.message : 'Error inesperado',
    };
  }
}
