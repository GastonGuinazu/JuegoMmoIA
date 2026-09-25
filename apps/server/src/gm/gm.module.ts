import { Module } from '@nestjs/common';
import { CharacterModule } from '../character/character.module';
import { CombatModule } from '../combat/combat.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GmCommandService } from './gm-command.service';

@Module({
  imports: [PrismaModule, CharacterModule, CombatModule],
  providers: [GmCommandService],
  exports: [GmCommandService],
})
export class GmModule {}
