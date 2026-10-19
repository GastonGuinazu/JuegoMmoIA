import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { loadDailyDungeonsConfig } from './daily-dungeons.loaders';

const NEXUS_NPC_TEMPLATE_KEY = 'dungeon_nexus_guide';
const ROOM_NPC_TEMPLATE_KEY = 'dungeon_room_guide';

/** Siembra idéntica a `NpcShopService.onModuleInit`: `findFirst` + `create` si falta, nunca duplica. */
@Injectable()
export class DungeonNpcService implements OnModuleInit {
  private readonly logger = new Logger(DungeonNpcService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seedNexusGuide();
    await this.seedRoomGuides();
  }

  private async seedNexusGuide(): Promise<void> {
    const existing = await this.prisma.npcInstance.findFirst({
      where: { npcTemplateKey: NEXUS_NPC_TEMPLATE_KEY },
    });
    if (existing) {
      return;
    }
    await this.prisma.npcInstance.create({
      data: {
        npcTemplateKey: NEXUS_NPC_TEMPLATE_KEY,
        displayName: 'Guía de la Mazmorra',
        posX: -5,
        posY: 0,
        posZ: 5,
        zoneId: 'Zone_0',
      },
    });
    this.logger.log('Seeded NpcInstance: Guía de la Mazmorra (Zone_0, -5, 0, 5).');
  }

  private async seedRoomGuides(): Promise<void> {
    const chambers = loadDailyDungeonsConfig().chambers;
    for (const chamberType of Object.keys(chambers) as (keyof typeof chambers)[]) {
      const zoneId = chambers[chamberType]?.zoneId;
      if (!zoneId) {
        continue;
      }
      const existing = await this.prisma.npcInstance.findFirst({
        where: { npcTemplateKey: ROOM_NPC_TEMPLATE_KEY, zoneId },
      });
      if (existing) {
        continue;
      }
      await this.prisma.npcInstance.create({
        data: {
          npcTemplateKey: ROOM_NPC_TEMPLATE_KEY,
          displayName: 'Guía de Sala',
          posX: 3,
          posY: 0,
          posZ: 14,
          zoneId,
        },
      });
      this.logger.log(`Seeded NpcInstance: Guía de Sala (${zoneId}, 3, 0, 14).`);
    }
  }
}
