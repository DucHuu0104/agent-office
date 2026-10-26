import { describe, expect, it } from 'vitest';
import { ExecutionSlots } from './runtime';

describe('execution concurrency limits', () => {
  it('queues FIFO when a concurrency slot is full and releases it only once', async () => {
    const slots = new ExecutionSlots(1);
    const releaseFirst = await slots.acquire();
    let secondAcquired = false;
    const second = slots.acquire().then((release) => { secondAcquired = true; return release; });
    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    releaseFirst();
    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    releaseSecond();
    releaseSecond();
    const releaseThird = await slots.acquire();
    releaseThird();
  });

  it('removes an aborted waiter without consuming a future slot', async () => {
    const slots = new ExecutionSlots(1);
    const releaseFirst = await slots.acquire();
    const controller = new AbortController();
    const cancelled = slots.acquire(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow('Run cancelled.');
    releaseFirst();

    const releaseNext = await slots.acquire();
    releaseNext();
  });
});
