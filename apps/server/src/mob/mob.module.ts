import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { MobCombatRegenService } from './mob-combat-regen.service';
import { MobService } from './mob.service';
import { MobSpawnBootstrapService } from './mob-spawn-bootstrap.service';

@Module({
  imports: [PrismaModule],
  providers: [MobService, MobCombatRegenService, MobSpawnBootstrapService],
  exports: [MobService, MobCombatRegenService],
})
export class MobModule {}
