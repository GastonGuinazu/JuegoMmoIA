import { Module } from '@nestjs/common';
import { MobModule } from '../mob/mob.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CharacterService } from './character.service';
import { HealthRegenService } from './health-regen.service';
import { StatEngineService } from './stat-engine.service';

@Module({
  imports: [PrismaModule, MobModule],
  providers: [CharacterService, StatEngineService, HealthRegenService],
  exports: [CharacterService, StatEngineService],
})
export class CharacterModule {}
