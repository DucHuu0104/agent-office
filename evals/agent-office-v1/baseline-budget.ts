export const MIN_REMAINING_TOKENS_TO_START_RUN = 12_000;

export interface BaselineTokenAllocation {
  tokenCeiling: number;
  reservedForPairedRun: number;
}

export function requiredBaselineStartTokens(maxTokensPerRun: number, paired: boolean): number | null {
  if (!Number.isInteger(maxTokensPerRun) || maxTokensPerRun < MIN_REMAINING_TOKENS_TO_START_RUN) return null;
  return maxTokensPerRun * (paired ? 2 : 1);
}

/** Allocate one run while preserving its configured token ceiling for the paired strategy. */
export function allocateBaselineRunTokens(
  remainingTokens: number,
  maxTokensPerRun: number,
  reserveForPairedRun: boolean,
): BaselineTokenAllocation | null {
  if (!Number.isFinite(remainingTokens) || !Number.isInteger(maxTokensPerRun) || maxTokensPerRun < MIN_REMAINING_TOKENS_TO_START_RUN) return null;
  const reservedForPairedRun = reserveForPairedRun ? maxTokensPerRun : 0;
  if (remainingTokens < maxTokensPerRun + reservedForPairedRun) return null;
  return { tokenCeiling: maxTokensPerRun, reservedForPairedRun };
}

export function hasEnoughTokensToStartRun(remainingTokens: number): boolean {
  return Number.isFinite(remainingTokens) && remainingTokens >= MIN_REMAINING_TOKENS_TO_START_RUN;
}
