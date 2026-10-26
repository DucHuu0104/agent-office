import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { loadAppConfig } from './config';
import { DatabaseClient } from './database';
import { EventHub } from './events';
import { ProjectService } from './projects';
import { AgentRuntime } from './runtime';
import { loadRegistry } from './registry';
import { ArtifactService } from './artifacts';
import { MemoryService } from './memory';
import { RetentionService } from './retention';
import { createPlatformHandler } from './http';
import { acquireInstanceLock } from './instance-lock';
import { checkExecutionFromConfig } from './executor';
import { WorkspacePreviewManager } from './workspace-previews';
import { rejectMutatingApiRequestDuringShutdown } from './shutdown';

const rootDir = process.cwd();
const development = process.argv.includes('--dev');
const config = loadAppConfig();
const instanceLock = acquireInstanceLock(config.dataDir);
const registry = await loadRegistry(config.configDir);
const db = await DatabaseClient.open(config.dataDir, development);
const events = new EventHub(db);
const projects = new ProjectService(db, events, registry);
const artifacts = new ArtifactService(db, events, config.dataDir);
const memory = new MemoryService(db, events);
const retention = new RetentionService(db);
const previewExecution = config.executionMode === 'disabled' ? null : checkExecutionFromConfig(config);
const workspacePreviews = new WorkspacePreviewManager({ dataDir: config.dataDir, execution: previewExecution });
await workspacePreviews.initialize();
await projects.seedRegistry();
const recoverArtifactWrites = async () => {
  const recovered = await artifacts.recoverOrphans();
  if (recovered) console.info(`[office artifacts] reconciled ${recovered} interrupted artifact write journal(s)`);
};
await recoverArtifactWrites().catch((error: unknown) => console.error('[office artifacts] recovery failed:', error instanceof Error ? error.name : 'unknown error'));
let artifactRecoveryRun: Promise<void> = Promise.resolve();
const artifactRecoveryTimer = setInterval(() => {
  artifactRecoveryRun = artifactRecoveryRun.then(recoverArtifactWrites)
    .catch((error: unknown) => console.error('[office artifacts] recovery failed:', error instanceof Error ? error.name : 'unknown error'));
}, 60 * 60 * 1000);
artifactRecoveryTimer.unref();
const runtime = new AgentRuntime(db, events, projects, registry, artifacts, config);
await runtime.recover();
const pruneExpiredContent = async () => {
  const result = await retention.prune();
  const removed = result.receiptsScrubbed + result.approvalArgumentsScrubbed + result.checkpointsDeleted + result.eventsDeleted + result.hookDeliveriesDeleted;
  if (removed) console.info(`[office retention] scrubbed ${result.receiptsScrubbed} receipts and ${result.approvalArgumentsScrubbed} approval payloads, deleted ${result.checkpointsDeleted} checkpoints, ${result.eventsDeleted} old events and ${result.hookDeliveriesDeleted} hook delivery records`);
};
await pruneExpiredContent().catch((error: unknown) => console.error('[office retention] cleanup failed:', error instanceof Error ? error.name : 'unknown error'));
const retentionTimer = setInterval(() => {
  void pruneExpiredContent().catch((error: unknown) => console.error('[office retention] cleanup failed:', error instanceof Error ? error.name : 'unknown error'));
}, 24 * 60 * 60 * 1000);
retentionTimer.unref();
const api = createPlatformHandler({ config, db, events, projects, runtime, artifacts, memory, registry, registryRoot: config.configDir, workspacePreviews });
let shuttingDown = false;
const activeRequests = new Set<Promise<void>>();
const server = createServer((req, res) => {
  const request = handle(req, res).catch((error: unknown) => {
    console.error('[office] request failed:', error instanceof Error ? error.message : 'unknown');
    if (!res.headersSent) { res.statusCode = 500; res.end('Internal Server Error'); }
    else res.destroy();
  });
  activeRequests.add(request);
  void request.then(() => activeRequests.delete(request), () => activeRequests.delete(request));
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

let vite: { middlewares: (req: IncomingMessage, res: ServerResponse, next: (error?: Error) => void) => void; close: () => Promise<void> } | undefined;
if (development) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    configFile: join(rootDir, 'vite.config.ts'),
    appType: 'mpa',
    server: { middlewareMode: true, ws: { server } },
  });
}

server.listen(config.port, config.host, () => {
  console.info(`[office] listening at http://${config.host}:${config.port}/office`);
  console.info(`[office] storage ready; model ${config.model.configured ? 'configured' : 'not configured'}`);
});

let stopping: Promise<void> | null = null;
const stop = (signal: string) => {
  if (stopping) return;
  shuttingDown = true;
  const serverClosed = server.listening
    ? new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
    : Promise.resolve();
  stopping = (async () => {
    console.info(`[office] stopping (${signal})`);
    try {
      await runtime.stop();
    } finally {
      try {
        await workspacePreviews.closeAll();
      } finally {
        clearInterval(retentionTimer);
        clearInterval(artifactRecoveryTimer);
        await artifactRecoveryRun;
        server.closeAllConnections();
        await Promise.allSettled([...activeRequests]);
        try {
          await serverClosed;
          await vite?.close();
        } finally {
          try { await db.close(); }
          finally { instanceLock.release(); }
        }
      }
    }
  })().catch((error: unknown) => {
    console.error('[office] shutdown failed:', error instanceof Error ? error.message : 'unknown');
    process.exitCode = 1;
  });
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setSecurityHeaders(req, res, development);
  let path = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`).pathname;
  if (path.startsWith('/platform/v1/')) {
    if (rejectMutatingApiRequestDuringShutdown(req, res, shuttingDown)) return;
    return api(req, res);
  }
  if (path === '/') {
    res.statusCode = 302;
    res.setHeader('Location', '/office');
    res.end();
    return;
  }
  if (path === '/office') {
    req.url = `/office.html${new URL(req.url ?? '/', `http://${req.headers.host}`).search}`;
    path = '/office.html';
  }
  if (development && vite) {
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        res.off('finish', finish);
        res.off('close', finish);
        resolvePromise();
      };
      res.once('finish', finish);
      res.once('close', finish);
      vite!.middlewares(req, res, () => {
        finish();
        if (!res.writableEnded && !res.headersSent) { res.statusCode = 404; res.end('Not found'); }
      });
    });
    return;
  }
  await serveStatic(req, res, path);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (pathname !== '/office.html' && !pathname.startsWith('/bundle/') && !pathname.startsWith('/assets/')) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { res.statusCode = 400; res.end('Bad path'); return; }
  const clientRoot = resolve(rootDir, 'dist/client');
  const file = resolve(clientRoot, `.${decoded}`);
  if (file !== clientRoot && !file.startsWith(`${clientRoot}${sep}`)) { res.statusCode = 403; res.end('Forbidden'); return; }
  const permittedAssetRoot = pathname.startsWith('/bundle/')
    ? resolve(clientRoot, 'bundle')
    : pathname.startsWith('/assets/') ? resolve(clientRoot, 'assets') : null;
  if (pathname === '/office.html' ? file !== resolve(clientRoot, 'office.html') : !permittedAssetRoot || !file.startsWith(`${permittedAssetRoot}${sep}`)) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  try {
    const content = await readFile(file);
    res.statusCode = 200;
    res.setHeader('Content-Type', contentType(extname(file)));
    res.setHeader('Content-Length', content.byteLength);
    res.setHeader('Cache-Control', pathname === '/office.html' ? 'no-store' : pathname.startsWith('/bundle/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

function contentType(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function setSecurityHeaders(req: IncomingMessage, res: ServerResponse, dev: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${dev ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'${dev ? ' ws: http:' : ''}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`);
}
