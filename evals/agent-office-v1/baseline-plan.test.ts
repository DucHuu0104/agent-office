import { describe, expect, it } from 'vitest';
import { agentOfficeV1Corpus } from './corpus';
import { baselineTaskIds, createBaselinePlan, resolveBaselineTaskIds, startsPairedComparison, summarizePairedComparisons } from './baseline-plan';

describe('Agent Office eval baseline planning', () => {
  it('builds the fixed 12-task, three-repetition, two-strategy matrix at its full ceiling', () => {
    const plan = createBaselinePlan({ maxTotalUsd: 16.2 });

    expect(plan.taskIds).toEqual([...baselineTaskIds]);
    expect(plan.strategies).toEqual(['single-agent', 'multi-agent']);
    expect(plan.repetitions).toBe(3);
    expect(plan.runs).toHaveLength(72);
    expect(plan.plannedExposureUsd).toBe(16.2);
    expect(new Set(plan.runs.map((run) => run.taskId)).size).toBe(12);
  });

  it('rejects a ceiling below the aggregate per-task maximum before any model can run', () => {
    expect(() => createBaselinePlan({ maxTotalUsd: 16.19 })).toThrow(/above the requested USD 16\.19 ceiling/);
  });

  it('allows a smaller explicit matrix and calculates only its selected exposure', () => {
    const plan = createBaselinePlan({ taskIds: ['C01', 'A01'], strategies: ['single-agent'], repetitions: 1, maxTotalUsd: 1 });

    expect(plan.runs).toEqual([
      { taskId: 'C01', category: 'coding', strategy: 'single-agent', repetition: 1, maxBudgetUsd: 0.3 },
      { taskId: 'A01', category: 'analysis', strategy: 'single-agent', repetition: 1, maxBudgetUsd: 0.15 },
    ]);
    expect(plan.plannedExposureUsd).toBe(0.45);
  });

  it('interleaves each task and repetition across strategies for paired comparison', () => {
    const plan = createBaselinePlan({ taskIds: ['C01', 'A01'], repetitions: 2, maxTotalUsd: 2 });
    expect(plan.runs.map(({ taskId, repetition, strategy }) => `${taskId}/${repetition}/${strategy}`)).toEqual([
      'C01/1/single-agent', 'C01/1/multi-agent',
      'C01/2/single-agent', 'C01/2/multi-agent',
      'A01/1/single-agent', 'A01/1/multi-agent',
      'A01/2/single-agent', 'A01/2/multi-agent',
    ]);
    expect(startsPairedComparison(plan.runs[0]!, plan.runs[1])).toBe(true);
    expect(startsPairedComparison(plan.runs[1]!, plan.runs[2])).toBe(false);
    expect(startsPairedComparison(plan.runs[3]!, undefined)).toBe(false);
  });

  it('reports fully attempted, successful, incomplete and unstarted pairs separately', () => {
    const plan = createBaselinePlan({ taskIds: ['C01', 'A01'], repetitions: 2, maxTotalUsd: 2 });
    const comparison = summarizePairedComparisons(plan, [
      { taskId: 'C01', repetition: 1, strategy: 'single-agent', status: 'succeeded' },
      { taskId: 'C01', repetition: 1, strategy: 'multi-agent', status: 'failed' },
      { taskId: 'C01', repetition: 2, strategy: 'single-agent', status: 'paused' },
    ]);

    expect(comparison).toEqual({
      strategies: ['single-agent', 'multi-agent'],
      plannedPairs: 4,
      attemptedPairs: 2,
      pairsWithBothStrategiesAttempted: 1,
      fullySucceededPairs: 0,
      incompleteAttemptedPairs: 1,
      notStartedPairs: 2,
    });
  });

  it('rejects invalid repetition counts, duplicate or unknown tasks, and missing ceilings', () => {
    expect(() => createBaselinePlan({ repetitions: 0, maxTotalUsd: 16.2 })).toThrow(/integer from 1 to 10/);
    expect(() => createBaselinePlan({ taskIds: ['C01', 'C01'], maxTotalUsd: 16.2 })).toThrow(/no duplicates/);
    expect(() => createBaselinePlan({ taskIds: ['Z99'], maxTotalUsd: 16.2 })).toThrow(/Unknown eval task: Z99/);
    expect(() => createBaselinePlan({ maxTotalUsd: 0 })).toThrow(/positive total USD ceiling/);
  });

  it('parses explicit task selections without silently accepting malformed IDs', () => {
    expect(resolveBaselineTaskIds(' C01, R05, A09 ')).toEqual(['C01', 'R05', 'A09']);
    expect(() => resolveBaselineTaskIds('C01,,A01')).toThrow(/malformed|IDs/);
    expect(() => resolveBaselineTaskIds('C01,C01')).toThrow(/duplicates/);
  });

  it('keeps three cases from each corpus category in the default representative sample', () => {
    const plan = createBaselinePlan({ maxTotalUsd: 16.2 });
    const categoryCounts = Object.fromEntries(agentOfficeV1Corpus.map((task) => task.category).map((category) => [category, 0])) as Record<string, number>;
    for (const id of plan.taskIds) {
      const task = agentOfficeV1Corpus.find((item) => item.id === id)!;
      categoryCounts[task.category] = (categoryCounts[task.category] ?? 0) + 1;
    }
    expect(Object.values(categoryCounts)).toEqual([3, 3, 3, 3]);
  });
});
