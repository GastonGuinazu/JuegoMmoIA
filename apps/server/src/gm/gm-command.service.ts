import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GearSlot, ItemInstanceLocation, Prisma } from '@prisma/client';
import { CharacterService } from '../character/character.service';
import { PenaltyManagerService } from '../combat/penalty-manager.service';
import { todayUtcDateOnly } from '../dungeon/dungeon.service';
import { PrismaService } from '../prisma/prisma.service';
import { loadSynthesisTierConfig } from '../synthesis/synthesis-tier-config';

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

export type GmCommandExecuteOk = {
  ok: true;
  command: string;
  /** Nivel previo si el comando fue setlevel (para emitir LEVEL_UP en el gateway). */
  previousLevel?: number;
};

export type GmCommandExecuteFail = {
  ok: false;
  code: string;
  message: string;
};

export type GmCommandExecuteResult = GmCommandExecuteOk | GmCommandExecuteFail;

@Injectable()
export class GmCommandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly characterService: CharacterService,
    private readonly penaltyManager: PenaltyManagerService,
  ) {}

  async execute(
    characterId: string,
    commandRaw: string,
    argsIn: string[],
  ): Promise<GmCommandExecuteResult> {
    const admin = await this.prisma.character.findUnique({
      where: { id: characterId },
      select: { isAdmin: true },
    });
    if (!admin) {
      return {
        ok: false,
        code: 'CHARACTER_NOT_FOUND',
        message: 'Personaje no encontrado',
      };
    }
    if (!admin.isAdmin) {
      return {
        ok: false,
        code: 'GM_FORBIDDEN',
        message: 'Este personaje no tiene permisos de administrador',
      };
    }

    const command = (commandRaw ?? '').trim().toLowerCase().replace(/^\//, '');
    const args = (argsIn ?? []).map((a) => String(a).trim()).filter((a) => a.length > 0);

    try {
      switch (command) {
        case 'setplus':
          return await this.runSetPlus(characterId, args);
        case 'giveitem':
          return await this.runGiveItem(characterId, args);
        case 'setlevel':
          return await this.runSetLevel(characterId, args);
        case 'setkarma':
          return await this.runSetKarma(characterId, args);
        case 'resetticket':
          return await this.runResetTicket(characterId);
        default:
          return {
            ok: false,
            code: 'GM_UNKNOWN_COMMAND',
            message: `Comando GM desconocido: ${commandRaw}`,
          };
      }
    } catch (e) {
      if (e instanceof BadRequestException) {
        const body = e.getResponse();
        if (typeof body === 'object' && body !== null && 'message' in body) {
          const msg = (body as { message?: string }).message;
          return {
            ok: false,
            code: 'GM_BAD_REQUEST',
            message: typeof msg === 'string' ? msg : 'Solicitud inválida',
          };
        }
        return {
          ok: false,
          code: 'GM_BAD_REQUEST',
          message: e.message,
        };
      }
      if (e instanceof NotFoundException) {
        return {
          ok: false,
          code: 'GM_NOT_FOUND',
          message: e.message,
        };
      }
      throw e;
    }
  }

  private parseGearSlot(raw: string): GearSlot {
    const s = raw.trim().toUpperCase();
    if (!Object.values(GearSlot).includes(s as GearSlot)) {
      throw new BadRequestException(`GearSlot inválido: ${raw}`);
    }
    return s as GearSlot;
  }

  private async runSetPlus(
    characterId: string,
    args: string[],
  ): Promise<GmCommandExecuteOk> {
    if (args.length < 2) {
      throw new BadRequestException('Uso: setplus <WEAPON|ARMOR|...> <plusLevel>');
    }
    const slot = this.parseGearSlot(args[0]!);
    const plus = Number.parseInt(args[1]!, 10);
    if (!Number.isFinite(plus)) {
      throw new BadRequestException('plusLevel debe ser un número');
    }
    const { maxSynthesisLevel } = loadSynthesisTierConfig();
    const maxPlus = Math.max(0, maxSynthesisLevel - 1);
    const clampedPlus = Math.max(0, Math.min(maxPlus, Math.floor(plus)));
    const synthesisLevel = clampedPlus + 1;

    const item = await this.prisma.itemInstance.findFirst({
      where: {
        ownerId: characterId,
        location: ItemInstanceLocation.EQUIPPED,
        gearSlot: slot,
        parentItemInstanceId: null,
      },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException(`No hay ítem equipado en el slot ${slot}`);
    }

    await this.prisma.itemInstance.update({
      where: { id: item.id },
      data: { synthesisLevel, rowVersion: { increment: 1 } },
    });
    await this.characterService.onEquipmentOrItemInstanceChanged(characterId);
    return { ok: true, command: 'setplus' };
  }

  private async runGiveItem(
    characterId: string,
    args: string[],
  ): Promise<GmCommandExecuteOk> {
    if (args.length < 2) {
      throw new BadRequestException('Uso: giveitem <templateId UUID | catalogKey> <cantidad>');
    }
    const templateRef = args[0]!;
    const qty = Number.parseInt(args[1]!, 10);
    if (!Number.isFinite(qty) || qty < 1 || qty > 999) {
      throw new BadRequestException('La cantidad debe ser entre 1 y 999');
    }

    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const template = uuidRe.test(templateRef)
      ? await this.prisma.itemTemplate.findUnique({
          where: { id: templateRef },
        })
      : await this.prisma.itemTemplate.findUnique({
          where: { catalogKey: templateRef },
        });

    if (!template) {
      throw new NotFoundException(`Plantilla no encontrada: ${templateRef}`);
    }

    await this.prisma.$transaction(
      async (tx) => {
        const maxStack = template.baseSlot ? 1 : readMaxStackFromTemplate(template.baseStats);
        if (maxStack === 1) {
          for (let i = 0; i < qty; i++) {
            await tx.itemInstance.create({
              data: {
                ownerId: characterId,
                itemTemplateId: template.id,
                quantity: 1,
                location: ItemInstanceLocation.INVENTORY,
              },
            });
          }
        } else {
          const stack = await tx.itemInstance.findFirst({
            where: {
              ownerId: characterId,
              itemTemplateId: template.id,
              location: ItemInstanceLocation.INVENTORY,
            },
          });
          if (stack) {
            const nextQty = stack.quantity + qty;
            if (nextQty > maxStack) {
              throw new BadRequestException(
                `No caben más de ${maxStack} en el stack existente`,
              );
            }
            await tx.itemInstance.update({
              where: { id: stack.id },
              data: { quantity: nextQty, rowVersion: { increment: 1 } },
            });
          } else {
            if (qty > maxStack) {
              throw new BadRequestException(
                `Cantidad máxima por stack: ${maxStack}`,
              );
            }
            await tx.itemInstance.create({
              data: {
                ownerId: characterId,
                itemTemplateId: template.id,
                quantity: qty,
                location: ItemInstanceLocation.INVENTORY,
              },
            });
          }
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return { ok: true, command: 'giveitem' };
  }

  private async runSetLevel(
    characterId: string,
    args: string[],
  ): Promise<GmCommandExecuteOk> {
    if (args.length < 1) {
      throw new BadRequestException('Uso: setlevel <nivel>');
    }
    const level = Number.parseInt(args[0]!, 10);
    if (!Number.isFinite(level)) {
      throw new BadRequestException('nivel debe ser un número');
    }
    const { previousLevel } = await this.characterService.gmSetLevelWithCoreGrants(
      characterId,
      level,
    );
    return {
      ok: true,
      command: 'setlevel',
      previousLevel,
    };
  }

  private async runSetKarma(
    characterId: string,
    args: string[],
  ): Promise<GmCommandExecuteOk> {
    if (args.length < 1) {
      throw new BadRequestException('Uso: setkarma <karmaPoints>');
    }
    const karmaPoints = Number.parseInt(args[0]!, 10);
    if (!Number.isFinite(karmaPoints)) {
      throw new BadRequestException('karmaPoints debe ser un número entero');
    }
    const karmaTier = this.penaltyManager.getKarmaTierFromPoints(karmaPoints);
    await this.prisma.character.update({
      where: { id: characterId },
      data: { karmaPoints, karmaTier },
    });
    return { ok: true, command: 'setkarma' };
  }

  /**
   * Libera el ticket diario de mazmorra (1 por personaje por día, `DungeonQuota`)
   * sin esperar al día siguiente. Útil para repetir pruebas/grabaciones.
   */
  private async runResetTicket(characterId: string): Promise<GmCommandExecuteOk> {
    const quotaDate = todayUtcDateOnly();
    await this.prisma.dungeonQuota.deleteMany({
      where: { characterId, quotaDate },
    });
    return { ok: true, command: 'resetticket' };
  }
}
