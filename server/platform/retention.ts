import type { DatabaseClient } from './database';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_RUN_STATES = "'queued','planning','executing','waiting_approval','paused'";
const TERMINAL_RUN_STATES = "'succeeded','failed','cancelled','interrupted'";
const TERMINAL_TASK_STATES = "'succeeded','failed','cancelled'";

export interface RetentionResult {
  receiptsScrubbed: number;
  approvalArgumentsScrubbed: number;
  checkpointsDeleted: number;
  eventsDeleted: number;
  hookDeliveriesDeleted: number;
}

/** Removes expired execution content while keeping user-facing conversations, artifacts and active-run evidence. */
export class RetentionService {
  constructor(private readonly db: DatabaseClient, private readonly workspaceId = 'local-workspace') {}

  async prune(now = new Date()): Promise<RetentionResult> {
    const eventsBefore = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const executionContentBefore = new Date(now.getTime() - 14 * DAY_MS).toISOString();
    const result = await this.db.batch([
      { mode: 'run', sql: `UPDATE tool_operations SET receipt_json = NULL WHERE status IN ('succeeded','failed','cancelled') AND updated_at < ?
        AND run_id IN (SELECT r.id FROM runs r JOIN projects p ON p.id = r.project_id WHERE p.workspace_id = ? AND r.status IN (${TERMINAL_RUN_STATES}) AND r.updated_at < ?)`,
      params: [executionContentBefore, this.workspaceId, executionContentBefore] },
      { mode: 'run', sql: `UPDATE approvals SET arguments_json = '{}'
        WHERE status IN ('approved','denied','expired') AND arguments_json <> '{}'
          AND COALESCE(decided_at, expires_at) < ?
        AND run_id IN (SELECT r.id FROM runs r JOIN projects p ON p.id = r.project_id
          WHERE p.workspace_id = ? AND r.status IN (${TERMINAL_RUN_STATES}))`,
      params: [executionContentBefore, this.workspaceId] },
      { mode: 'run', sql: `DELETE FROM checkpoints WHERE execution_id IN (
        SELECT t.id FROM tasks t JOIN runs r ON r.id = t.run_id JOIN projects p ON p.id = r.project_id
        WHERE p.workspace_id = ? AND t.status IN (${TERMINAL_TASK_STATES}) AND r.status IN (${TERMINAL_RUN_STATES}) AND r.updated_at < ?
      )`, params: [this.workspaceId, executionContentBefore] },
      { mode: 'run', sql: `DELETE FROM domain_events WHERE workspace_id = ? AND occurred_at < ?
        AND sequence < COALESCE(
          (SELECT MIN(retained.sequence) FROM domain_events retained WHERE retained.workspace_id = ? AND EXISTS (
            SELECT 1 FROM runs r JOIN projects p ON p.id = r.project_id
            WHERE p.workspace_id = ? AND r.project_id = retained.project_id AND r.status IN (${ACTIVE_RUN_STATES})
          )),
          (SELECT MAX(sequence) FROM domain_events WHERE workspace_id = ?)
        )`, params: [this.workspaceId, eventsBefore, this.workspaceId, this.workspaceId, this.workspaceId] },
      { mode: 'run', sql: "DELETE FROM hook_outbox WHERE status IN ('completed','abandoned') AND updated_at < ?", params: [eventsBefore] },
    ], true);
    return {
      receiptsScrubbed: (result[0] as { changes?: number } | undefined)?.changes ?? 0,
      approvalArgumentsScrubbed: (result[1] as { changes?: number } | undefined)?.changes ?? 0,
      checkpointsDeleted: (result[2] as { changes?: number } | undefined)?.changes ?? 0,
      eventsDeleted: (result[3] as { changes?: number } | undefined)?.changes ?? 0,
      hookDeliveriesDeleted: (result[4] as { changes?: number } | undefined)?.changes ?? 0,
    };
  }
}
