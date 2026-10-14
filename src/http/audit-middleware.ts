import { randomUUID } from 'node:crypto';
import type { Metrics } from '../infrastructure/observability/metrics';
import type { AuditContext } from '../application/telemetry';

export interface AuditRequest {
  method: string; originalUrl: string; body?: unknown; params?: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}
interface AuditResponse {
  statusCode: number; setHeader(name: string, value: string): void;
  json(body: unknown): unknown; on(name: string, callback: () => void): void;
}
export function routeTemplate(path: string): string {
  const url = path.split('?')[0] ?? '';
  if (url === '/wallets') return '/wallets';
  if (/^\/wallets\/[^/]+\/ledger$/.test(url)) return '/wallets/:walletId/ledger';
  if (/^\/wallets\/[^/]+\/reconciliation$/.test(url)) return '/wallets/:walletId/reconciliation';
  if (/^\/wallets\/[^/]+$/.test(url)) return '/wallets/:walletId';
  if (url === '/wagering/transactions') return url;
  if (/^\/wagering\/transactions\/[^/]+$/.test(url)) return '/wagering/transactions/:transactionId';
  if (/^\/providers\/[^/]+\/wagering\/transactions\/[^/]+$/.test(url)) return '/providers/:providerId/wagering/transactions/:externalTransactionId';
  if (['/health/live','/health/ready','/metrics'].includes(url)) return url;
  return 'unmatched';
}
function fields(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function id(value: unknown): string | undefined { return typeof value === 'string' && value.length <= 256 ? value : undefined; }
export function auditMiddleware(metrics: Metrics) {
  return (request: AuditRequest, response: AuditResponse, next: () => void) => {
    const started = performance.now();
    const incoming = request.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(incoming) ? incoming : randomUUID();
    request.headers['x-correlation-id'] = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    let result: Record<string, unknown> = {};
    const originalJson = response.json.bind(response);
    response.json = body => { result = fields(body); return originalJson(body); };
    response.on('finish', () => {
      const body = fields(request.body);
      const route = routeTemplate(request.originalUrl);
      const context: AuditContext = { correlationId };
      const transactionId = id(result.transactionId) ?? id(request.params?.transactionId);
      const walletId = id(body.walletId) ?? id(request.params?.walletId) ?? id(result.walletId) ?? (route === '/wallets' ? id(result.id) : undefined);
      const providerId = id(body.providerId) ?? id(request.params?.providerId);
      if (transactionId) context.transactionId = transactionId;
      if (walletId) context.walletId = walletId;
      if (providerId) context.providerId = providerId;
      const seconds = (performance.now() - started) / 1000;
      metrics.request(request.method, route, response.statusCode, seconds);
      metrics.log(response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info', 'HTTP_REQUEST', context,
        { method: request.method, route, httpStatus: response.statusCode, durationMs: Math.round(seconds * 1000) });
    });
    next();
  };
}
