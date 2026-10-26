import { randomBytes } from 'node:crypto';
import type { ArtifactService } from './artifacts';

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_PREVIEWS = 64;
const PREVIEWABLE_MIME = new Set(['text/html', 'text/markdown', 'text/plain', 'text/csv', 'application/json']);

interface PreviewSession {
  projectId: string;
  versionId: string;
  expiresAt: number;
}

export interface ArtifactPreviewContent {
  logicalName: string;
  html: Buffer;
  expiresAt: string;
}

/** Issues short-lived, project-scoped URLs for read-only artifact previews. */
export class ArtifactPreviewManager {
  private readonly sessions = new Map<string, PreviewSession>();

  constructor(private readonly artifacts: ArtifactService) {}

  async open(projectId: string, versionId: string): Promise<{ token: string; expiresAt: string }> {
    this.pruneExpired();
    const artifact = await this.artifacts.content(versionId);
    if (!artifact || artifact.info.projectId !== projectId) throw Object.assign(new Error('Artifact không thuộc project đang chọn.'), { status: 404, code: 'ARTIFACT_NOT_FOUND' });
    if (!PREVIEWABLE_MIME.has(artifact.info.mimeType)) throw Object.assign(new Error('Loại artifact này không hỗ trợ xem trước.'), { status: 415, code: 'PREVIEW_UNSUPPORTED' });
    if (this.sessions.size >= MAX_ACTIVE_PREVIEWS) throw Object.assign(new Error('Đã đạt giới hạn preview đang mở. Hãy đóng preview khác rồi thử lại.'), { status: 429, code: 'PREVIEW_LIMIT' });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    this.sessions.set(token, { projectId, versionId, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async read(token: string): Promise<ArtifactPreviewContent | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    const artifact = await this.artifacts.content(session.versionId);
    if (!artifact || artifact.info.projectId !== session.projectId || !PREVIEWABLE_MIME.has(artifact.info.mimeType)) {
      this.sessions.delete(token);
      return null;
    }
    return {
      logicalName: artifact.info.logicalName,
      html: artifact.info.mimeType === 'text/html' ? artifact.content : renderTextPreview(artifact.info.logicalName, artifact.content.toString('utf8')),
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  close(token: string): void {
    this.sessions.delete(token);
  }

  private pruneExpired(now = Date.now()): void {
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token);
  }
}

export const ARTIFACT_PREVIEW_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";

function renderTextPreview(name: string, content: string): Buffer {
  const safeName = escapeHtml(name);
  const safeContent = escapeHtml(content);
  return Buffer.from(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeName}</title><style>body{margin:0;padding:24px;background:#171a22;color:#e4e8ed;font:14px/1.55 "Segoe UI",sans-serif}header{margin-bottom:14px;color:#9edfc2;font-size:13px}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 Consolas,monospace}</style><header>${safeName}</header><pre>${safeContent}</pre></html>`, 'utf8');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
