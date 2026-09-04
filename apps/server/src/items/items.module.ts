import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ItemCatalogSyncService } from './item-catalog-sync.service';

@Module({
  imports: [PrismaModule],
  providers: [ItemCatalogSyncService],
})
export class ItemsModule {}
