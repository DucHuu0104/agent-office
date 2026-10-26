import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatTool } from './models/types';
import { compactCheckpointHistory } from './compaction';

const tools: ChatTool[] = [{ type: 'function', function: { name: 'artifact.create', description: 'Create an artifact.', parameters: { type: 'object' } } }];

function turn(number: number, size = 2_800): ChatMessage[] {
  const id = `call-${number}`;
  return [
    { role: 'assistant', content: `Turn ${number} progress note`, tool_calls: [{ id, type: 'function', function: { name: 'artifact.create', arguments: JSON.stringify({ number }) } }], providerItems: [{ type: 'function_call', call_id: id, name: 'artifact.create', arguments: JSON.stringify({ number }) }] },
    { role: 'tool', tool_call_id: id, content: `receipt-${number}-${'x'.repeat(size)}` },
  ];
}

describe('specialist checkpoint compaction', () => {
  it('keeps the objective, steering, recent complete tool pairs and versioned evidence references', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system policy' },
      { role: 'user', content: 'Build the requested deliverable.' },
      ...turn(1),
      { role: 'user', content: '[Owner steering command #1]\nKeep the output as CSV.' },
      ...turn(2), ...turn(3), ...turn(4), ...turn(5), ...turn(6),
    ];

    const result = compactCheckpointHistory(messages, tools, undefined, 12_000, 'checkpoint-before-compact');

    expect(result.changed).toBe(true);
    expect(result.estimatedBytes).toBeLessThanOrEqual(12_000);
    expect(result.compaction).toMatchObject({ version: 1, archivedTurnCount: 3, archivedMessageCount: 6 });
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toEqual(messages[1]);
    expect(result.messages.some((message) => message.content?.includes('Keep the output as CSV.'))).toBe(true);
    expect(result.messages.filter((message) => message.role === 'assistant' && message.tool_calls?.length)).toHaveLength(3);
    expect(result.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
    for (const assistant of result.messages.filter((message) => message.role === 'assistant' && message.tool_calls?.length)) {
      expect(assistant.providerItems?.[0]?.call_id).toBe(assistant.tool_calls?.[0]?.id);
    }
    expect(result.compaction?.evidenceRefs).toHaveLength(3);
    const firstReference = result.compaction!.evidenceRefs[0]!;
    expect(firstReference).toEqual({
      toolCallId: 'call-1', toolName: 'artifact.create',
      outputSha256: createHash('sha256').update(`receipt-1-${'x'.repeat(2_800)}`).digest('hex'),
    });
    expect(result.messages.find((message) => message.name === 'agent_office_compaction')?.content).toContain(result.compaction?.archiveHash);
    expect(result.compaction?.checkpointRefs).toEqual([{ checkpointId: 'checkpoint-before-compact', archiveHash: expect.any(String) }]);
    expect(result.messages.find((message) => message.name === 'agent_office_compaction')?.content).toContain('Turn 3 progress note');
    expect(result.messages.some((message) => message.content?.includes('receipt-1-'))).toBe(false);
  });

  it('leaves small and incomplete histories intact instead of breaking tool protocol pairs', () => {
    const small: ChatMessage[] = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'objective' }, ...turn(1, 10)];
    expect(compactCheckpointHistory(small, tools).changed).toBe(false);

    const incomplete: ChatMessage[] = [
      { role: 'system', content: 'policy' }, { role: 'user', content: 'objective' },
      ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5),
      { role: 'assistant', content: null, tool_calls: [{ id: 'unresolved', type: 'function', function: { name: 'artifact.create', arguments: '{}' } }] },
    ];
    const result = compactCheckpointHistory(incomplete, tools, undefined, 12_000);
    expect(result.messages.at(-1)).toEqual(incomplete.at(-1));
    expect(result.messages.some((message) => message.role === 'assistant' && message.tool_calls?.some((call) => call.id === 'unresolved'))).toBe(true);
    for (const assistant of result.messages.filter((message) => message.role === 'assistant' && message.tool_calls?.length)) {
      for (const call of assistant.tool_calls ?? []) {
        const hasOutput = result.messages.some((message) => message.role === 'tool' && message.tool_call_id === call.id);
        if (call.id === 'unresolved') expect(hasOutput).toBe(false);
        else expect(hasOutput).toBe(true);
      }
    }
  });

  it('keeps groups with duplicate tool IDs intact for recovery review', () => {
    const malformed: ChatMessage[] = [
      { role: 'system', content: 'policy' }, { role: 'user', content: 'objective' },
      { role: 'assistant', content: 'old', tool_calls: [
        { id: 'duplicate', type: 'function', function: { name: 'artifact.create', arguments: '{}' } },
        { id: 'duplicate', type: 'function', function: { name: 'artifact.create', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'duplicate', content: 'ambiguous output' },
      ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5),
    ];

    const result = compactCheckpointHistory(malformed, tools, undefined, 12_000);
    expect(result.messages.some((message) => message.role === 'assistant' && message.content === 'old')).toBe(true);
  });

  it('carries the compaction chain forward when later turns need a second compaction', () => {
    const firstMessages: ChatMessage[] = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'objective' }, ...turn(1), ...turn(2), ...turn(3), ...turn(4), ...turn(5), ...turn(6)];
    const first = compactCheckpointHistory(firstMessages, tools, undefined, 12_000, 'checkpoint-first');
    expect(first.changed).toBe(true);
    const next = compactCheckpointHistory([...first.messages, ...turn(7), ...turn(8), ...turn(9), ...turn(10)], tools, first.compaction, 12_000, 'checkpoint-second');
    expect(next.changed).toBe(true);
    expect(next.compaction?.archivedTurnCount).toBeGreaterThan(first.compaction!.archivedTurnCount);
    expect(next.compaction?.evidenceRefs.map((item) => item.toolCallId)).toEqual(expect.arrayContaining(['call-1', 'call-6']));
    expect(next.compaction?.evidenceRefs.some((item) => item.toolCallId === 'call-10')).toBe(false);
    expect(next.compaction?.taskNotes).toContain('Turn 1 progress note');
    expect(next.compaction?.checkpointRefs.map((reference) => reference.checkpointId)).toEqual(['checkpoint-first', 'checkpoint-second']);
  });
});
