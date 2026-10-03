import { Module } from '@nestjs/common';
import { CombatModule } from '../combat/combat.module';
import { PartyService } from './party.service';
import { PartyVitalsTickService } from './party-vitals-tick.service';

@Module({
  imports: [CombatModule],
  providers: [PartyService, PartyVitalsTickService],
  exports: [PartyService],
})
export class PartyModule {}
