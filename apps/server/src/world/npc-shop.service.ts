import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { Character } from '@prisma/client';
import { ItemInstanceLocation, Prisma } from '@prisma/client';
import { mapInventoryItemInstanceToRow } from '../inventory/inventory-item-row.mapper';
import type { CharacterWithInventoryItems } from '../inventory/inventory.service';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorldSpatialService } from './world-spatial.service';
import { getShopOffersForNpcTemplateKey } from './npc-shops.loaders';
import type { WsNpcInteractAckPayload, WsNpcShopOfferDto } from '@aetheris/shared-types';
import { zonesMatch } from './world-zone.util';

function sellUnitPriceFromBuy(buyAdena: bigint): bigint {
  return buyAdena / 3n;
}

function readMaxStackFromTemplate(baseStats: unknown): number {
  if (!baseStats || typeof baseStats !== 'object') {
    return 99;
  }
  const raw = (baseStats as { maxStack?: unknown }).maxStack;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return 99;
  }
  return Math.min(9999, Math.floor(n));
}

@Injectable()
export class NpcShopService implements OnModuleInit {
  private readonly logger = new Logger(NpcShopService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spatial: WorldSpatialService,
    private readonly inventoryService: InventoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    const existing = await this.prisma.npcInstance.findFirst({
      where: { npcTemplateKey: 'merchant_aetheris' },
    });
    if (existing) {
      return;
    }
    await this.prisma.npcInstance.create({
      data: {
        npcTemplateKey: 'merchant_aetheris',
        displayName: 'Mercader de Aetheris',
        posX: 5,
        posY: 0,
        posZ: 5,
        zoneId: 'Zone_0',
      },
    });
    this.logger.log('Seeded NpcInstance: Mercader de Aetheris (5, 0, 5).');
  }

  buildOfferLines(npcTemplateKey: string): WsNpcShopOfferDto[] {
    const offers = getShopOffersForNpcTemplateKey(npcTemplateKey);
    return offers.map((o) => {
      const buy = BigInt(Math.max(0, Math.floor(o.buyPriceAdena)));
      const sell = sellUnitPriceFromBuy(buy);
      return {
        catalogKey: o.catalogKey,
        itemDisplayName: o.catalogKey,
        buyPriceAdena: buy.toString(),
        sellPriceAdena: sell.toString(),
      };
    });
  }

  isMerchantTemplate(npcTemplateKey: string): boolean {
    return this.buildOfferLines(npcTemplateKey).length > 0;
  }

  /** Enriquece nombres para UI (Ledger / catálogo). */
  async previewNpcShop(
    characterId: string,
    npcInstanceId: string,
  ): Promise<WsNpcInteractAckPayload> {
    try {
      const npc = await this.prisma.npcInstance.findUnique({
        where: { id: npcInstanceId },
      });
      if (!npc) {
        return { ok: false, code: 'NPC_NOT_FOUND', message: 'NPC no encontrado' };
      }
      const character = await this.prisma.character.findUnique({
        where: { id: characterId },
      });
      if (!character) {
        return { ok: false, code: 'NOT_FOUND', message: 'Personaje no encontrado' };
      }
      this.assertCharacterNearNpc(character, npc);
      const rawLines = this.buildOfferLines(npc.npcTemplateKey);
      const offers = await this.resolveOfferDisplayNames(rawLines);
      return {
        ok: true,
        npcInstanceId: npc.id,
        displayName: npc.displayName,
        npcTemplateKey: npc.npcTemplateKey,
        offers,
      };
    } catch (e) {
      return this.mapInteractErr(e);
    }
  }

  private mapInteractErr(e: unknown): { ok: false; code: string; message: string } {
    const r = this.mapErr(e);
    return r;
  }

  async resolveOfferDisplayNames(lines: WsNpcShopOfferDto[]): Promise<WsNpcShopOfferDto[]> {
    if (lines.length === 0) {
      return [];
    }
    const keys = lines.map((l) => l.catalogKey);
    const templates = await this.prisma.itemTemplate.findMany({
      where: { catalogKey: { in: keys } },
      select: { catalogKey: true, name: true },
    });
    const nameByKey = new Map(
      templates.map((t) => [t.catalogKey as string, t.name] as const),
    );
    return lines.map((l) => ({
      ...l,
      itemDisplayName: nameByKey.get(l.catalogKey) ?? l.catalogKey,
    }));
  }

  async buyFromNpc(params: {
    characterId: string;
    npcInstanceId: string;
    catalogKey: string;
    quantity: number;
  }): Promise<
    | {
        ok: true;
        character: CharacterWithInventoryItems;
        items: ReturnType<typeof mapInventoryItemInstanceToRow>[];
        adena: string;
      }
    | { ok: false; code: string; message: string }
  > {
    const qty = Math.floor(params.quantity);
    if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
      return { ok: false, code: 'INVALID_QUANTITY', message: 'Cantidad inválida (1–999)' };
    }

    const maxTxAttempts = 6;
    for (let attempt = 1; attempt <= maxTxAttempts; attempt++) {
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            const npc = await tx.npcInstance.findUnique({
              where: { id: params.npcInstanceId },
            });
            if (!npc) {
              throw new NotFoundException({
                code: 'NPC_NOT_FOUND',
                message: 'NPC no encontrado',
              });
            }

            const character = await tx.character.findUnique({
              where: { id: params.characterId },
            });
            if (!character) {
              throw new NotFoundException(`Character not found: ${params.characterId}`);
            }
            this.assertCharacterNearNpc(character, npc);

            const offers = getShopOffersForNpcTemplateKey(npc.npcTemplateKey);
            const offer = offers.find((o) => o.catalogKey === params.catalogKey);
            if (!offer) {
              throw new BadRequestException({
                code: 'NOT_IN_STOCK',
                message: 'Este mercader no vende ese ítem',
              });
            }

            const unitPrice = BigInt(Math.max(0, Math.floor(offer.buyPriceAdena)));
            if (unitPrice <= 0n) {
              throw new BadRequestException({
                code: 'INVALID_PRICE',
                message: 'Precio de tienda inválido',
              });
            }
            const total = unitPrice * BigInt(qty);

            await tx.wallet.upsert({
              where: { accountId: character.accountId },
              create: { accountId: character.accountId, adena: 0n },
              update: {},
            });
            const wallet = await tx.wallet.findUnique({
              where: { accountId: character.accountId },
            });
            const have = wallet?.adena ?? 0n;
            if (have < total) {
              throw new BadRequestException({
                code: 'INSUFFICIENT_ADENA',
                message: 'No tenés suficiente Adena',
              });
            }

            await tx.wallet.update({
              where: { accountId: character.accountId },
              data: { adena: { decrement: total } },
            });

            const tpl = await tx.itemTemplate.findUnique({
              where: { catalogKey: params.catalogKey },
            });
            if (!tpl) {
              throw new NotFoundException({
                code: 'ITEM_TEMPLATE_MISSING',
                message: 'Plantilla de ítem no sincronizada en el servidor',
              });
            }

            const maxStack = tpl.baseSlot ? 1 : readMaxStackFromTemplate(tpl.baseStats);

            if (maxStack === 1) {
              for (let i = 0; i < qty; i++) {
                await tx.itemInstance.create({
                  data: {
                    ownerId: params.characterId,
                    itemTemplateId: tpl.id,
                    quantity: 1,
                    location: ItemInstanceLocation.INVENTORY,
                  },
                });
              }
            } else {
              const stack = await tx.itemInstance.findFirst({
                where: {
                  ownerId: params.characterId,
                  itemTemplateId: tpl.id,
                  location: ItemInstanceLocation.INVENTORY,
                },
              });
              if (stack) {
                const nextQty = stack.quantity + qty;
                if (nextQty > maxStack) {
                  throw new BadRequestException({
                    code: 'INVENTORY_STACK_CAP',
                    message: `No caben más de ${maxStack} en el stack`,
                  });
                }
                await tx.itemInstance.update({
                  where: { id: stack.id },
                  data: { quantity: nextQty, rowVersion: { increment: 1 } },
                });
              } else {
                if (qty > maxStack) {
                  throw new BadRequestException({
                    code: 'INVENTORY_STACK_CAP',
                    message: `No caben más de ${maxStack} en un stack`,
                  });
                }
                await tx.itemInstance.create({
                  data: {
                    ownerId: params.characterId,
                    itemTemplateId: tpl.id,
                    quantity: qty,
                    location: ItemInstanceLocation.INVENTORY,
                  },
                });
              }
            }

            return { characterId: params.characterId };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        const snap = await this.inventoryService.getProgressSnapshot(result.characterId);
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
          items: itemRows,
          adena: (wallet?.adena ?? 0n).toString(),
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
        return this.mapErr(e);
      }
    }
    return {
      ok: false,
      code: 'SERIALIZATION_CONFLICT',
      message: 'La tienda está ocupada; probá de nuevo',
    };
  }

  async sellToNpc(params: {
    characterId: string;
    npcInstanceId: string;
    itemInstanceId: string;
    quantity: number;
  }): Promise<
    | {
        ok: true;
        character: CharacterWithInventoryItems;
        items: ReturnType<typeof mapInventoryItemInstanceToRow>[];
        adena: string;
      }
    | { ok: false; code: string; message: string }
  > {
    const qty = Math.floor(params.quantity);
    if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
      return { ok: false, code: 'INVALID_QUANTITY', message: 'Cantidad inválida (1–999)' };
    }

    const maxTxAttempts = 6;
    for (let attempt = 1; attempt <= maxTxAttempts; attempt++) {
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            const npc = await tx.npcInstance.findUnique({
              where: { id: params.npcInstanceId },
            });
            if (!npc) {
              throw new NotFoundException({
                code: 'NPC_NOT_FOUND',
                message: 'NPC no encontrado',
              });
            }
            const sellerCharacter = await tx.character.findUnique({
              where: { id: params.characterId },
            });
            if (!sellerCharacter) {
              throw new NotFoundException(`Character not found: ${params.characterId}`);
            }
            this.assertCharacterNearNpc(sellerCharacter, npc);

            const offers = getShopOffersForNpcTemplateKey(npc.npcTemplateKey);
            const item = await tx.itemInstance.findUnique({
              where: { id: params.itemInstanceId },
              include: { template: true },
            });
            if (!item || item.ownerId !== params.characterId) {
              throw new NotFoundException({
                code: 'ITEM_NOT_FOUND',
                message: 'Ítem no encontrado en tu inventario',
              });
            }
            if (item.location !== ItemInstanceLocation.INVENTORY) {
              throw new BadRequestException({
                code: 'ITEM_NOT_IN_BAG',
                message: 'Solo podés vender ítems de la mochila',
              });
            }
            const ck = item.template.catalogKey;
            if (!ck) {
              throw new BadRequestException({
                code: 'ITEM_NOT_SELLABLE',
                message: 'Este ítem no se puede vender aquí',
              });
            }
            const offer = offers.find((o) => o.catalogKey === ck);
            if (!offer) {
              throw new BadRequestException({
                code: 'MERCHANT_WONT_BUY',
                message: 'Este mercader no compra ese ítem',
              });
            }
            const unitBuy = BigInt(Math.max(0, Math.floor(offer.buyPriceAdena)));
            const unitSell = sellUnitPriceFromBuy(unitBuy);
            if (unitSell <= 0n) {
              throw new BadRequestException({
                code: 'INVALID_PRICE',
                message: 'Precio de reventa inválido',
              });
            }
            if (item.quantity < qty) {
              throw new BadRequestException({
                code: 'INSUFFICIENT_QUANTITY',
                message: 'No tenés esa cantidad',
              });
            }

            const totalGain = unitSell * BigInt(qty);

            if (item.quantity === qty) {
              await tx.itemInstance.delete({ where: { id: item.id } });
            } else {
              await tx.itemInstance.update({
                where: { id: item.id },
                data: {
                  quantity: item.quantity - qty,
                  rowVersion: { increment: 1 },
                },
              });
            }

            await tx.wallet.upsert({
              where: { accountId: sellerCharacter.accountId },
              create: { accountId: sellerCharacter.accountId, adena: totalGain },
              update: { adena: { increment: totalGain } },
            });

            return { characterId: params.characterId };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        const snap = await this.inventoryService.getProgressSnapshot(result.characterId);
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
          items: itemRows,
          adena: (wallet?.adena ?? 0n).toString(),
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
        return this.mapErr(e);
      }
    }
    return {
      ok: false,
      code: 'SERIALIZATION_CONFLICT',
      message: 'La tienda está ocupada; probá de nuevo',
    };
  }

  private assertCharacterNearNpc(
    character: Character,
    npc: { posX: number; posY: number; posZ: number; zoneId: string | null },
  ): void {
    if (!zonesMatch(character.currentZoneId, npc.zoneId)) {
      throw new BadRequestException({
        code: 'ZONE_MISMATCH',
        message: 'El mercader no está en tu zona',
      });
    }
    const ok = this.spatial.isWithinNpcInteractionRange(
      { x: character.worldPosX, y: character.worldPosY, z: character.worldPosZ },
      { x: npc.posX, y: npc.posY, z: npc.posZ },
    );
    if (!ok) {
      throw new BadRequestException({
        code: 'TOO_FAR',
        message: 'Estás demasiado lejos del mercader',
      });
    }
  }

  private mapErr(
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
    this.logger.warn(`[NpcShop] ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, code: 'INTERNAL', message: 'Error inesperado en la tienda' };
  }
}
