import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runBaselineScoringCli } from './score-baseline';

describe('baseline scoring CLI', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('creates an exclusive score template and refuses to overwrite it', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-office-score-cli-'));
    const reportPath = join(tempDir, 'report.json');
    const templatePath = join(tempDir, 'review.json');
    await writeFile(reportPath, JSON.stringify(makeReport()));

    const result = await runBaselineScoringCli(['--report', reportPath, '--template-out', templatePath]);
    const originalTemplate = await readFile(templatePath, 'utf8');
    expect(result).toMatchObject({ mode: 'template', runs: 2, modelCalls: 0 });
    const parsed = JSON.parse(originalTemplate);
    expect(parsed).toMatchObject({ formatVersion: 1 });
    expect(parsed.runs[0].runKey).toBe('R01/single-agent/r1');
    await expect(runBaselineScoringCli(['--report', reportPath, '--template-out', templatePath])).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(templatePath, 'utf8')).resolves.toBe(originalTemplate);
  });

  it('writes a verified human score summary without changing either input', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-office-score-summary-'));
    const reportPath = join(tempDir, 'report.json');
    const templatePath = join(tempDir, 'review.json');
    const summaryPath = join(tempDir, 'summary.json');
    await writeFile(reportPath, JSON.stringify(makeReport()));
    await runBaselineScoringCli(['--report', reportPath, '--template-out', templatePath]);
    const sheet = JSON.parse(await readFile(templatePath, 'utf8')) as Record<string, any>;
    for (const run of sheet.runs) for (const reviews of Object.values(run.criteria) as any[][]) for (const review of reviews) review.rating = 'pass';
    await writeFile(templatePath, JSON.stringify(sheet));
    const reportBefore = await readFile(reportPath, 'utf8');
    const sheetBefore = await readFile(templatePath, 'utf8');

    const result = await runBaselineScoringCli([
      '--report', reportPath, '--scores', templatePath, '--summary-out', summaryPath, '--reviewer', 'Reviewer 1',
    ]);
    expect(result).toMatchObject({ mode: 'summary', attemptedRuns: 2, pairedComparisons: 1, modelCalls: 0 });
    expect(JSON.parse(await readFile(summaryPath, 'utf8'))).toMatchObject({
      reviewer: 'Reviewer 1', scoreSheetSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      overall: { attemptedRuns: 2, meanRunQualityPercent: 100 }, pairedComparisons: [{ multiAgentDeltaPercentagePoints: 0 }],
    });
    const originalSummary = await readFile(summaryPath, 'utf8');
    await expect(runBaselineScoringCli([
      '--report', reportPath, '--scores', templatePath, '--summary-out', summaryPath, '--reviewer', 'Reviewer 1',
    ])).rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(summaryPath, 'utf8')).resolves.toBe(originalSummary);
    await expect(readFile(reportPath, 'utf8')).resolves.toBe(reportBefore);
    await expect(readFile(templatePath, 'utf8')).resolves.toBe(sheetBefore);
  });

  it('rejects a summary output that aliases an input and rejects incomplete score sheets', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-office-score-invalid-'));
    const reportPath = join(tempDir, 'report.json');
    const templatePath = join(tempDir, 'review.json');
    await writeFile(reportPath, JSON.stringify(makeReport()));
    await runBaselineScoringCli(['--report', reportPath, '--template-out', templatePath]);

    await expect(runBaselineScoringCli([
      '--report', reportPath, '--scores', templatePath, '--summary-out', reportPath, '--reviewer', 'Reviewer 1',
    ])).rejects.toThrow('Output path must be different from every input path.');
    await expect(runBaselineScoringCli([
      '--report', reportPath, '--scores', templatePath, '--summary-out', join(tempDir, 'summary.json'), '--reviewer', 'Reviewer 1',
    ])).rejects.toThrow('Score sheet validation failed:');
  });
});

function makeReport() {
  return {
    summary: { plannedRuns: 2, measuredTokens: 500, measuredCostUsd: null },
    runs: ['single-agent', 'multi-agent'].map((strategy) => ({
      taskId: 'R01', strategy, repetition: 1, status: 'succeeded', modelRequests: 2, durationMs: 1_000,
      expectedProperties: ['claim supported'], acceptance: ['source cited'], reviewerRubric: ['unknown is not filled from prior knowledge'],
    })),
  };
}
