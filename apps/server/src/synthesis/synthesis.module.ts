import { Module } from '@nestjs/common';
import { CharacterModule } from '../character/character.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { SynthesisController } from './synthesis.controller';
import { SynthesisService } from './synthesis.service';

@Module({
  imports: [IdempotencyModule, CharacterModule],
  controllers: [SynthesisController],
  providers: [SynthesisService],
  exports: [SynthesisService],
})
export class SynthesisModule {}
