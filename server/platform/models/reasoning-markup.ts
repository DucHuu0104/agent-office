const REASONING_MARKERS = [
  { text: '<|/thinking|>', kind: 'close' },
  { text: '<|thinking|>', kind: 'open' },
  { text: '<|reasoning|>', kind: 'open' },
  { text: '<|/reasoning|>', kind: 'close' },
  { text: '<|analysis|>', kind: 'open' },
  { text: '<|/analysis|>', kind: 'close' },
  { text: '<|think|>', kind: 'open' },
  { text: '<|/think|>', kind: 'close' },
  { text: '<thinking>', kind: 'open' },
  { text: '</thinking>', kind: 'close' },
  { text: '<reasoning>', kind: 'open' },
  { text: '</reasoning>', kind: 'close' },
  { text: '<analysis>', kind: 'open' },
  { text: '</analysis>', kind: 'close' },
  { text: '<think>', kind: 'open' },
  { text: '</think>', kind: 'close' },
] as const;

type MarkerKind = (typeof REASONING_MARKERS)[number]['kind'];

/** Hides common provider reasoning markup while preserving ordinary streamed text. */
export class ReasoningMarkupFilter {
  private pending = '';
  private hiddenDepth = 0;

  push(chunk: string): string {
    this.pending += chunk;
    return this.drain(false);
  }

  finish(): string {
    return this.drain(true);
  }

  private drain(final: boolean): string {
    let output = '';
    while (this.pending) {
      const marker = findMarker(this.pending);
      if (marker) {
        if (this.hiddenDepth === 0) output += this.pending.slice(0, marker.index);
        this.pending = this.pending.slice(marker.index + marker.text.length);
        this.hiddenDepth = marker.kind === 'open'
          ? this.hiddenDepth + 1
          : Math.max(0, this.hiddenDepth - 1);
        continue;
      }

      const held = longestPossibleMarkerSuffix(this.pending);
      const visibleLength = this.pending.length - held;
      if (this.hiddenDepth === 0 && visibleLength > 0) output += this.pending.slice(0, visibleLength);
      this.pending = this.pending.slice(visibleLength);
      if (!final) break;

      // An unclosed reasoning block is private through end-of-stream. If a
      // marker itself was truncated, discard that partial marker as well.
      if (this.hiddenDepth === 0 && !held) output += this.pending;
      this.pending = '';
      break;
    }
    return output;
  }
}

export function stripPrivateReasoningMarkup(value: string): string {
  const filter = new ReasoningMarkupFilter();
  return filter.push(value) + filter.finish();
}

export function sanitizeProviderItems(output: unknown[]): Array<Record<string, unknown>> {
  return output.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)).map((item) => {
    if (item.type === 'message' && Array.isArray(item.content)) {
      return { ...item, content: item.content.map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
        const record = part as Record<string, unknown>;
        if ((record.type === 'output_text' || record.type === 'refusal') && typeof record.text === 'string') {
          return { ...record, text: stripPrivateReasoningMarkup(record.text) };
        }
        return record;
      }) };
    }
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      return { ...item, summary: item.summary.map((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
        const record = part as Record<string, unknown>;
        return typeof record.text === 'string' ? { ...record, text: stripPrivateReasoningMarkup(record.text) } : record;
      }) };
    }
    return item;
  });
}

function findMarker(value: string): { index: number; text: string; kind: MarkerKind } | undefined {
  const normalized = value.toLowerCase();
  let match: { index: number; text: string; kind: MarkerKind } | undefined;
  for (const marker of REASONING_MARKERS) {
    const index = normalized.indexOf(marker.text);
    if (index >= 0 && (!match || index < match.index || index === match.index && marker.text.length > match.text.length)) {
      match = { index, text: marker.text, kind: marker.kind };
    }
  }
  return match;
}

function longestPossibleMarkerSuffix(value: string): number {
  const lower = value.toLowerCase();
  for (let length = Math.min(lower.length, Math.max(...REASONING_MARKERS.map((marker) => marker.text.length)) - 1); length > 0; length--) {
    const suffix = lower.slice(-length);
    if (REASONING_MARKERS.some((marker) => marker.text.startsWith(suffix))) return length;
  }
  return 0;
}
