export type ApprovalDiffKind = 'context' | 'addition' | 'deletion';

export interface ApprovalDiffLine {
  kind: ApprovalDiffKind;
  text: string;
}

export interface ApprovalDiff {
  available: boolean;
  lines: ApprovalDiffLine[];
  additions: number;
  deletions: number;
}

const MAX_DIFF_LINES = 2_000;
const MAX_DIFF_CELLS = 1_000_000;
const MAX_DIFF_OUTPUT_CHARACTERS = 40_000;

export function createApprovalDiff(before: string, after: string): ApprovalDiff {
  if (before === after) return { available: true, lines: [], additions: 0, deletions: 0 };
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length + afterLines.length > MAX_DIFF_LINES
    || (beforeLines.length + 1) * (afterLines.length + 1) > MAX_DIFF_CELLS) return unavailable();

  const width = afterLines.length + 1;
  const table = new Uint16Array((beforeLines.length + 1) * width);
  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex--) {
      const index = beforeIndex * width + afterIndex;
      table[index] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? table[(beforeIndex + 1) * width + afterIndex + 1]! + 1
        : Math.max(table[(beforeIndex + 1) * width + afterIndex]!, table[index + 1]!);
    }
  }

  const lines: ApprovalDiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let beforeIndex = 0;
  let afterIndex = 0;
  let outputCharacters = 0;
  const push = (kind: ApprovalDiffKind, text: string) => {
    outputCharacters += text.length + 3;
    if (outputCharacters > MAX_DIFF_OUTPUT_CHARACTERS) return false;
    lines.push({ kind, text });
    if (kind === 'addition') additions++;
    if (kind === 'deletion') deletions++;
    return true;
  };

  while (beforeIndex < beforeLines.length || afterIndex < afterLines.length) {
    if (beforeIndex < beforeLines.length && afterIndex < afterLines.length && beforeLines[beforeIndex] === afterLines[afterIndex]) {
      if (!push('context', beforeLines[beforeIndex]!)) return unavailable();
      beforeIndex++;
      afterIndex++;
      continue;
    }
    const deleteScore = beforeIndex < beforeLines.length ? table[(beforeIndex + 1) * width + afterIndex]! : -1;
    const addScore = afterIndex < afterLines.length ? table[beforeIndex * width + afterIndex + 1]! : -1;
    if (beforeIndex < beforeLines.length && (afterIndex >= afterLines.length || deleteScore >= addScore)) {
      if (!push('deletion', beforeLines[beforeIndex]!)) return unavailable();
      beforeIndex++;
    } else {
      if (!push('addition', afterLines[afterIndex]!)) return unavailable();
      afterIndex++;
    }
  }
  return { available: true, lines, additions, deletions };
}

function splitLines(content: string): string[] {
  if (!content) return [];
  return content.split('\n').map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
}

function unavailable(): ApprovalDiff {
  return { available: false, lines: [], additions: 0, deletions: 0 };
}
