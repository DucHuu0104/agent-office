import { describe, expect, it } from 'vitest';
import { DurableEventTracker } from './durable-events';

describe('durable SSE event tracking', () => {
  it('accepts the next event and ignores a duplicate delivery', () => {
    const tracker = new DurableEventTracker();
    tracker.advanceTo(40);
    const event = { eventId: 'event-41', sequence: 41 };

    expect(tracker.observe(event)).toEqual({ accepted: true, gap: false });
    expect(tracker.observe(event)).toEqual({ accepted: false, gap: false });
    expect(tracker.cursor).toBe(41);
  });

  it('requests a snapshot when the event sequence has a gap, including from an empty cursor', () => {
    const tracker = new DurableEventTracker();

    expect(tracker.observe({ eventId: 'event-3', sequence: 3 })).toEqual({ accepted: true, gap: true });
    expect(tracker.cursor).toBe(3);
  });

  it('never moves the cursor backward when a refresh returns an older snapshot', () => {
    const tracker = new DurableEventTracker();
    tracker.advanceTo(7);
    expect(tracker.observe({ eventId: 'event-8', sequence: 8 })).toEqual({ accepted: true, gap: false });

    tracker.advanceTo(6);
    expect(tracker.cursor).toBe(8);
    expect(tracker.observe({ eventId: 'event-7', sequence: 7 })).toEqual({ accepted: false, gap: false });
  });
});
