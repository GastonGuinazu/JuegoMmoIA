import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerLootService } from './loot.service';

@Module({
  imports: [PrismaModule],
  providers: [LedgerLootService],
  exports: [LedgerLootService],
})
export class LedgerModule {}
