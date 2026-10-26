import { describe, expect, it } from 'vitest';
import { attachmentMime, MessageAttachmentDraft, type DraftAttachment } from './message-attachments';

function file(name: string, size: number): DraftAttachment {
  return { name, size, text: async () => 'reference text' };
}

describe('message attachment draft', () => {
  it('drops staged files when the user switches projects and keeps them on same-project refreshes', () => {
    const draft = new MessageAttachmentDraft();
    draft.selectProject('project-a');
    expect(draft.add([file('brief.md', 12)])).toBeNull();

    draft.selectProject('project-a');
    expect(draft.files.map(({ name }) => name)).toEqual(['brief.md']);

    draft.selectProject('project-b');
    expect(draft.files).toEqual([]);
  });

  it('validates file count, extensions, per-file bytes and aggregate bytes without partially accepting a batch', () => {
    const draft = new MessageAttachmentDraft();
    draft.selectProject('project-a');
    expect(draft.add([file('a.txt', 1)])).toBeNull();

    expect(draft.add([file('b.md', 1), file('c.csv', 1), file('d.json', 1), file('e.txt', 1), file('f.txt', 1)])).toBe('too-many');
    expect(draft.files.map(({ name }) => name)).toEqual(['a.txt']);
    expect(draft.add([file('brief.pdf', 1)])).toBe('unsupported-type');
    expect(draft.add([file('large.txt', 65_537)])).toBe('file-too-large');
    expect(draft.add([file('b.txt', 55_000), file('c.txt', 55_000), file('d.txt', 55_000)])).toBe('total-too-large');
    expect(draft.files.map(({ name }) => name)).toEqual(['a.txt']);

    expect(draft.add([file('b.txt', 53_333), file('c.txt', 53_333)])).toBeNull();
    expect(draft.files.reduce((total, item) => total + item.size, 0)).toBe(106_667);
  });

  it('maps supported extensions case-insensitively and removes only a valid selected index', () => {
    expect(attachmentMime('DATA.JSON')).toBe('application/json');
    expect(attachmentMime('notes.pdf')).toBeNull();
    const draft = new MessageAttachmentDraft();
    draft.selectProject('project-a');
    draft.add([file('a.txt', 1), file('b.txt', 2)]);
    draft.remove(-1);
    draft.remove(1.5);
    expect(draft.files.map(({ name }) => name)).toEqual(['a.txt', 'b.txt']);
    draft.remove(0);
    expect(draft.files.map(({ name }) => name)).toEqual(['b.txt']);
  });
});
