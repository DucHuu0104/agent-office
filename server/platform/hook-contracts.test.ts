import { describe, expect, it } from 'vitest';
import { agentHooksSchema } from './hook-contracts';

describe('agent hook contracts', () => {
  it('accepts a registered handler only at its supported event', () => {
    const result = agentHooksSchema.safeParse({
      schemaVersion: 1,
      hooks: { before_run: [{ handler: 'context.load_project', timeoutMs: 2_000, onError: 'fail' }] },
    });

    expect(result.success).toBe(true);
  });

  it('rejects event mismatches, unknown handlers and unknown configuration fields', () => {
    const mismatch = agentHooksSchema.safeParse({
      schemaVersion: 1,
      hooks: { after_run: [{ handler: 'context.load_project', timeoutMs: 2_000, onError: 'fail' }] },
    });
    const unknownHandler = agentHooksSchema.safeParse({
      schemaVersion: 1,
      hooks: { before_run: [{ handler: 'custom.run_code', timeoutMs: 2_000, onError: 'fail' }] },
    });
    const unknownField = agentHooksSchema.safeParse({
      schemaVersion: 1,
      hooks: { before_run: [{ handler: 'context.load_project', timeoutMs: 2_000, onError: 'fail', source: './hook.ts' }] },
    });

    expect(mismatch.success).toBe(false);
    expect(unknownHandler.success).toBe(false);
    expect(unknownField.success).toBe(false);
  });
});
