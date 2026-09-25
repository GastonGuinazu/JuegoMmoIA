/**
 * Respuesta estable de síntesis (éxito HTTP 200, RNG puede ser success: false).
 * Contrato para cliente / futuros DTOs compartidos en `libs/shared`.
 */
export interface SynthesisResponseDto {
  success: boolean;
  /** Nivel de síntesis del ítem principal tras el intento. */
  newItemLevel: number;
  /** Valor actual de `synthesisPityConsecutiveFails` del principal. */
  pityCount: number;
  /** True si el éxito fue forzado por pity (100%). */
  forcedByPity: boolean;
  /** Costo debitado de Adena en este intento. */
  adenaSpent: string;
  /** Adena de la wallet tras commit. */
  adenaAfter: string;
  /** Chance base del tramo antes de pity incremental. */
  baseSuccessPercent: number;
  /** Chance efectiva usada por RNG en este intento. */
  effectiveSuccessPercent: number;
  pityMaxFails: number;
  pityBonusPerFailPercent: number;
}
