export function createProviderPacedFetch(
  baseUrl: string,
  minimumIntervalMs: number,
  fetcher: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!Number.isInteger(minimumIntervalMs) || minimumIntervalMs < 0 || minimumIntervalMs > 60_000) {
    throw new Error('Minimum provider request interval must be an integer from 0 to 60000 milliseconds.');
  }
  const providerBase = new URL(baseUrl);
  let nextStartAt = 0;
  let queue: Promise<void> = Promise.resolve();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = typeof input === 'string'
      ? new URL(input, providerBase)
      : input instanceof URL ? input : new URL(input.url);
    if (requestUrl.origin !== providerBase.origin || minimumIntervalMs === 0) return fetcher(input, init);

    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, nextStartAt - Date.now());
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      nextStartAt = Date.now() + minimumIntervalMs;
    } finally {
      release();
    }
    return fetcher(input, init);
  };
}
