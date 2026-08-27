import { Module } from '@nestjs/common';
import { CharacterModule } from '../character/character.module';
import { CombatModule } from '../combat/combat.module';
import { GmModule } from '../gm/gm.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MobModule } from '../mob/mob.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SynthesisModule } from '../synthesis/synthesis.module';
import { MobAiTickService } from '../mob/mob-ai-tick.service';
import { MobRespawnService } from './mob-respawn.service';
import { NpcShopService } from './npc-shop.service';
import { WorldDropService } from './world-drop.service';
import { WorldGateway } from './world.gateway';

@Module({
  imports: [
    PrismaModule,
    CharacterModule,
    CombatModule,
    MobModule,
    InventoryModule,
    SynthesisModule,
    GmModule,
  ],
  providers: [
    WorldGateway,
    MobRespawnService,
    MobAiTickService,
    WorldDropService,
    NpcShopService,
  ],
})
export class WorldSocketModule {}
