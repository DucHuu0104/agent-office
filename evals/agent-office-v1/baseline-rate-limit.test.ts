import { describe, expect, it } from 'vitest';
import { createProviderPacedFetch } from './baseline-rate-limit';

describe('eval baseline provider pacing', () => {
  it('spaces concurrent calls to the provider while leaving other origins unpaced', async () => {
    const starts: number[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).origin === 'https://provider.test') starts.push(Date.now());
      return new Response('{}', { status: 200 });
    };
    const paced = createProviderPacedFetch('https://provider.test/v1', 25, fetcher);
    await Promise.all([
      paced('https://provider.test/v1/chat/completions'),
      paced('https://provider.test/v1/chat/completions'),
      paced('https://other.test/search'),
      paced('https://provider.test/v1/chat/completions'),
    ]);
    expect(starts).toHaveLength(3);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(18);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(18);
  });

  it('rejects invalid pacing intervals', () => {
    expect(() => createProviderPacedFetch('https://provider.test/v1', -1)).toThrow();
    expect(() => createProviderPacedFetch('https://provider.test/v1', 60_001)).toThrow();
  });
});
