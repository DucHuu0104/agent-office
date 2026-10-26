export type AttachmentMime = 'text/plain' | 'text/markdown' | 'text/csv' | 'application/json';
export type AttachmentDraftError = 'too-many' | 'unsupported-type' | 'file-too-large' | 'total-too-large';

export interface DraftAttachment {
  name: string;
  size: number;
  text(): Promise<string>;
}

const MAX_FILES = 5;
const MAX_FILE_BYTES = 65_536;
const MAX_TOTAL_BYTES = 160_000;

export function attachmentMime(name: string): AttachmentMime | null {
  switch (name.slice(name.lastIndexOf('.')).toLowerCase()) {
    case '.txt': return 'text/plain';
    case '.md': return 'text/markdown';
    case '.csv': return 'text/csv';
    case '.json': return 'application/json';
    default: return null;
  }
}

export class MessageAttachmentDraft {
  private projectId: string | null = null;
  private selected: DraftAttachment[] = [];

  get files(): DraftAttachment[] { return [...this.selected]; }

  selectProject(projectId: string): void {
    if (this.projectId === projectId) return;
    this.projectId = projectId;
    this.clear();
  }

  add(incoming: readonly DraftAttachment[]): AttachmentDraftError | null {
    const combined = [...this.selected, ...incoming];
    if (combined.length > MAX_FILES) return 'too-many';
    if (combined.some((file) => !attachmentMime(file.name))) return 'unsupported-type';
    if (combined.some((file) => file.size > MAX_FILE_BYTES)) return 'file-too-large';
    if (combined.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) return 'total-too-large';
    this.selected = combined;
    return null;
  }

  remove(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.selected.length) return;
    this.selected = this.selected.filter((_file, current) => current !== index);
  }

  clear(): void { this.selected = []; }
}
