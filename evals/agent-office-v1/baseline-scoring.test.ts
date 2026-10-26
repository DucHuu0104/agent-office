import { describe, expect, it } from 'vitest';
import { createBaselineScoreSheet, summarizeBaselineScores, validateBaselineScoreSheet, type BaselineScoreSheet } from './baseline-scoring';

const report = {
  summary: { plannedRuns: 2, measuredTokens: 640, measuredCostUsd: null },
  runs: [
    makeRun('single-agent', 'succeeded'),
    makeRun('multi-agent', 'succeeded'),
  ],
};
const reportHash = 'a'.repeat(64);

describe('manual baseline scoring', () => {
  it('creates a human-only review sheet for each run and all three rubric categories', () => {
    const sheet = createBaselineScoreSheet(report, reportHash, 'baseline-report.json', '2026-10-26T00:00:00.000Z');

    expect(sheet.runs).toHaveLength(2);
    expect(sheet.runs[0]).toMatchObject({
      runKey: 'A03/single-agent/r1',
      modelRequests: 4,
      criteria: {
        expectedProperties: [{ criterion: 'row count is correct', rating: null, note: '' }, { criterion: 'missing count is correct', rating: null, note: '' }],
        acceptance: [{ criterion: 'zero remains a value', rating: null, note: '' }],
        reviewerRubric: [{ criterion: 'does not conflate blank and zero', rating: null, note: '' }],
      },
    });
    expect(JSON.stringify(sheet)).not.toContain('private model transcript');
  });

  it('summarizes manual ratings equally by run and keeps execution outcome separate', () => {
    const scoringReport = { ...report, runs: [report.runs[0], { ...report.runs[1], status: 'failed' }] };
    const sheet = fillSheet(createBaselineScoreSheet(scoringReport, reportHash, 'baseline-report.json'));
    const summary = summarizeBaselineScores(scoringReport, reportHash, sheet, 'QA reviewer', '2026-10-26T01:00:00.000Z');

    expect(summary).toMatchObject({
      reviewer: 'QA reviewer',
      overall: {
        attemptedRuns: 2,
        succeededRuns: 1,
        nonSucceededRuns: 1,
        meanRunQualityPercent: 81.25,
        ratings: { pass: 6, partial: 1, fail: 1 },
      },
      byStrategy: [
        { strategy: 'single-agent', attemptedRuns: 1, succeededRuns: 1, meanRunQualityPercent: 62.5, ratings: { pass: 2, partial: 1, fail: 1 } },
        { strategy: 'multi-agent', attemptedRuns: 1, succeededRuns: 0, meanRunQualityPercent: 100, ratings: { pass: 4, partial: 0, fail: 0 } },
      ],
      pairedComparisons: [{
        taskId: 'A03', repetition: 1, singleAgentQualityPercent: 62.5,
        multiAgentQualityPercent: 100, multiAgentDeltaPercentagePoints: 37.5,
      }],
      unpairedAttemptedRuns: 0,
    });
    expect(summary.executionSummary).toEqual(report.summary);
    expect(summary.interpretation).toContain('do not infer statistical superiority');
  });

  it('rejects incomplete ratings, missing reasons, rubric edits and stale report hashes', () => {
    const sheet = createBaselineScoreSheet(report, reportHash, 'baseline-report.json');
    expect(validateBaselineScoreSheet(report, reportHash, sheet)).toContain('A03/single-agent/r1 expectedProperties[1] is not scored for an attempted run.');

    const filled = fillSheet(sheet);
    filled.runs[0]!.criteria.reviewerRubric[0]!.rating = 'fail';
    filled.runs[0]!.criteria.reviewerRubric[0]!.note = '';
    filled.runs[0]!.criteria.acceptance[0]!.criterion = 'rewritten rubric';
    const errors = validateBaselineScoreSheet(report, reportHash, filled);
    expect(errors).toContain('A03/single-agent/r1 acceptance[1] criterion text was changed.');
    expect(errors).toContain('A03/single-agent/r1 reviewerRubric[1] requires a note when rated partial or fail.');
    expect(validateBaselineScoreSheet(report, 'b'.repeat(64), filled)).toContain('Score sheet source report hash does not match the report file.');
  });

  it('rejects duplicate run identities in a source report', () => {
    expect(() => createBaselineScoreSheet({ runs: [makeRun('single-agent', 'succeeded'), makeRun('single-agent', 'failed')] }, reportHash, 'duplicate.json'))
      .toThrow('Baseline report has duplicate run identity A03/single-agent/r1.');
  });

  it('refuses live checkpoints and reports with no attempted model runs', () => {
    expect(() => createBaselineScoreSheet({ ...report, executionState: 'running', activeRun: { taskId: 'A03' } }, reportHash, 'partial.json'))
      .toThrow('A live or partial baseline checkpoint cannot be scored; use a finished report.');
    expect(() => createBaselineScoreSheet({ runs: [{ ...makeRun('single-agent', 'failed'), modelRequests: 0 }] }, reportHash, 'empty.json'))
      .toThrow('Baseline report has no attempted model runs to score.');
  });
});

function fillSheet(sheet: BaselineScoreSheet): BaselineScoreSheet {
  const first = sheet.runs[0]!;
  first.criteria.expectedProperties[0]!.rating = 'pass';
  first.criteria.expectedProperties[1]!.rating = 'fail';
  first.criteria.expectedProperties[1]!.note = 'The answer omitted the missing-count value.';
  first.criteria.acceptance[0]!.rating = 'pass';
  first.criteria.reviewerRubric[0]!.rating = 'partial';
  first.criteria.reviewerRubric[0]!.note = 'Zero was correct, but the explanation was ambiguous.';

  const second = sheet.runs[1]!;
  for (const category of Object.values(second.criteria)) {
    for (const review of category) review.rating = 'pass';
  }
  return sheet;
}

function makeRun(strategy: 'single-agent' | 'multi-agent', status: string) {
  return {
    taskId: 'A03', strategy, repetition: 1, status, modelRequests: 4, durationMs: 2_000,
    expectedProperties: ['row count is correct', 'missing count is correct'],
    acceptance: ['zero remains a value'],
    reviewerRubric: ['does not conflate blank and zero'],
    messages: [{ content: 'private model transcript' }],
  };
}
