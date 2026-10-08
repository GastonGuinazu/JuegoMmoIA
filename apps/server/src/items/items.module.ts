import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ItemCatalogSyncService } from './item-catalog-sync.service';
import { StarterKitService } from './starter-kit.service';

@Module({
  imports: [PrismaModule],
  providers: [ItemCatalogSyncService, StarterKitService],
  exports: [StarterKitService],
})
export class ItemsModule {}
