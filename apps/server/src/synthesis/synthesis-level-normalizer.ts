/**
 * Legacy compatibility:
 * - En datos históricos, `synthesisLevel=1` representa ítem base (+0).
 * - El estándar de UI/cálculo usa `plusLevel` 0-based.
 */
export function toPlusLevelFromStoredSynthesisLevel(
  synthesisLevel: number,
): number {
  if (!Number.isFinite(synthesisLevel)) {
    return 0;
  }
  return Math.max(0, Math.floor(synthesisLevel) - 1);
}
