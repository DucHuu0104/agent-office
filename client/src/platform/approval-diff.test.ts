import { describe, expect, it } from 'vitest';
import { createApprovalDiff } from './approval-diff';

describe('workspace approval diff', () => {
  it('shows exact context, inserted lines and removed lines', () => {
    const diff = createApprovalDiff('keep\nold value\nend\n', 'keep\nnew value\nextra\nend\n');

    expect(diff).toEqual({
      available: true,
      additions: 2,
      deletions: 1,
      lines: [
        { kind: 'context', text: 'keep' },
        { kind: 'deletion', text: 'old value' },
        { kind: 'addition', text: 'new value' },
        { kind: 'addition', text: 'extra' },
        { kind: 'context', text: 'end' },
        { kind: 'context', text: '' },
      ],
    });
  });

  it('represents a new file as additions and unchanged files as an empty diff', () => {
    expect(createApprovalDiff('', 'first\nsecond')).toMatchObject({
      available: true, additions: 2, deletions: 0,
      lines: [{ kind: 'addition', text: 'first' }, { kind: 'addition', text: 'second' }],
    });
    expect(createApprovalDiff('same\n', 'same\n')).toEqual({ available: true, lines: [], additions: 0, deletions: 0 });
  });

  it('falls back to bounded before/after views for very large diffs', () => {
    const manyLines = Array.from({ length: 2_001 }, (_, index) => `line ${index}`).join('\n');

    expect(createApprovalDiff(manyLines, `${manyLines}\nnew line`)).toEqual({ available: false, lines: [], additions: 0, deletions: 0 });
  });
});
