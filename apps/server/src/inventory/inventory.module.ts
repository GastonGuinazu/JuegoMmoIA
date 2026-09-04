import { Module } from '@nestjs/common';
import { CharacterModule } from '../character/character.module';
import { CombatModule } from '../combat/combat.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryController } from './inventory.controller';
import { InventoryTestController } from './inventory-test.controller';
import { InventoryService } from './inventory.service';

@Module({
  imports: [PrismaModule, IdempotencyModule, CharacterModule, CombatModule],
  controllers: [InventoryController, InventoryTestController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
