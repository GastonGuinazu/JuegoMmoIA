import {
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { StatEngineService } from '../character/stat-engine.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import {
  parseCharacterIdHeader,
  toIdempotencyFailurePayload,
} from '../idempotency/idempotency-http.util';
import type { IdempotencyCachedPayload } from '../idempotency/idempotency.types';
import type { WsPlayerVitalsPayload } from '@aetheris/shared-types';
import { WorldSocketBridgeService } from '../world/world-socket-bridge.service';
import { PlayerCombatRuntimeService } from '../combat/player-combat-runtime.service';
import { InventoryEquipRequestDto } from './dto/inventory-equip-request.dto';
import { InventoryUnequipRequestDto } from './dto/inventory-unequip-request.dto';
import { buildCharacterSheetDto } from './inventory-character-dto.util';
import { mapInventoryItemInstanceToRow } from './inventory-item-row.mapper';
import {
  InventoryService,
  type CharacterWithInventoryItems,
} from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly prisma: PrismaService,
    private readonly idempotencyService: IdempotencyService,
    private readonly statEngine: StatEngineService,
    private readonly worldBridge: WorldSocketBridgeService,
    private readonly playerCombatRuntime: PlayerCombatRuntimeService,
  ) {}

  @Get()
  async listProgress(
    @Headers('x-character-id') characterIdHeader: string | undefined,
  ): Promise<{
    items: ReturnType<typeof mapInventoryItemInstanceToRow>[];
    character: ReturnType<typeof buildCharacterSheetDto>;
    adena: string;
  }> {
    const characterId = parseCharacterIdHeader(characterIdHeader);
    const snap = await this.inventoryService.getProgressSnapshot(characterId);
    const ram = this.playerCombatRuntime.getRuntimeVitals(characterId);
    const vitals = ram
      ? { currentHp: ram.currentHp, maxHp: ram.maxHp }
      : snap.vitals;
    return await this.mapProgressResponse(snap.character, vitals);
  }

  @Post('equip')
  @HttpCode(200)
  async equip(
    @Headers('x-character-id') characterIdHeader: string | undefined,
    @Body() dto: InventoryEquipRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const characterId = parseCharacterIdHeader(characterIdHeader);
    const gate = await this.idempotencyService.claimOrReplay(dto.idempotencyKey);

    if (gate.action === 'replay') {
      res.status(gate.statusCode);
      return gate.body;
    }

    if (gate.action === 'conflict_in_progress') {
      throw new ConflictException({
        code: 'INVENTORY_IDEMPOTENCY_PENDING',
        message:
          'An inventory operation with this idempotency key is already in progress or stalled in PENDING',
      });
    }

    try {
      const result = await this.inventoryService.equipItem(
        characterId,
        dto.itemId,
        dto.slot,
        dto.parentItemId,
      );
      const vitals = await this.statEngine.getCombatVitals(characterId);
      const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
      const characterDto = buildCharacterSheetDto(
        result.character,
        vitals,
        this.statEngine,
        effectiveCore,
      );
      const body = {
        ...result.inventory,
        character: characterDto,
      };
      this.emitVitals(characterId, vitals);
      await this.playerCombatRuntime.refreshDerivedStatsAfterEquipmentChange(
        characterId,
      );
      await this.idempotencyService.markCompleted(dto.idempotencyKey, {
        statusCode: 200,
        body,
      } satisfies IdempotencyCachedPayload);
      return body;
    } catch (e) {
      const failure = toIdempotencyFailurePayload(e);
      await this.idempotencyService.markFailed(dto.idempotencyKey, failure);
      throw new HttpException(
        failure.body as string | Record<string, unknown>,
        failure.statusCode,
      );
    }
  }

  @Post('unequip')
  @HttpCode(200)
  async unequip(
    @Headers('x-character-id') characterIdHeader: string | undefined,
    @Body() dto: InventoryUnequipRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const characterId = parseCharacterIdHeader(characterIdHeader);
    const gate = await this.idempotencyService.claimOrReplay(dto.idempotencyKey);

    if (gate.action === 'replay') {
      res.status(gate.statusCode);
      return gate.body;
    }

    if (gate.action === 'conflict_in_progress') {
      throw new ConflictException({
        code: 'INVENTORY_IDEMPOTENCY_PENDING',
        message:
          'An inventory operation with this idempotency key is already in progress or stalled in PENDING',
      });
    }

    try {
      const result = await this.inventoryService.unequipItem(
        characterId,
        dto.itemId,
      );
      const vitals = await this.statEngine.getCombatVitals(characterId);
      const effectiveCore = await this.statEngine.getEffectiveCoreStats(characterId);
      const characterDto = buildCharacterSheetDto(
        result.character,
        vitals,
        this.statEngine,
        effectiveCore,
      );
      const body = {
        ...result.inventory,
        character: characterDto,
      };
      this.emitVitals(characterId, vitals);
      await this.playerCombatRuntime.refreshDerivedStatsAfterEquipmentChange(
        characterId,
      );
      await this.idempotencyService.markCompleted(dto.idempotencyKey, {
        statusCode: 200,
        body,
      } satisfies IdempotencyCachedPayload);
      return body;
    } catch (e) {
      const failure = toIdempotencyFailurePayload(e);
      await this.idempotencyService.markFailed(dto.idempotencyKey, failure);
      throw new HttpException(
        failure.body as string | Record<string, unknown>,
        failure.statusCode,
      );
    }
  }

  private async mapProgressResponse(
    character: CharacterWithInventoryItems,
    vitals: { currentHp: number; maxHp: number },
  ): Promise<{
    items: ReturnType<typeof mapInventoryItemInstanceToRow>[];
    character: ReturnType<typeof buildCharacterSheetDto>;
    adena: string;
  }> {
    const items = character.items.map((row) =>
      mapInventoryItemInstanceToRow(row, character.items),
    );
    const wallet = await this.prisma.wallet.findUnique({
      where: { accountId: character.accountId },
      select: { adena: true },
    });
    const adena = (wallet?.adena ?? 0n).toString();
    const effectiveCore = this.statEngine.computeEffectiveCoreForLoadedCharacter(
      character as CharacterWithInventoryItems,
    );
    return {
      items,
      character: buildCharacterSheetDto(
        character,
        vitals,
        this.statEngine,
        effectiveCore,
      ),
      adena,
    };
  }

  private emitVitals(
    characterId: string,
    vitals: { currentHp: number; maxHp: number },
  ): void {
    const payload: WsPlayerVitalsPayload = {
      characterId,
      currentHp: vitals.currentHp,
      maxHp: vitals.maxHp,
    };
    this.worldBridge.emitPlayerVitals(payload);
  }
}
