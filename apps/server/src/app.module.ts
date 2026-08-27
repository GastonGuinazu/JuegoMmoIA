import { Module } from '@nestjs/common';
import { CharacterModule } from './character/character.module';
import { CombatModule } from './combat/combat.module';
import { InventoryModule } from './inventory/inventory.module';
import { ItemsModule } from './items/items.module';
import { PrismaModule } from './prisma/prisma.module';
import { SynthesisModule } from './synthesis/synthesis.module';
import { WorldModule } from './world/world.module';
import { WorldSocketModule } from './world/world-socket.module';

@Module({
  imports: [
    PrismaModule,
    WorldModule,
    ItemsModule,
    SynthesisModule,
    CharacterModule,
    InventoryModule,
    CombatModule,
    WorldSocketModule,
  ],
})
export class AppModule {}
