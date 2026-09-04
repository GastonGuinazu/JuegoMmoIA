import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Character, GearSlot, ItemInstance, ItemTemplate } from '@prisma/client';
import { GearSlot as GearSlotEnum, ItemInstanceLocation, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CharacterService } from '../character/character.service';
import { StatEngineService } from '../character/stat-engine.service';
import type { EquippedRow } from '../character/stat-engine.service';
import { assertMeetsItemRequirements } from './template-requirements.util';

export interface EquipItemResult {
  equippedItemId: string;
  gearSlot: GearSlot | null;
  displacedItemId: string | null;
  parentItemId: string | null;
  parentSubSlotIndex: number | null;
}

export interface UnequipItemResult {
  unequippedItemId: string;
  previousGearSlot: GearSlot | null;
}

export type CharacterWithInventoryItems = Character & {
  items: (ItemInstance & { template: ItemTemplate })[];
};

const SUB_SLOT_TEST_KIT_CATALOG_KEYS = [
  'initiate_bracelet',
  'initiate_talisman_power',
  'initiate_talisman_swiftness',
] as const;

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly characterService: CharacterService,
    private readonly statEngine: StatEngineService,
  ) {}

  /**
   * Inventario + equipo + personaje para UI (Weaver). Una query con ítems en INVENTORY | EQUIPPED.
   */
  async getProgressSnapshot(characterId: string): Promise<{
    character: CharacterWithInventoryItems;
    vitals: { currentHp: number; maxHp: number };
  }> {
    const character = await this.prisma.character.findUnique({
      where: { id: characterId },
      include: {
        items: {
          where: {
            location: {
              in: [ItemInstanceLocation.INVENTORY, ItemInstanceLocation.EQUIPPED],
            },
          },
          include: { template: true },
        },
      },
    });
    if (!character) {
      throw new NotFoundException(`Character not found: ${characterId}`);
    }
    const vitals = this.statEngine.getCombatVitalsFromLoaded(
      character as Character & { items: EquippedRow[] },
    );
    return { character: character as CharacterWithInventoryItems, vitals };
  }

  async equipItem(
    characterId: string,
    itemId: string,
    slot: string | number,
    parentItemId?: string,
  ): Promise<{
    inventory: EquipItemResult;
    character: Character;
  }> {
    return this.prisma.$transaction(
      async (tx) => {
        const character = await tx.character.findUnique({
          where: { id: characterId },
        });
        if (!character) {
          throw new NotFoundException(`Character not found: ${characterId}`);
        }

        const item = await tx.itemInstance.findUnique({
          where: { id: itemId },
          include: { template: true },
        });
        if (!item || item.ownerId !== characterId) {
          throw new NotFoundException(
            `Item ${itemId} not found or not owned by this character`,
          );
        }

        if (item.quantity !== 1) {
          throw new BadRequestException({
            code: 'ITEM_STACK_NOT_EQUIPABLE',
            message: 'Only single-quantity instances can be equipped',
          });
        }

        if (parentItemId) {
          return this.equipIntoParent({
            tx,
            character,
            item,
            slot,
            parentItemId,
          });
        }

        return this.equipTopLevel({
          tx,
          character,
          item,
          slot,
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  private async equipTopLevel(params: {
    tx: Prisma.TransactionClient;
    character: Character;
    item: ItemInstance & { template: ItemTemplate };
    slot: string | number;
  }): Promise<{
    inventory: EquipItemResult;
    character: Character;
  }> {
    const { tx, character, item, slot } = params;
    const requestedSlot = this.parseRequestedGearSlot(slot);
    const baseSlot = item.template.baseSlot;
    if (!baseSlot) {
      throw new BadRequestException({
        code: 'ITEM_NOT_EQUIPPABLE',
        message: 'This item has no equipment slot (template.baseSlot is null)',
      });
    }
    if (!this.allowedGearSlotsForTemplate(baseSlot).includes(requestedSlot)) {
      throw new BadRequestException({
        code: 'INVALID_GEAR_SLOT_FOR_ITEM',
        message: `Item cannot be equipped in slot ${requestedSlot}`,
      });
    }

        if (item.location !== ItemInstanceLocation.INVENTORY) {
      if (
        !(
          item.location === ItemInstanceLocation.EQUIPPED &&
          item.parentItemInstanceId === null &&
          item.gearSlot === requestedSlot
        )
      ) {
          throw new BadRequestException({
            code: 'ITEM_MUST_BE_IN_INVENTORY_TO_EQUIP',
            message: 'Item must be in inventory to equip',
          });
        }
    }

        assertMeetsItemRequirements(
          {
            level: character.level,
            statStr: character.statStr,
            statAgi: character.statAgi,
            statVit: character.statVit,
            statEne: character.statEne,
          },
          item.template.baseStats,
        );

    const displaced = await tx.itemInstance.findFirst({
      where: {
        ownerId: character.id,
        location: ItemInstanceLocation.EQUIPPED,
        gearSlot: requestedSlot,
        parentItemInstanceId: null,
      },
    });

    let displacedItemId: string | null = null;
    if (displaced && displaced.id !== item.id) {
      await this.moveItemTreeToInventory(tx, displaced.id);
      displacedItemId = displaced.id;
    }

    await tx.itemInstance.update({
      where: { id: item.id },
      data: {
        location: ItemInstanceLocation.EQUIPPED,
        gearSlot: requestedSlot,
        parentItemInstanceId: null,
        parentSubSlotIndex: null,
        rowVersion: { increment: 1 },
      },
    });

    const updatedChar = await this.characterService.recalculateDerivedStats(
      character.id,
      tx,
    );

    return {
      inventory: {
        equippedItemId: item.id,
        gearSlot: requestedSlot,
        displacedItemId,
        parentItemId: null,
        parentSubSlotIndex: null,
      },
      character: updatedChar,
    };
  }

  private async equipIntoParent(params: {
    tx: Prisma.TransactionClient;
    character: Character;
    item: ItemInstance & { template: ItemTemplate };
    slot: string | number;
    parentItemId: string;
  }): Promise<{
    inventory: EquipItemResult;
    character: Character;
  }> {
    const { tx, character, item, slot, parentItemId } = params;
    const parent = await tx.itemInstance.findUnique({
      where: { id: parentItemId },
      include: { template: true },
    });
    if (!parent || parent.ownerId !== character.id) {
      throw new NotFoundException(`Parent item not found: ${parentItemId}`);
    }
    if (parent.location !== ItemInstanceLocation.EQUIPPED) {
      throw new BadRequestException({
        code: 'PARENT_NOT_EQUIPPED',
        message: 'Parent item must be currently equipped',
      });
    }
    if (!parent.template.hasSubSlots || parent.template.maxSubSlots <= 0) {
      throw new BadRequestException({
        code: 'PARENT_HAS_NO_SUB_SLOTS',
        message: 'Parent item does not provide sub-slots',
      });
    }
    if (!parent.template.subSlotType) {
      throw new BadRequestException({
        code: 'PARENT_SUB_SLOT_TYPE_UNDEFINED',
        message: 'Parent item sub-slot type is not configured',
      });
    }
    if (!item.template.parentSlotType) {
      throw new BadRequestException({
        code: 'ITEM_NOT_NESTED_EQUIPPABLE',
        message: 'This item cannot be equipped into a parent container',
      });
    }
    assertMeetsItemRequirements(
      {
        level: character.level,
        statStr: character.statStr,
        statAgi: character.statAgi,
        statVit: character.statVit,
        statEne: character.statEne,
      },
      item.template.baseStats,
    );
    if (item.template.parentSlotType !== parent.template.subSlotType) {
      throw new BadRequestException({
        code: 'PARENT_SLOT_TYPE_MISMATCH',
        message: 'Item parentSlotType does not match parent subSlotType',
      });
    }

    const subSlotIndex = this.parseSubSlotIndex(slot, parent.template.maxSubSlots);
    if (item.id === parent.id) {
      throw new BadRequestException({
        code: 'INVALID_PARENT_RELATION',
        message: 'Item cannot be equipped inside itself',
      });
    }
    const ancestry = await this.collectAncestorIds(tx, parent.id);
    if (ancestry.has(item.id)) {
      throw new BadRequestException({
        code: 'INVALID_PARENT_CYCLE',
        message: 'Recursive cycle detected in nested equipment chain',
      });
    }

    if (
      item.location === ItemInstanceLocation.EQUIPPED &&
      item.parentItemInstanceId === parent.id &&
      item.parentSubSlotIndex === subSlotIndex
    ) {
      const updatedChar = await this.characterService.recalculateDerivedStats(
        character.id,
        tx,
      );
      return {
        inventory: {
          equippedItemId: item.id,
          gearSlot: null,
          displacedItemId: null,
          parentItemId: parent.id,
          parentSubSlotIndex: subSlotIndex,
        },
        character: updatedChar,
      };
    }

    const displaced = await tx.itemInstance.findFirst({
      where: {
        ownerId: character.id,
        location: ItemInstanceLocation.EQUIPPED,
        parentItemInstanceId: parent.id,
        parentSubSlotIndex: subSlotIndex,
      },
    });
    let displacedItemId: string | null = null;
    if (displaced && displaced.id !== item.id) {
      await this.moveItemTreeToInventory(tx, displaced.id);
      displacedItemId = displaced.id;
    }

    await tx.itemInstance.update({
      where: { id: item.id },
      data: {
        location: ItemInstanceLocation.EQUIPPED,
        gearSlot: null,
        parentItemInstanceId: parent.id,
        parentSubSlotIndex: subSlotIndex,
        rowVersion: { increment: 1 },
      },
    });

    const updatedChar = await this.characterService.recalculateDerivedStats(
      character.id,
      tx,
    );
    return {
      inventory: {
        equippedItemId: item.id,
        gearSlot: null,
        displacedItemId,
        parentItemId: parent.id,
        parentSubSlotIndex: subSlotIndex,
      },
      character: updatedChar,
    };
  }

  private parseRequestedGearSlot(slot: string | number): GearSlot {
    if (typeof slot !== 'string') {
      throw new BadRequestException({
        code: 'INVALID_SLOT',
        message: 'Top-level slot must be a GearSlot string',
      });
    }
    if (!Object.values(GearSlotEnum).includes(slot as GearSlot)) {
      throw new BadRequestException({
        code: 'INVALID_SLOT',
        message: `Unknown gear slot: ${slot}`,
      });
    }
    return slot as GearSlot;
  }

  private parseSubSlotIndex(slot: string | number, maxSubSlots: number): number {
    const parsed =
      typeof slot === 'number'
        ? slot
        : typeof slot === 'string'
          ? Number.parseInt(slot, 10)
          : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= maxSubSlots) {
      throw new BadRequestException({
        code: 'INVALID_SUB_SLOT_INDEX',
        message: `Sub-slot index must be between 0 and ${maxSubSlots - 1}`,
      });
    }
    return Math.floor(parsed);
  }

  private allowedGearSlotsForTemplate(baseSlot: GearSlot): GearSlot[] {
    if (baseSlot === GearSlotEnum.RING_1 || baseSlot === GearSlotEnum.RING_2) {
      return [GearSlotEnum.RING_1, GearSlotEnum.RING_2];
    }
    if (
      baseSlot === GearSlotEnum.EARRING_1 ||
      baseSlot === GearSlotEnum.EARRING_2
    ) {
      return [GearSlotEnum.EARRING_1, GearSlotEnum.EARRING_2];
    }
    if (
      baseSlot === GearSlotEnum.BRACELET_1 ||
      baseSlot === GearSlotEnum.BRACELET_2
    ) {
      return [GearSlotEnum.BRACELET_1, GearSlotEnum.BRACELET_2];
    }
    return [baseSlot];
  }

  private async collectAncestorIds(
    tx: Prisma.TransactionClient,
    startId: string,
  ): Promise<Set<string>> {
    const set = new Set<string>();
    let current: string | null = startId;
    while (current) {
      const row: { parentItemInstanceId: string | null } | null =
        await tx.itemInstance.findUnique({
        where: { id: current },
        select: { parentItemInstanceId: true },
      });
      if (!row?.parentItemInstanceId) {
        break;
      }
      set.add(row.parentItemInstanceId);
      current = row.parentItemInstanceId;
    }
    return set;
  }

  private async collectDescendantIds(
    tx: Prisma.TransactionClient,
    rootItemId: string,
  ): Promise<string[]> {
    const out: string[] = [];
    let frontier = [rootItemId];
    while (frontier.length > 0) {
      const rows = await tx.itemInstance.findMany({
        where: { parentItemInstanceId: { in: frontier } },
        select: { id: true },
      });
      if (rows.length === 0) {
        break;
      }
      const ids = rows.map((r) => r.id);
      out.push(...ids);
      frontier = ids;
    }
    return out;
  }

  private async moveItemTreeToInventory(
    tx: Prisma.TransactionClient,
    rootItemId: string,
  ): Promise<void> {
    const descendants = await this.collectDescendantIds(tx, rootItemId);
    const all = [rootItemId, ...descendants];
    for (const id of all) {
      await tx.itemInstance.update({
        where: { id },
        data: {
          location: ItemInstanceLocation.INVENTORY,
          gearSlot: null,
          parentItemInstanceId: null,
          parentSubSlotIndex: null,
          rowVersion: { increment: 1 },
        },
      });
    }
  }

  async unequipItem(
    characterId: string,
    itemId: string,
  ): Promise<{
    inventory: UnequipItemResult;
    character: Character;
  }> {
    const { inventory, character } = await this.prisma.$transaction(
      async (tx) => {
        const characterRow = await tx.character.findUnique({
          where: { id: characterId },
        });
        if (!characterRow) {
          throw new NotFoundException(`Character not found: ${characterId}`);
        }

        const item = await tx.itemInstance.findUnique({
          where: { id: itemId },
          include: { template: true },
        });
        if (!item || item.ownerId !== characterId) {
          throw new NotFoundException(
            `Item ${itemId} not found or not owned by this character`,
          );
        }

        if (item.location !== ItemInstanceLocation.EQUIPPED) {
          throw new BadRequestException({
            code: 'ITEM_NOT_EQUIPPED',
            message: 'Item is not equipped',
          });
        }

        if (item.quantity !== 1) {
          throw new BadRequestException({
            code: 'ITEM_STACK_NOT_UNEQUIPABLE',
            message: 'Only single-quantity equipped instances can be unequipped',
          });
        }

        const previousGearSlot = item.gearSlot;

        await this.moveItemTreeToInventory(tx, itemId);

        const updatedChar = await this.characterService.recalculateDerivedStats(
          characterId,
          tx,
        );

        return {
          inventory: {
            unequippedItemId: itemId,
            previousGearSlot,
          },
          character: updatedChar,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    return { inventory, character };
  }

  async spawnSubSlotTestKitForCharacter(
    characterName = 'ilovethecoco',
  ): Promise<{
    characterId: string;
    spawnedItemInstanceIds: string[];
  }> {
    return this.prisma.$transaction(
      async (tx) => {
        const matchingCharacters = await tx.character.findMany({
          where: { name: characterName },
          select: { id: true },
          take: 2,
        });
        if (matchingCharacters.length === 0) {
          throw new NotFoundException(
            `Character not found for test kit: ${characterName}`,
          );
        }
        if (matchingCharacters.length > 1) {
          throw new ConflictException({
            code: 'AMBIGUOUS_CHARACTER_NAME',
            message:
              'More than one character matches this name; use a unique target before spawning test kit.',
          });
        }

        const characterId = matchingCharacters[0]!.id;
        const templates = await tx.itemTemplate.findMany({
          where: { catalogKey: { in: [...SUB_SLOT_TEST_KIT_CATALOG_KEYS] } },
          select: { id: true, catalogKey: true },
        });
        const templateIdByCatalogKey = new Map(
          templates.map((row) => [row.catalogKey, row.id] as const),
        );
        const missing = SUB_SLOT_TEST_KIT_CATALOG_KEYS.filter(
          (catalogKey) => !templateIdByCatalogKey.has(catalogKey),
        );
        if (missing.length > 0) {
          throw new NotFoundException(
            `Missing item templates for test kit: ${missing.join(', ')}`,
          );
        }

        const spawnedItemInstanceIds: string[] = [];
        for (const catalogKey of SUB_SLOT_TEST_KIT_CATALOG_KEYS) {
          const itemTemplateId = templateIdByCatalogKey.get(catalogKey);
          if (!itemTemplateId) {
            throw new NotFoundException(
              `Missing template id for catalog key: ${catalogKey}`,
            );
          }
          const created = await tx.itemInstance.create({
            data: {
              ownerId: characterId,
              itemTemplateId,
              quantity: 1,
              location: ItemInstanceLocation.INVENTORY,
              gearSlot: null,
              parentItemInstanceId: null,
              parentSubSlotIndex: null,
            },
            select: { id: true },
          });
          spawnedItemInstanceIds.push(created.id);
        }

        return {
          characterId,
          spawnedItemInstanceIds,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  }

  /**
   * Consume una unidad de un stack en INVENTORY (Ledger). Serializable para carreras entre sockets.
   */
  async consumeOneInventoryStack(
    characterId: string,
    itemInstanceId: string,
  ): Promise<{ character: CharacterWithInventoryItems }> {
    const { character } = await this.prisma.$transaction(
      async (tx) => {
        const item = await tx.itemInstance.findUnique({
          where: { id: itemInstanceId },
          include: { template: true },
        });
        if (!item || item.ownerId !== characterId) {
          throw new BadRequestException({
            code: 'ITEM_NOT_FOUND',
            message: 'Item not found or not owned by this character',
          });
        }
        if (item.location !== ItemInstanceLocation.INVENTORY) {
          throw new BadRequestException({
            code: 'ITEM_NOT_IN_INVENTORY',
            message: 'Item must be in inventory to use',
          });
        }
        if (item.quantity < 1) {
          throw new BadRequestException({
            code: 'ITEM_QUANTITY_ZERO',
            message: 'No quantity left to consume',
          });
        }

        if (item.quantity <= 1) {
          await tx.itemInstance.delete({ where: { id: itemInstanceId } });
        } else {
          await tx.itemInstance.update({
            where: { id: itemInstanceId },
            data: {
              quantity: { decrement: 1 },
              rowVersion: { increment: 1 },
            },
          });
        }

        const character = await tx.character.findUnique({
          where: { id: characterId },
          include: {
            items: {
              where: {
                location: {
                  in: [ItemInstanceLocation.INVENTORY, ItemInstanceLocation.EQUIPPED],
                },
              },
              include: { template: true },
            },
          },
        });
        if (!character) {
          throw new NotFoundException(`Character not found: ${characterId}`);
        }
        return { character: character as CharacterWithInventoryItems };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    return { character };
  }
}
