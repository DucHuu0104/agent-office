import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { rejectMutatingApiRequestDuringShutdown, SERVER_SHUTTING_DOWN_MESSAGE } from './shutdown';

function responseCapture() {
  const headers = new Map<string, string>();
  let body = '';
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); return this; },
    end(value?: string) { body = value ?? ''; return this; },
  } as unknown as ServerResponse;
  return { response, headers, body: () => body };
}

describe('HTTP shutdown admission', () => {
  it('rejects new API mutations with a retryable response after shutdown starts', () => {
    const { response, headers, body } = responseCapture();
    const request = { method: 'POST', url: '/platform/v1/projects' } as IncomingMessage;

    expect(rejectMutatingApiRequestDuringShutdown(request, response, true)).toBe(true);
    expect(response.statusCode).toBe(503);
    expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(headers.get('retry-after')).toBe('1');
    expect(JSON.parse(body())).toEqual({ error: { code: 'SERVER_SHUTTING_DOWN', message: SERVER_SHUTTING_DOWN_MESSAGE } });
  });

  it.each([
    ['GET', '/platform/v1/office', true],
    ['HEAD', '/platform/v1/health', true],
    ['POST', '/platform/v1/projects', false],
    ['POST', '/office', true],
  ])('does not reject %s %s while shutdown is %s', (method, url, shuttingDown) => {
    const { response, body } = responseCapture();
    const request = { method, url } as IncomingMessage;

    expect(rejectMutatingApiRequestDuringShutdown(request, response, shuttingDown)).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(body()).toBe('');
  });
});
