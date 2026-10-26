import { describe, expect, it } from 'vitest';
import { agentOfficeV1Corpus, validateAgentOfficeV1Corpus } from '../../evals/agent-office-v1/corpus';

describe('Agent Office v1 evaluation corpus', () => {
  it('contains ten bounded, fixture-backed cases in each evaluation domain', () => {
    expect(validateAgentOfficeV1Corpus()).toEqual([]);
    expect(agentOfficeV1Corpus).toHaveLength(40);
    expect(new Set(agentOfficeV1Corpus.map((task) => task.id)).size).toBe(40);
    expect(agentOfficeV1Corpus.every((task) => task.maxBudgetUsd > 0 && task.maxBudgetUsd <= 0.3)).toBe(true);
    expect(agentOfficeV1Corpus.every((task) => task.fixtures.length > 0 && task.acceptance.length > 0 && task.reviewerRubric.length >= 3)).toBe(true);
  });

  it('keeps research fixtures explicitly synthetic and includes prompt-injection and uncertainty cases', () => {
    const research = agentOfficeV1Corpus.filter((task) => task.category === 'research');
    expect(research.every((task) => task.input.includes('synthetic source fixture'))).toBe(true);
    expect(research.find((task) => task.id === 'R08')?.fixtures[0]?.content).toContain('ATTACK:');
    expect(research.find((task) => task.id === 'R06')?.expectedProperties.join(' ')).toContain('not established');
  });

  it('gives the dirty-workspace coding case an explicit helper contract', () => {
    const task = agentOfficeV1Corpus.find((item) => item.id === 'C10')!;
    expect(task.input).toContain('sum(a: number, b: number): number');
    expect(task.expectedProperties.join(' ')).toContain('returns a + b');
    expect(task.expectedProperties.join(' ')).toContain('byte-for-byte identical');
  });

  it('keeps each fixture path relative and blocks traversal and absolute paths', () => {
    const sample = agentOfficeV1Corpus[0]!;
    expect(validateAgentOfficeV1Corpus([{ ...sample, fixtures: [{ path: '../outside.txt', content: 'x' }] }])).toContain('C01: fixture path must be relative and contained');
    expect(validateAgentOfficeV1Corpus([{ ...sample, fixtures: [{ path: 'C:\\outside.txt', content: 'x' }] }])).toContain('C01: fixture path must be relative and contained');
  });
});
