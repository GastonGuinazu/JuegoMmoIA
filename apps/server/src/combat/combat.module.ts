import { Module } from '@nestjs/common';
import { CharacterModule } from '../character/character.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MobModule } from '../mob/mob.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CombatService } from './combat.service';
import { DamageContributionTrackerService } from './damage-contribution-tracker.service';
import { MobCombatTickService } from './mob-combat-tick.service';
import { PenaltyManagerService } from './penalty-manager.service';
import { PlayerCombatRuntimeService } from './player-combat-runtime.service';
import { PlayerCombatTickService } from './player-combat-tick.service';

@Module({
  imports: [
    PrismaModule,
    CharacterModule,
    MobModule,
    LedgerModule,
  ],
  providers: [
    CombatService,
    PenaltyManagerService,
    DamageContributionTrackerService,
    MobCombatTickService,
    PlayerCombatRuntimeService,
    PlayerCombatTickService,
  ],
  exports: [
    CombatService,
    PenaltyManagerService,
    PlayerCombatRuntimeService,
    DamageContributionTrackerService,
  ],
})
export class CombatModule {}
