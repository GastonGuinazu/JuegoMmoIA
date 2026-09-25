import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ItemInstanceLocation, Prisma } from '@prisma/client';
import { CharacterService } from '../character/character.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  findTierForCurrentLevel,
  loadSynthesisTierConfig,
} from './synthesis-tier-config';

export interface SynthesisPerformResult {
  success: boolean;
  forcedByPity: boolean;
  synthesisLevel: number;
  synthesisPityConsecutiveFails: number;
  adenaSpent: string;
  adenaAfter: string;
  baseSuccessPercent: number;
  effectiveSuccessPercent: number;
  pityMaxFails: number;
  pityBonusPerFailPercent: number;
}

export interface SynthesisQuoteResult {
  adenaCost: string;
  baseSuccessPercent: number;
  effectiveSuccessPercent: number;
  pityCount: number;
  pityMaxFails: number;
  pityBonusPerFailPercent: number;
}

@Injectable()
export class SynthesisService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly characterService: CharacterService,
  ) {}

  /**
   * 2×1 síntesis atómica: destruye el sacrificio y actualiza el principal (nivel / pity).
   * Probabilidades y pity máximo por tramo se leen de `config/synthesis-tiers.json`.
   */
  async getSynthesisQuote(
    charId: string,
    mainItemId: string,
    sacrificeItemId: string,
  ): Promise<SynthesisQuoteResult> {
    const context = await this.resolveSynthesisContext(
      this.prisma,
      charId,
      mainItemId,
      sacrificeItemId,
    );
    const effectiveSuccessPercent = this.resolveEffectiveSuccessPercent(
      context.tier.baseSuccessPercent,
      context.tier.pityBonusPerFailPercent,
      context.pityBefore,
    );
    return {
      adenaCost: context.tier.adenaCost,
      baseSuccessPercent: context.tier.baseSuccessPercent,
      effectiveSuccessPercent,
      pityCount: context.pityBefore,
      pityMaxFails: context.tier.maxPityConsecutiveFails,
      pityBonusPerFailPercent: context.tier.pityBonusPerFailPercent,
    };
  }

  async performSynthesis(
    charId: string,
    mainItemId: string,
    sacrificeItemId: string,
  ): Promise<SynthesisPerformResult> {
    if (mainItemId === sacrificeItemId) {
      throw new BadRequestException(
        'Main and sacrifice item instances must be different',
      );
    }

    const config = loadSynthesisTierConfig();

    const outcome = await this.prisma.$transaction(
      async (tx) => {
        const context = await this.resolveSynthesisContext(
          tx,
          charId,
          mainItemId,
          sacrificeItemId,
          config.maxSynthesisLevel,
        );

        await tx.wallet.upsert({
          where: { accountId: context.accountId },
          create: { accountId: context.accountId, adena: 0n },
          update: {},
        });
        const wallet = await tx.wallet.findUnique({
          where: { accountId: context.accountId },
          select: { adena: true },
        });
        const adenaBefore = wallet?.adena ?? 0n;
        const adenaCost = this.parseAdenaCost(context.tier.adenaCost);
        if (adenaBefore < adenaCost) {
          throw new BadRequestException({
            code: 'INSUFFICIENT_ADENA',
            message: `Adena insuficiente para sintetizar (costo ${adenaCost.toString()})`,
          });
        }

        const pityBefore = context.pityBefore;
        const forcedByPity = pityBefore >= context.tier.maxPityConsecutiveFails;
        const effectiveSuccessPercent = this.resolveEffectiveSuccessPercent(
          context.tier.baseSuccessPercent,
          context.tier.pityBonusPerFailPercent,
          pityBefore,
        );
        const roll = Math.random() * 100;
        const success = forcedByPity || roll < effectiveSuccessPercent;

        await tx.wallet.update({
          where: { accountId: context.accountId },
          data: { adena: { decrement: adenaCost } },
        });

        await tx.itemInstance.delete({ where: { id: sacrificeItemId } });

        if (success) {
          const updated = await tx.itemInstance.update({
            where: { id: mainItemId },
            data: {
              synthesisLevel: { increment: 1 },
              synthesisPityConsecutiveFails: 0,
              rowVersion: { increment: 1 },
            },
          });
          return {
            success: true,
            forcedByPity,
            synthesisLevel: updated.synthesisLevel,
            synthesisPityConsecutiveFails: updated.synthesisPityConsecutiveFails,
            adenaSpent: adenaCost.toString(),
            adenaAfter: (adenaBefore - adenaCost).toString(),
            baseSuccessPercent: context.tier.baseSuccessPercent,
            effectiveSuccessPercent,
            pityMaxFails: context.tier.maxPityConsecutiveFails,
            pityBonusPerFailPercent: context.tier.pityBonusPerFailPercent,
            mainWasEquipped: context.mainWasEquipped,
          };
        }

        const updated = await tx.itemInstance.update({
          where: { id: mainItemId },
          data: {
            synthesisPityConsecutiveFails: { increment: 1 },
            rowVersion: { increment: 1 },
          },
        });
        return {
          success: false,
          forcedByPity: false,
          synthesisLevel: updated.synthesisLevel,
          synthesisPityConsecutiveFails: updated.synthesisPityConsecutiveFails,
          adenaSpent: adenaCost.toString(),
          adenaAfter: (adenaBefore - adenaCost).toString(),
          baseSuccessPercent: context.tier.baseSuccessPercent,
          effectiveSuccessPercent,
          pityMaxFails: context.tier.maxPityConsecutiveFails,
          pityBonusPerFailPercent: context.tier.pityBonusPerFailPercent,
          mainWasEquipped: context.mainWasEquipped,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    const { mainWasEquipped, ...result } = outcome;

    if (result.success && mainWasEquipped) {
      await this.characterService.recalculateDerivedStats(charId);
    }

    return result;
  }

  private resolveEffectiveSuccessPercent(
    baseSuccessPercent: number,
    pityBonusPerFailPercent: number,
    pityBefore: number,
  ): number {
    return Math.min(
      100,
      baseSuccessPercent + pityBonusPerFailPercent * Math.max(0, pityBefore),
    );
  }

  private parseAdenaCost(raw: string): bigint {
    try {
      const value = BigInt(raw);
      if (value < 0n) {
        throw new InternalServerErrorException(
          'Invalid synthesis tier configuration (adenaCost must be >= 0)',
        );
      }
      return value;
    } catch {
      throw new InternalServerErrorException(
        'Invalid synthesis tier configuration (adenaCost is not a valid bigint)',
      );
    }
  }

  private async resolveSynthesisContext(
    tx: Prisma.TransactionClient | PrismaService,
    charId: string,
    mainItemId: string,
    sacrificeItemId: string,
    maxSynthesisLevel?: number,
  ): Promise<{
    accountId: string;
    pityBefore: number;
    mainWasEquipped: boolean;
    tier: {
      baseSuccessPercent: number;
      maxPityConsecutiveFails: number;
      adenaCost: string;
      pityBonusPerFailPercent: number;
    };
  }> {
    const config = loadSynthesisTierConfig();
    const character = await tx.character.findUnique({
      where: { id: charId },
      select: { id: true, accountId: true },
    });
    if (!character) {
      throw new NotFoundException(`Character ${charId} not found`);
    }

    const [main, sacrifice] = await Promise.all([
      tx.itemInstance.findUnique({ where: { id: mainItemId } }),
      tx.itemInstance.findUnique({ where: { id: sacrificeItemId } }),
    ]);

    if (!main || main.ownerId !== charId) {
      throw new NotFoundException(
        `Main item ${mainItemId} not found or not owned by character`,
      );
    }
    if (!sacrifice || sacrifice.ownerId !== charId) {
      throw new NotFoundException(
        `Sacrifice item ${sacrificeItemId} not found or not owned by character`,
      );
    }

    const mainWasEquipped = main.location === ItemInstanceLocation.EQUIPPED;

    if (
      main.location !== ItemInstanceLocation.INVENTORY &&
      main.location !== ItemInstanceLocation.EQUIPPED
    ) {
      throw new BadRequestException(
        'Main item must be in inventory or equipped for synthesis',
      );
    }
    if (sacrifice.location !== ItemInstanceLocation.INVENTORY) {
      throw new BadRequestException('Sacrifice item must be in inventory');
    }

    const maxLevel = maxSynthesisLevel ?? config.maxSynthesisLevel;
    if (main.synthesisLevel >= maxLevel) {
      throw new BadRequestException(
        `Main item is already at max synthesis level (${maxLevel})`,
      );
    }
    if (main.itemTemplateId !== sacrifice.itemTemplateId) {
      throw new BadRequestException(
        'Sacrifice must match main item template (same item family)',
      );
    }
    if (main.synthesisLevel !== sacrifice.synthesisLevel) {
      throw new BadRequestException(
        'Main and sacrifice synthesis levels must match for this attempt',
      );
    }

    const tier = findTierForCurrentLevel(config, main.synthesisLevel);
    if (!tier) {
      throw new InternalServerErrorException(
        `No synthesis tier defined for current level ${main.synthesisLevel}`,
      );
    }
    if (
      tier.baseSuccessPercent < 0 ||
      tier.baseSuccessPercent > 100 ||
      tier.maxPityConsecutiveFails < 1 ||
      tier.pityBonusPerFailPercent < 0
    ) {
      throw new InternalServerErrorException(
        'Invalid synthesis tier configuration',
      );
    }
    this.parseAdenaCost(tier.adenaCost);

    return {
      accountId: character.accountId,
      pityBefore: main.synthesisPityConsecutiveFails,
      mainWasEquipped,
      tier,
    };
  }
}
