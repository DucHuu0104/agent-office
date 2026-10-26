import type { DatabaseClient } from './database';

export const ASSIGNMENT_LEASE_TTL_MS = 60_000;
export const ASSIGNMENT_LEASE_HEARTBEAT_MS = 15_000;

export interface AssignmentLease {
  assignmentId: string;
  taskId: string;
  agentInstanceId: string;
  ownerId: string;
  fenceToken: number;
}

export class AssignmentLeaseLostError extends Error {
  readonly code = 'ASSIGNMENT_LEASE_LOST';

  constructor(message = 'Assignment lease was lost; this worker can no longer commit results.') {
    super(message);
    this.name = 'AssignmentLeaseLostError';
  }
}

export interface AssignmentLeaseSession {
  readonly lease: AssignmentLease;
  readonly signal: AbortSignal;
  assertActive(): Promise<void>;
  stop(): Promise<void>;
}

export async function assertAssignmentLease(db: DatabaseClient, lease: AssignmentLease, now = new Date().toISOString()): Promise<void> {
  const row = await db.one<{ id: string }>(`SELECT id FROM assignments
    WHERE id = ? AND task_id = ? AND agent_instance_id = ? AND lease_owner = ? AND fence_token = ?
      AND status = 'active' AND lease_expires_at > ?`,
  [lease.assignmentId, lease.taskId, lease.agentInstanceId, lease.ownerId, lease.fenceToken, now]);
  if (!row) throw new AssignmentLeaseLostError();
}

export async function renewAssignmentLease(
  db: DatabaseClient,
  lease: AssignmentLease,
  options: { nowMs?: number; ttlMs?: number } = {},
): Promise<boolean> {
  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const leaseExpiresAt = new Date(nowMs + (options.ttlMs ?? ASSIGNMENT_LEASE_TTL_MS)).toISOString();
  const result = await db.run(`UPDATE assignments SET lease_expires_at = ?
    WHERE id = ? AND task_id = ? AND agent_instance_id = ? AND lease_owner = ? AND fence_token = ?
      AND status = 'active' AND lease_expires_at > ?`,
  [leaseExpiresAt, lease.assignmentId, lease.taskId, lease.agentInstanceId, lease.ownerId, lease.fenceToken, now]);
  return result.changes === 1;
}

export function startAssignmentLeaseSession(
  db: DatabaseClient,
  lease: AssignmentLease,
  parentSignal: AbortSignal,
  options: { heartbeatMs?: number; ttlMs?: number } = {},
): AssignmentLeaseSession {
  const controller = new AbortController();
  const heartbeatStop = new AbortController();
  const heartbeatMs = options.heartbeatMs ?? ASSIGNMENT_LEASE_HEARTBEAT_MS;
  let stopped = false;

  const abortFromParent = () => {
    controller.abort(parentSignal.reason);
    heartbeatStop.abort();
  };
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });

  const heartbeat = (async () => {
    while (!stopped && !controller.signal.aborted) {
      try {
        await waitForHeartbeat(heartbeatMs, heartbeatStop.signal);
      } catch {
        return;
      }
      if (stopped || controller.signal.aborted) return;
      try {
        const renewed = await renewAssignmentLease(db, lease, { ttlMs: options.ttlMs });
        if (!renewed) throw new AssignmentLeaseLostError();
      } catch {
        controller.abort(new AssignmentLeaseLostError());
        heartbeatStop.abort();
        return;
      }
    }
  })();

  return {
    lease,
    signal: controller.signal,
    async assertActive() {
      if (controller.signal.aborted) {
        if (controller.signal.reason instanceof Error) throw controller.signal.reason;
        throw new AssignmentLeaseLostError();
      }
      try {
        await assertAssignmentLease(db, lease);
      } catch (error) {
        const lost = error instanceof AssignmentLeaseLostError ? error : new AssignmentLeaseLostError();
        controller.abort(lost);
        heartbeatStop.abort();
        throw lost;
      }
    },
    async stop() {
      stopped = true;
      parentSignal.removeEventListener('abort', abortFromParent);
      heartbeatStop.abort();
      await heartbeat;
    },
  };
}

function waitForHeartbeat(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
