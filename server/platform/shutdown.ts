import type { IncomingMessage, ServerResponse } from 'node:http';

export const SERVER_SHUTTING_DOWN_MESSAGE = 'O Agent Office está encerrando. Aguarde um momento e tente novamente.';

export function rejectMutatingApiRequestDuringShutdown(req: IncomingMessage, res: ServerResponse, shuttingDown: boolean): boolean {
  if (!shuttingDown || !req.url?.startsWith('/platform/v1/') || ['GET', 'HEAD'].includes(req.method ?? 'GET')) return false;
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Retry-After', '1');
  res.end(JSON.stringify({ error: { code: 'SERVER_SHUTTING_DOWN', message: SERVER_SHUTTING_DOWN_MESSAGE } }));
  return true;
}
