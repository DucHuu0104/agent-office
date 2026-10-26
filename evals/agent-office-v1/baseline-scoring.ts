export const BASELINE_SCORE_CATEGORIES = ['expectedProperties', 'acceptance', 'reviewerRubric'] as const;
export const BASELINE_QUALITY_RATINGS = ['pass', 'partial', 'fail'] as const;

export type BaselineScoreCategory = typeof BASELINE_SCORE_CATEGORIES[number];
export type BaselineQualityRating = typeof BASELINE_QUALITY_RATINGS[number];

export interface BaselineCriterionReview {
  criterion: string;
  rating: BaselineQualityRating | null;
  note: string;
}

export interface BaselineScoreRun {
  runKey: string;
  taskId: string;
  strategy: 'single-agent' | 'multi-agent';
  repetition: number;
  executionStatus: string;
  modelRequests: number;
  durationMs: number;
  criteria: Record<BaselineScoreCategory, BaselineCriterionReview[]>;
}

export interface BaselineScoreSheet {
  formatVersion: 1;
  sourceReportSha256: string;
  sourceReportFile: string;
  createdAt: string;
  runs: BaselineScoreRun[];
}

export type BaselineExecutionRun = {
  taskId?: unknown;
  strategy?: unknown;
  repetition?: unknown;
  status?: unknown;
  modelRequests?: unknown;
  durationMs?: unknown;
  expectedProperties?: unknown;
  acceptance?: unknown;
  reviewerRubric?: unknown;
};

export interface BaselineReportForScoring {
  executionState?: unknown;
  activeRun?: unknown;
  runs?: unknown;
  summary?: unknown;
}

export interface BaselineScoreSummary {
  formatVersion: 1;
  sourceReportSha256: string;
  scoreSheetSha256?: string;
  sourceReportFile: string;
  reviewer: string;
  reviewedAt: string;
  scoringMethod: string;
  executionSummary: unknown;
  overall: {
    attemptedRuns: number;
    succeededRuns: number;
    nonSucceededRuns: number;
    meanRunQualityPercent: number | null;
    ratings: RatingCounts;
  };
  byStrategy: Array<{
    strategy: 'single-agent' | 'multi-agent';
    attemptedRuns: number;
    succeededRuns: number;
    nonSucceededRuns: number;
    meanRunQualityPercent: number | null;
    ratings: RatingCounts;
  }>;
  pairedComparisons: Array<{
    taskId: string;
    repetition: number;
    singleAgentQualityPercent: number;
    multiAgentQualityPercent: number;
    multiAgentDeltaPercentagePoints: number;
  }>;
  unpairedAttemptedRuns: number;
  interpretation: string;
}

interface RatingCounts {
  pass: number;
  partial: number;
  fail: number;
}

const RATING_POINTS: Record<BaselineQualityRating, number> = { pass: 1, partial: 0.5, fail: 0 };
const MAX_REVIEW_NOTE_CHARS = 2_000;

export function createBaselineScoreSheet(
  report: BaselineReportForScoring,
  sourceReportSha256: string,
  sourceReportFile: string,
  createdAt = new Date().toISOString(),
): BaselineScoreSheet {
  if (!/^[a-f0-9]{64}$/i.test(sourceReportSha256)) throw new Error('Source report hash must be a SHA-256 hex digest.');
  if (!sourceReportFile.trim()) throw new Error('Source report filename is required.');
  if (report.executionState === 'running' || report.activeRun != null) throw new Error('A live or partial baseline checkpoint cannot be scored; use a finished report.');
  if (!Array.isArray(report.runs)) throw new Error('Baseline report must contain a runs array.');

  const seen = new Set<string>();
  const runs = report.runs.map((value, index) => {
    const run = value as BaselineExecutionRun;
    if (typeof run.taskId !== 'string' || !run.taskId.trim()) throw new Error(`Run ${index + 1} is missing taskId.`);
    if (run.strategy !== 'single-agent' && run.strategy !== 'multi-agent') throw new Error(`Run ${index + 1} has an unsupported strategy.`);
    if (!Number.isInteger(run.repetition) || Number(run.repetition) < 1) throw new Error(`Run ${index + 1} has an invalid repetition.`);
    if (typeof run.status !== 'string' || !run.status) throw new Error(`Run ${index + 1} is missing execution status.`);
    const modelRequests = finiteNonNegativeInteger(run.modelRequests, `Run ${index + 1} modelRequests`);
    const durationMs = finiteNonNegativeInteger(run.durationMs, `Run ${index + 1} durationMs`);
    const runKey = baselineRunKey(run.taskId, run.strategy, Number(run.repetition));
    if (seen.has(runKey)) throw new Error(`Baseline report has duplicate run identity ${runKey}.`);
    seen.add(runKey);

    return {
      runKey,
      taskId: run.taskId,
      strategy: run.strategy,
      repetition: Number(run.repetition),
      executionStatus: run.status,
      modelRequests,
      durationMs,
      criteria: {
        expectedProperties: makeReviews(run.expectedProperties, `Run ${runKey} expectedProperties`),
        acceptance: makeReviews(run.acceptance, `Run ${runKey} acceptance`),
        reviewerRubric: makeReviews(run.reviewerRubric, `Run ${runKey} reviewerRubric`),
      },
    } satisfies BaselineScoreRun;
  });
  if (!runs.some((run) => run.modelRequests > 0)) throw new Error('Baseline report has no attempted model runs to score.');

  return {
    formatVersion: 1,
    sourceReportSha256: sourceReportSha256.toLowerCase(),
    sourceReportFile,
    createdAt,
    runs,
  };
}

export function validateBaselineScoreSheet(
  report: BaselineReportForScoring,
  reportSha256: string,
  sheet: unknown,
): string[] {
  let expected: BaselineScoreSheet;
  try {
    expected = createBaselineScoreSheet(report, reportSha256, 'source-report.json');
  } catch (error) {
    return [error instanceof Error ? error.message : 'Baseline report cannot be scored.'];
  }
  if (!isRecord(sheet)) return ['Score sheet must be a JSON object.'];
  const errors: string[] = [];
  if (sheet.formatVersion !== 1) errors.push('Score sheet formatVersion must be 1.');
  if (sheet.sourceReportSha256 !== reportSha256) errors.push('Score sheet source report hash does not match the report file.');
  if (!Array.isArray(sheet.runs)) return [...errors, 'Score sheet must contain a runs array.'];

  const actualByKey = new Map<string, Record<string, unknown>>();
  for (const [index, value] of sheet.runs.entries()) {
    if (!isRecord(value) || typeof value.runKey !== 'string') {
      errors.push(`Score sheet run ${index + 1} is missing runKey.`);
      continue;
    }
    if (actualByKey.has(value.runKey)) errors.push(`Score sheet has duplicate run ${value.runKey}.`);
    else actualByKey.set(value.runKey, value);
  }

  for (const expectedRun of expected.runs) {
    const actual = actualByKey.get(expectedRun.runKey);
    if (!actual) {
      errors.push(`Score sheet is missing run ${expectedRun.runKey}.`);
      continue;
    }
    for (const field of ['taskId', 'strategy', 'repetition', 'executionStatus', 'modelRequests', 'durationMs'] as const) {
      if (actual[field] !== expectedRun[field]) errors.push(`Run ${expectedRun.runKey} changed immutable field ${field}.`);
    }
    const actualCriteria = actual.criteria;
    if (!isRecord(actualCriteria)) {
      errors.push(`Run ${expectedRun.runKey} must contain criteria by category.`);
      continue;
    }
    for (const category of BASELINE_SCORE_CATEGORIES) {
      const actualReviews = actualCriteria[category];
      const expectedReviews = expectedRun.criteria[category];
      if (!Array.isArray(actualReviews) || actualReviews.length !== expectedReviews.length) {
        errors.push(`Run ${expectedRun.runKey} has an invalid ${category} criterion list.`);
        continue;
      }
      for (let index = 0; index < expectedReviews.length; index++) {
        const review = actualReviews[index];
        const label = `${expectedRun.runKey} ${category}[${index + 1}]`;
        if (!isRecord(review) || review.criterion !== expectedReviews[index]!.criterion) {
          errors.push(`${label} criterion text was changed.`);
          continue;
        }
        if (review.rating !== null && !BASELINE_QUALITY_RATINGS.includes(review.rating as BaselineQualityRating)) {
          errors.push(`${label} rating must be pass, partial, fail, or null.`);
          continue;
        }
        if (typeof review.note !== 'string' || review.note.length > MAX_REVIEW_NOTE_CHARS) {
          errors.push(`${label} note must be text of at most ${MAX_REVIEW_NOTE_CHARS} characters.`);
          continue;
        }
        if ((review.rating === 'partial' || review.rating === 'fail') && !review.note.trim()) {
          errors.push(`${label} requires a note when rated partial or fail.`);
        }
        if (expectedRun.modelRequests > 0 && review.rating === null) {
          errors.push(`${label} is not scored for an attempted run.`);
        }
        if (expectedRun.modelRequests === 0 && review.rating !== null) {
          errors.push(`${label} cannot be scored because the run made no model request.`);
        }
      }
    }
  }
  for (const key of actualByKey.keys()) {
    if (!expected.runs.some((run) => run.runKey === key)) errors.push(`Score sheet contains unknown run ${key}.`);
  }
  return errors;
}

export function summarizeBaselineScores(
  report: BaselineReportForScoring,
  reportSha256: string,
  sheetValue: unknown,
  reviewer: string,
  reviewedAt = new Date().toISOString(),
): BaselineScoreSummary {
  const errors = validateBaselineScoreSheet(report, reportSha256, sheetValue);
  if (errors.length) throw new Error(`Score sheet validation failed:\n- ${errors.join('\n- ')}`);
  if (!reviewer.trim()) throw new Error('Reviewer name is required.');
  const expected = createBaselineScoreSheet(report, reportSha256, 'source-report.json');
  const sheet = sheetValue as BaselineScoreSheet;
  const reviewsByKey = new Map(sheet.runs.map((run) => [run.runKey, run]));
  const attempted = expected.runs.filter((run) => run.modelRequests > 0);
  const scored = attempted.map((run) => {
    const review = reviewsByKey.get(run.runKey)!;
    const allReviews = BASELINE_SCORE_CATEGORIES.flatMap((category) => review.criteria[category]);
    const ratings = allReviews.map((item) => item.rating!).filter((rating): rating is BaselineQualityRating => rating !== null);
    const points = ratings.reduce((sum, rating) => sum + RATING_POINTS[rating], 0);
    return {
      taskId: run.taskId,
      strategy: run.strategy,
      repetition: run.repetition,
      executionStatus: run.executionStatus,
      qualityPercent: ratioToPercent(points / ratings.length),
      ratings,
    };
  });
  const totalRatings = countRatings(scored.flatMap((run) => run.ratings));
  const byStrategy = (['single-agent', 'multi-agent'] as const).map((strategy) => summarizeStrategy(strategy, scored.filter((run) => run.strategy === strategy)));
  const byPair = new Map<string, Map<'single-agent' | 'multi-agent', typeof scored[number]>>();
  for (const run of scored) {
    const key = `${run.taskId}#${run.repetition}`;
    const pair = byPair.get(key) ?? new Map();
    pair.set(run.strategy, run);
    byPair.set(key, pair);
  }
  const pairedComparisons = [...byPair.entries()].flatMap(([key, pair]) => {
    const single = pair.get('single-agent');
    const multi = pair.get('multi-agent');
    if (!single || !multi) return [];
    return [{
      taskId: single.taskId,
      repetition: single.repetition,
      singleAgentQualityPercent: single.qualityPercent,
      multiAgentQualityPercent: multi.qualityPercent,
      multiAgentDeltaPercentagePoints: roundPercent(multi.qualityPercent - single.qualityPercent),
      _key: key,
    }];
  }).map(({ _key: _ignored, ...pair }) => pair);

  return {
    formatVersion: 1,
    sourceReportSha256: reportSha256,
    sourceReportFile: typeof sheet.sourceReportFile === 'string' ? sheet.sourceReportFile : 'source-report.json',
    reviewer: reviewer.trim(),
    reviewedAt,
    scoringMethod: 'Manual ratings only: pass=1, partial=0.5, fail=0. Mean is computed per run first, then averaged equally across attempted runs.',
    executionSummary: report.summary ?? null,
    overall: {
      attemptedRuns: attempted.length,
      succeededRuns: scored.filter((run) => run.executionStatus === 'succeeded').length,
      nonSucceededRuns: scored.filter((run) => run.executionStatus !== 'succeeded').length,
      meanRunQualityPercent: mean(scored.map((run) => run.qualityPercent)),
      ratings: totalRatings,
    },
    byStrategy,
    pairedComparisons,
    unpairedAttemptedRuns: scored.length - pairedComparisons.length * 2,
    interpretation: 'Descriptive human-reviewed results for this report only. Execution success and rubric quality are separate; do not infer statistical superiority from a small or incomplete sample.',
  };
}

function summarizeStrategy(strategy: 'single-agent' | 'multi-agent', runs: Array<{ executionStatus: string; qualityPercent: number; ratings: BaselineQualityRating[] }>) {
  return {
    strategy,
    attemptedRuns: runs.length,
    succeededRuns: runs.filter((run) => run.executionStatus === 'succeeded').length,
    nonSucceededRuns: runs.filter((run) => run.executionStatus !== 'succeeded').length,
    meanRunQualityPercent: mean(runs.map((run) => run.qualityPercent)),
    ratings: countRatings(runs.flatMap((run) => run.ratings)),
  };
}

function makeReviews(value: unknown, label: string): BaselineCriterionReview[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((criterion) => typeof criterion === 'string' && criterion.trim())) {
    throw new Error(`${label} must be a non-empty array of non-empty strings.`);
  }
  return value.map((criterion) => ({ criterion, rating: null, note: '' }));
}

function baselineRunKey(taskId: string, strategy: string, repetition: number): string {
  return `${taskId}/${strategy}/r${repetition}`;
}

function finiteNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return Number(value);
}

function countRatings(values: readonly BaselineQualityRating[]): RatingCounts {
  return values.reduce<RatingCounts>((counts, value) => {
    counts[value]++;
    return counts;
  }, { pass: 0, partial: 0, fail: 0 });
}

function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return roundPercent(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function roundPercent(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function ratioToPercent(value: number): number {
  return roundPercent(value * 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
