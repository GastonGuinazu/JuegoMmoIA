import type { SynthesisPerformResult } from './synthesis.service';
import type { SynthesisResponseDto } from './dto/synthesis-response.dto';
import { toPlusLevelFromStoredSynthesisLevel } from './synthesis-level-normalizer';

export function mapSynthesisResultToResponse(
  result: SynthesisPerformResult,
): SynthesisResponseDto {
  return {
    success: result.success,
    newItemLevel: toPlusLevelFromStoredSynthesisLevel(result.synthesisLevel),
    pityCount: result.synthesisPityConsecutiveFails,
    forcedByPity: result.forcedByPity,
    adenaSpent: result.adenaSpent,
    adenaAfter: result.adenaAfter,
    baseSuccessPercent: result.baseSuccessPercent,
    effectiveSuccessPercent: result.effectiveSuccessPercent,
    pityMaxFails: result.pityMaxFails,
    pityBonusPerFailPercent: result.pityBonusPerFailPercent,
  };
}
