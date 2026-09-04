import { Controller, HttpCode, Post } from '@nestjs/common';
import { StatEngineService } from '../character/stat-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildCharacterSheetDto } from './inventory-character-dto.util';
import { mapInventoryItemInstanceToRow } from './inventory-item-row.mapper';
import {
  InventoryService,
  type CharacterWithInventoryItems,
} from './inventory.service';

const SUB_SLOT_TEST_CHARACTER_NAME = 'ilovethecoco';

@Controller('test')
export class InventoryTestController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly statEngine: StatEngineService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('spawn-kit')
  @HttpCode(200)
  async spawnSubSlotTestKit(): Promise<{
    characterId: string;
    targetName: string;
    spawnedItemInstanceIds: string[];
    items: ReturnType<typeof mapInventoryItemInstanceToRow>[];
    character: ReturnType<typeof buildCharacterSheetDto>;
    adena: string;
  }> {
    const spawn = await this.inventoryService.spawnSubSlotTestKitForCharacter(
      SUB_SLOT_TEST_CHARACTER_NAME,
    );
    const snap = await this.inventoryService.getProgressSnapshot(spawn.characterId);
    const items = snap.character.items.map((row) =>
      mapInventoryItemInstanceToRow(row, snap.character.items),
    );
    const wallet = await this.prisma.wallet.findUnique({
      where: { accountId: snap.character.accountId },
      select: { adena: true },
    });
    const effectiveCore = this.statEngine.computeEffectiveCoreForLoadedCharacter(
      snap.character as CharacterWithInventoryItems,
    );
    return {
      characterId: spawn.characterId,
      targetName: SUB_SLOT_TEST_CHARACTER_NAME,
      spawnedItemInstanceIds: spawn.spawnedItemInstanceIds,
      items,
      character: buildCharacterSheetDto(
        snap.character,
        snap.vitals,
        this.statEngine,
        effectiveCore,
      ),
      adena: (wallet?.adena ?? 0n).toString(),
    };
  }
}
