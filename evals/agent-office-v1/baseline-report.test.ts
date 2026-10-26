import { describe, expect, it } from 'vitest';
import { summarizeBaselineToolOperations } from './baseline-report';

describe('baseline operation evidence', () => {
  it('stores aggregate tool identity and outcome without arguments or receipts', () => {
    const summaries = summarizeBaselineToolOperations([
      { tool_id: 'artifacts.create', status: 'succeeded', count: 1, arguments_json: '{"content":"private"}', receipt_json: '{"content":"private"}' },
      { tool_id: 'analysis.csv_summary', status: 'succeeded', count: 1, arguments_json: '{"file_path":"scores.csv"}' },
      { tool_id: 'analysis.csv_summary', status: 'failed', count: 1, receipt_json: '{"error":"private"}' },
    ]);

    expect(summaries).toEqual([
      { toolId: 'analysis.csv_summary', status: 'failed', count: 1 },
      { toolId: 'analysis.csv_summary', status: 'succeeded', count: 1 },
      { toolId: 'artifacts.create', status: 'succeeded', count: 1 },
    ]);
  });

  it('returns an empty list when a run did not dispatch any tool', () => {
    expect(summarizeBaselineToolOperations([])).toEqual([]);
  });
});
