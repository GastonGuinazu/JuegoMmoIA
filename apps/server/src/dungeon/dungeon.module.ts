import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { DungeonNpcService } from './dungeon-npc.service';
import { DungeonSessionTickService } from './dungeon-session-tick.service';
import { DungeonService } from './dungeon.service';

@Module({
  imports: [PrismaModule],
  providers: [DungeonNpcService, DungeonSessionTickService, DungeonService],
  exports: [DungeonService, DungeonSessionTickService],
})
export class DungeonModule {}
