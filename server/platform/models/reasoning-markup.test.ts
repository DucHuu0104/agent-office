import { describe, expect, it } from 'vitest';
import { ReasoningMarkupFilter, sanitizeProviderItems, stripPrivateReasoningMarkup } from './reasoning-markup';

describe('private reasoning markup filter', () => {
  it('filters markers split across streamed chunks and resumes public text', () => {
    const filter = new ReasoningMarkupFilter();
    const visible = [
      filter.push('Answer: <th'),
      filter.push('ink>private block</thi'),
      filter.push('nk>42'),
      filter.finish(),
    ].join('');

    expect(visible).toBe('Answer: 42');
  });

  it('handles nested, case-insensitive, and unmatched markers without exposing an unclosed block', () => {
    expect(stripPrivateReasoningMarkup('A<THINK>one<analysis>two</analysis>three</THINK>B')).toBe('AB');
    expect(stripPrivateReasoningMarkup('A<|thinking|>hidden<|/thinking|>B')).toBe('AB');
    expect(stripPrivateReasoningMarkup('A</think>B')).toBe('AB');
    expect(stripPrivateReasoningMarkup('A<think>unfinished')).toBe('A');
    expect(stripPrivateReasoningMarkup('ordinary text stays intact')).toBe('ordinary text stays intact');
  });

  it('sanitizes retained message and reasoning summaries while preserving opaque continuation data', () => {
    const items = sanitizeProviderItems([
      { type: 'message', content: [{ type: 'output_text', text: 'A<think>private</think>B' }, { type: 'refusal', text: 'C<analysis>private</analysis>D' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'A<reasoning>private</reasoning>B' }], encrypted_content: 'opaque-continuation' },
    ]);

    expect(items).toEqual([
      { type: 'message', content: [{ type: 'output_text', text: 'AB' }, { type: 'refusal', text: 'CD' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'AB' }], encrypted_content: 'opaque-continuation' },
    ]);
  });
});
