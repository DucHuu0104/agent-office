export interface BaselineToolOperationSummary {
  toolId: string;
  status: string;
  count: number;
}

/** Keep only allowlisted operation metadata in evaluation reports, never arguments or receipts. */
export function summarizeBaselineToolOperations(
  rows: readonly {
    tool_id: string;
    status: string;
    count: number;
    arguments_json?: unknown;
    receipt_json?: unknown;
  }[],
): BaselineToolOperationSummary[] {
  return rows
    .map(({ tool_id, status, count }) => ({ toolId: tool_id, status, count }))
    .sort((left, right) => left.toolId.localeCompare(right.toolId) || left.status.localeCompare(right.status));
}
