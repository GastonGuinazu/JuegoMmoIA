import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { upsertItemTemplatesFromConfig } from './item-catalog-upsert';

@Injectable()
export class ItemCatalogSyncService implements OnModuleInit {
  private readonly logger = new Logger(ItemCatalogSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const n = await upsertItemTemplatesFromConfig(this.prisma);
    this.logger.log(`Item catalog synced (${n} entries from items.json).`);
  }
}
