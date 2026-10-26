import type { DomainEvent } from '../../../shared/platform/contracts';

export interface EventObservation {
  accepted: boolean;
  gap: boolean;
}

export class DurableEventTracker {
  private lastSequence = 0;
  private readonly seenIds = new Set<string>();

  get cursor(): number { return this.lastSequence; }

  advanceTo(sequence: number): void {
    if (Number.isSafeInteger(sequence) && sequence >= 0) this.lastSequence = Math.max(this.lastSequence, sequence);
  }

  observe(event: Pick<DomainEvent, 'eventId' | 'sequence'>): EventObservation {
    if (this.seenIds.has(event.eventId) || event.sequence <= this.lastSequence) return { accepted: false, gap: false };
    const gap = event.sequence > this.lastSequence + 1;
    this.lastSequence = event.sequence;
    this.seenIds.add(event.eventId);
    if (this.seenIds.size > 1000) this.seenIds.delete(this.seenIds.values().next().value!);
    return { accepted: true, gap };
  }
}
