import { describe, expect, it } from 'vitest';
import { allocateBaselineRunTokens, hasEnoughTokensToStartRun, MIN_REMAINING_TOKENS_TO_START_RUN, requiredBaselineStartTokens } from './baseline-budget';

describe('baseline aggregate token budget', () => {
  it('starts another run only when enough aggregate tokens remain for its initial request', () => {
    expect(hasEnoughTokensToStartRun(MIN_REMAINING_TOKENS_TO_START_RUN)).toBe(true);
    expect(hasEnoughTokensToStartRun(MIN_REMAINING_TOKENS_TO_START_RUN - 1)).toBe(false);
    expect(hasEnoughTokensToStartRun(6_349)).toBe(false);
  });

  it('rejects invalid remaining-token values', () => {
    expect(hasEnoughTokensToStartRun(Number.NaN)).toBe(false);
    expect(hasEnoughTokensToStartRun(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('requires room for both full run ceilings before starting a paired comparison', () => {
    expect(requiredBaselineStartTokens(40_000, true)).toBe(80_000);
    expect(requiredBaselineStartTokens(40_000, false)).toBe(40_000);
    expect(requiredBaselineStartTokens(11_999, true)).toBeNull();
    expect(requiredBaselineStartTokens(Number.NaN, false)).toBeNull();
  });

  it('reserves enough aggregate tokens for the second strategy before starting a pair', () => {
    expect(allocateBaselineRunTokens(80_000, 40_000, true)).toEqual({ tokenCeiling: 40_000, reservedForPairedRun: 40_000 });
    expect(allocateBaselineRunTokens(79_999, 40_000, true)).toBeNull();
  });

  it('allocates a standalone run from the full remainder and rejects unusable ceilings', () => {
    expect(allocateBaselineRunTokens(40_000, 40_000, false)).toEqual({ tokenCeiling: 40_000, reservedForPairedRun: 0 });
    expect(allocateBaselineRunTokens(39_999, 40_000, false)).toBeNull();
    expect(allocateBaselineRunTokens(40_000, 11_999, false)).toBeNull();
    expect(allocateBaselineRunTokens(40_000, 12_000.5, false)).toBeNull();
    expect(allocateBaselineRunTokens(Number.NaN, 80_000, false)).toBeNull();
  });
});
