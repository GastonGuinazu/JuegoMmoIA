import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ItemInstanceLocation, Prisma } from '@prisma/client';
import { mapInventoryItemInstanceToRow } from '../inventory/inventory-item-row.mapper';
import type { CharacterWithInventoryItems } from '../inventory/inventory.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorldSpatialService } from './world-spatial.service';
import { zonesMatch } from './world-zone.util';

@Injectable()
export class WorldDropService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: WorldSpatialService,
    private readonly inventoryService: InventoryService,
  ) {}

  /**
   * Mueve un WORLD_DROP al inventario del personaje (merge por plantilla) o rechaza con código estable.
   */
  async pickWorldDrop(
    characterId: string,
    itemInstanceId: string,
  ): Promise<
    | {
        ok: true;
        character: CharacterWithInventoryItems;
        vitals: { currentHp: number; maxHp: number };
        itemRows: ReturnType<typeof mapInventoryItemInstanceToRow>[];
        adena: string;
        pickedItemDisplayName: string;
        pickedQuantity: number;
      }
    | { ok: false; code: string; message: string }
  > {
    const maxTxAttempts = 6;
    for (let attempt = 1; attempt <= maxTxAttempts; attempt++) {
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            const character = await tx.character.findUnique({
              where: { id: characterId },
            });
            if (!character) {
              throw new NotFoundException(`Character not found: ${characterId}`);
            }

            const item = await tx.itemInstance.findUnique({
              where: { id: itemInstanceId },
              include: { template: true },
            });
            if (!item || item.location !== ItemInstanceLocation.WORLD_DROP) {
              throw new NotFoundException({
                code: 'DROP_NOT_FOUND',
                message: 'Drop not found or already picked',
              });
            }

            const pickedItemDisplayName = item.template.name;
            const pickedQuantity = item.quantity;

            if (
              item.worldDropPosX === null ||
              item.worldDropPosY === null ||
              item.worldDropPosZ === null
            ) {
              throw new BadRequestException({
                code: 'DROP_INVALID_STATE',
                message: 'Drop has no world position',
              });
            }

            if (!zonesMatch(character.currentZoneId, item.worldDropZoneId)) {
              throw new BadRequestException({
                code: 'ZONE_MISMATCH',
                message: 'Drop is not in your current zone',
              });
            }

            const now = Date.now();
            if (
              item.worldDropReservedUntil &&
              item.worldDropReservedUntil.getTime() > now &&
              item.worldDropReservedForCharacterId &&
              item.worldDropReservedForCharacterId !== characterId
            ) {
              throw new BadRequestException({
                code: 'DROP_RESERVED',
                message: 'Only the killer can pick this drop for a few seconds',
              });
            }

            const inRange = this.spatial.isWithinWorldDropPickupRange(
              {
                x: character.worldPosX,
                y: character.worldPosY,
                z: character.worldPosZ,
              },
              {
                x: item.worldDropPosX,
                y: item.worldDropPosY,
                z: item.worldDropPosZ,
              },
            );
            if (!inRange) {
              throw new BadRequestException({
                code: 'TOO_FAR',
                message: 'You are too far from this drop',
              });
            }

            const stack = await tx.itemInstance.findFirst({
              where: {
                ownerId: characterId,
                itemTemplateId: item.itemTemplateId,
                location: ItemInstanceLocation.INVENTORY,
              },
            });

            if (stack && stack.id !== item.id) {
              await tx.itemInstance.update({
                where: { id: stack.id },
                data: {
                  quantity: { increment: item.quantity },
                  rowVersion: { increment: 1 },
                },
              });
              await tx.itemInstance.delete({ where: { id: item.id } });
            } else {
              await tx.itemInstance.update({
                where: { id: item.id },
                data: {
                  ownerId: characterId,
                  location: ItemInstanceLocation.INVENTORY,
                  worldDropZoneId: null,
                  worldDropPosX: null,
                  worldDropPosY: null,
                  worldDropPosZ: null,
                  worldDropReservedForCharacterId: null,
                  worldDropReservedUntil: null,
                  rowVersion: { increment: 1 },
                },
              });
            }

            return { characterId, pickedItemDisplayName, pickedQuantity };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          },
        );

        const snap = await this.inventoryService.getProgressSnapshot(
          result.characterId,
        );
        const itemRows = snap.character.items.map((row) =>
          mapInventoryItemInstanceToRow(row, snap.character.items),
        );
        const wallet = await this.prisma.wallet.findUnique({
          where: { accountId: snap.character.accountId },
          select: { adena: true },
        });
        return {
          ok: true,
          character: snap.character,
          vitals: snap.vitals,
          itemRows,
          adena: (wallet?.adena ?? 0n).toString(),
          pickedItemDisplayName: result.pickedItemDisplayName,
          pickedQuantity: result.pickedQuantity,
        };
      } catch (e) {
        const retryable =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2034' &&
          attempt < maxTxAttempts;
        if (retryable) {
          await new Promise((r) =>
            setTimeout(r, 12 * attempt + Math.floor(Math.random() * 20)),
          );
          continue;
        }
        return this.mapPickError(e);
      }
    }
    return {
      ok: false,
      code: 'SERIALIZATION_CONFLICT',
      message: 'Could not pick item; try again',
    };
  }

  private mapPickError(
    e: unknown,
  ): { ok: false; code: string; message: string } {
    if (e instanceof NotFoundException) {
      const r = e.getResponse();
      if (typeof r === 'object' && r !== null && 'code' in r) {
        const o = r as { code?: string; message?: string };
        return {
          ok: false,
          code: o.code ?? 'NOT_FOUND',
          message: o.message ?? e.message,
        };
      }
      return { ok: false, code: 'NOT_FOUND', message: e.message };
    }
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
    return {
      ok: false,
      code: 'INTERNAL',
      message: e instanceof Error ? e.message : 'Unexpected error',
    };
  }
}
