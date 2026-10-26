import { agentOfficeV1Corpus, type EvalTask } from './corpus';

export const baselineTaskIds = [
  'C01', 'C03', 'C10',
  'R01', 'R05', 'R08',
  'A01', 'A05', 'A09',
  'O01', 'O05', 'O09',
] as const;

export const baselineStrategies = ['single-agent', 'multi-agent'] as const;
export type BaselineStrategy = (typeof baselineStrategies)[number];

export interface BaselineRun {
  taskId: string;
  category: EvalTask['category'];
  strategy: BaselineStrategy;
  repetition: number;
  maxBudgetUsd: number;
}

export interface BaselinePlan {
  taskIds: string[];
  strategies: BaselineStrategy[];
  repetitions: number;
  maxTotalUsd: number;
  plannedExposureUsd: number;
  runs: BaselineRun[];
}

export interface PairedRunAttempt extends Pick<BaselineRun, 'taskId' | 'repetition' | 'strategy'> {
  status: string;
}

export function summarizePairedComparisons(
  plan: Pick<BaselinePlan, 'taskIds' | 'strategies' | 'repetitions'>,
  runs: readonly PairedRunAttempt[],
): {
  strategies: BaselineStrategy[];
  plannedPairs: number;
  attemptedPairs: number;
  pairsWithBothStrategiesAttempted: number;
  fullySucceededPairs: number;
  incompleteAttemptedPairs: number;
  notStartedPairs: number;
} {
  const byPair = new Map<string, Map<BaselineStrategy, string>>();
  for (const run of runs) {
    const key = `${run.taskId}/${run.repetition}`;
    const strategies = byPair.get(key) ?? new Map<BaselineStrategy, string>();
    strategies.set(run.strategy, run.status);
    byPair.set(key, strategies);
  }
  const plannedPairs = plan.strategies.length > 1 ? plan.taskIds.length * plan.repetitions : 0;
  const attemptedPairs = plannedPairs ? byPair.size : 0;
  const pairsWithBothStrategiesAttempted = plannedPairs
    ? [...byPair.values()].filter((attempts) => plan.strategies.every((strategy) => attempts.has(strategy))).length
    : 0;
  const fullySucceededPairs = plannedPairs
    ? [...byPair.values()].filter((attempts) => plan.strategies.every((strategy) => attempts.get(strategy) === 'succeeded')).length
    : 0;
  return {
    strategies: plan.strategies,
    plannedPairs,
    attemptedPairs,
    pairsWithBothStrategiesAttempted,
    fullySucceededPairs,
    incompleteAttemptedPairs: attemptedPairs - pairsWithBothStrategiesAttempted,
    notStartedPairs: Math.max(0, plannedPairs - attemptedPairs),
  };
}

export function startsPairedComparison(current: BaselineRun, next: BaselineRun | undefined): boolean {
  return !!next
    && next.taskId === current.taskId
    && next.repetition === current.repetition
    && next.strategy !== current.strategy;
}

export function createBaselinePlan(input: {
  taskIds?: readonly string[];
  strategies?: readonly BaselineStrategy[];
  repetitions?: number;
  maxTotalUsd: number;
  tasks?: readonly EvalTask[];
}): BaselinePlan {
  const tasks = input.tasks ?? agentOfficeV1Corpus;
  const taskIds = input.taskIds ?? baselineTaskIds;
  const strategies = input.strategies ?? baselineStrategies;
  const repetitions = input.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error('Repetitions must be an integer from 1 to 10.');
  if (!Number.isFinite(input.maxTotalUsd) || input.maxTotalUsd <= 0) throw new Error('A positive total USD ceiling is required.');
  if (!taskIds.length || new Set(taskIds).size !== taskIds.length) throw new Error('Task selection must be non-empty and contain no duplicates.');
  if (!strategies.length || new Set(strategies).size !== strategies.length || strategies.some((strategy) => !baselineStrategies.includes(strategy))) {
    throw new Error('Strategy selection must contain unique supported strategies.');
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selected = taskIds.map((id) => {
    const task = byId.get(id);
    if (!task) throw new Error(`Unknown eval task: ${id}.`);
    return task;
  });
  const runs = selected.flatMap((task) => Array.from({ length: repetitions }, (_, index) => strategies.map((strategy) => ({
    taskId: task.id,
    category: task.category,
    strategy,
    repetition: index + 1,
    maxBudgetUsd: task.maxBudgetUsd,
  }))).flat());
  const plannedExposureUsd = roundUsd(runs.reduce((total, run) => total + run.maxBudgetUsd, 0));
  if (plannedExposureUsd > input.maxTotalUsd + Number.EPSILON) {
    throw new Error(`Planned task ceilings total USD ${plannedExposureUsd.toFixed(2)}, above the requested USD ${input.maxTotalUsd.toFixed(2)} ceiling.`);
  }
  return { taskIds: selected.map((task) => task.id), strategies: [...strategies], repetitions, maxTotalUsd: input.maxTotalUsd, plannedExposureUsd, runs };
}

export function resolveBaselineTaskIds(value: string): string[] {
  const ids = value.split(',').map((part) => part.trim());
  if (!ids.length || ids.some((id) => !/^[A-Z][0-9]{2}$/.test(id))) throw new Error('Task IDs must be comma-separated eval IDs such as C01,R01,A01,O01 with no empty items.');
  if (new Set(ids).size !== ids.length) throw new Error('Task ID list contains duplicates.');
  return ids;
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
