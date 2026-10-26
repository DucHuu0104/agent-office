import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBaselineScoreSheet, summarizeBaselineScores, type BaselineReportForScoring } from './baseline-scoring';

interface ScoreCliOptions {
  reportPath: string;
  templateOutputPath?: string;
  scoresPath?: string;
  summaryOutputPath?: string;
  reviewer?: string;
}

export async function runBaselineScoringCli(args: string[] = process.argv.slice(2)): Promise<Record<string, unknown> | 'help'> {
  const options = parseArgs(args);
  if (options === 'help') return 'help';
  const reportPath = resolve(options.reportPath);
  const reportBytes = await readFile(reportPath);
  const reportHash = createHash('sha256').update(reportBytes).digest('hex');
  const report = parseJson(reportBytes.toString('utf8'), 'Baseline report') as BaselineReportForScoring;

  if (options.templateOutputPath) {
    const outputPath = resolve(options.templateOutputPath);
    assertDistinctOutputPaths([reportPath], outputPath);
    const sheet = createBaselineScoreSheet(report, reportHash, basename(reportPath));
    await writeExclusiveJson(outputPath, sheet);
    return { mode: 'template', reportPath, reportSha256: reportHash, outputPath, runs: sheet.runs.length, modelCalls: 0 };
  }

  const scoresPath = resolve(options.scoresPath!);
  const outputPath = resolve(options.summaryOutputPath!);
  assertDistinctOutputPaths([reportPath, scoresPath], outputPath);
  const scoreBytes = await readFile(scoresPath);
  const scoreHash = createHash('sha256').update(scoreBytes).digest('hex');
  const sheet = parseJson(scoreBytes.toString('utf8'), 'Score sheet');
  const summary = { ...summarizeBaselineScores(report, reportHash, sheet, options.reviewer!), scoreSheetSha256: scoreHash };
  await writeExclusiveJson(outputPath, summary);
  return {
    mode: 'summary', reportPath, reportSha256: reportHash, scoresPath, outputPath,
    attemptedRuns: summary.overall.attemptedRuns, pairedComparisons: summary.pairedComparisons.length,
    modelCalls: 0, summary,
  };
}

function parseArgs(args: string[]): ScoreCliOptions | 'help' {
  if (args.includes('--help') || args.includes('-h')) return 'help';
  const values = new Map<string, string>();
  const known = new Set(['--report', '--template-out', '--scores', '--summary-out', '--reviewer']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (!known.has(flag)) throw new Error(`Unknown option ${flag}.`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    if (values.has(flag)) throw new Error(`${flag} may be specified only once.`);
    values.set(flag, value);
    index++;
  }
  const reportPath = values.get('--report');
  if (!reportPath) throw new Error('--report is required.');
  const templateOutputPath = values.get('--template-out');
  const scoresPath = values.get('--scores');
  const summaryOutputPath = values.get('--summary-out');
  const reviewer = values.get('--reviewer');
  const templateMode = !!templateOutputPath && !scoresPath && !summaryOutputPath && !reviewer;
  const summaryMode = !templateOutputPath && !!scoresPath && !!summaryOutputPath && !!reviewer?.trim();
  if (!templateMode && !summaryMode) {
    throw new Error('Choose either --template-out PATH, or --scores PATH --summary-out PATH --reviewer NAME.');
  }
  return {
    reportPath,
    ...(templateOutputPath ? { templateOutputPath } : {}),
    ...(scoresPath ? { scoresPath } : {}),
    ...(summaryOutputPath ? { summaryOutputPath } : {}),
    ...(reviewer ? { reviewer } : {}),
  };
}

function parseJson(source: string, label: string): unknown {
  try { return JSON.parse(source) as unknown; }
  catch { throw new Error(`${label} is not valid JSON.`); }
}

function assertDistinctOutputPaths(readPaths: string[], outputPath: string): void {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const output = normalize(outputPath);
  if (readPaths.some((path) => normalize(path) === output)) throw new Error('Output path must be different from every input path.');
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function printHelp(): void {
  process.stdout.write([
    'Usage:',
    '  npm run eval:score -- --report REPORT.json --template-out REVIEW.json',
    '  npm run eval:score -- --report REPORT.json --scores REVIEW.json --summary-out SUMMARY.json --reviewer NAME',
    '',
    'The template contains blank human ratings for each expected property, acceptance item, and reviewer rubric criterion.',
    'Edit ratings to pass, partial, or fail; partial/fail ratings require a note. The tool never calls a model or overwrites files.',
  ].join('\n') + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runBaselineScoringCli().then((result) => {
    if (result === 'help') printHelp();
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Baseline scoring failed.'}\n`);
    process.exitCode = 1;
  });
}
