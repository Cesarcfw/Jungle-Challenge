import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { MikroORM } from '@mikro-orm/postgresql';
import type { AuditContext, Telemetry } from '../../application/telemetry';

export class Metrics implements Telemetry {
  readonly registry = new Registry();
  private readonly outcomes = new Counter({ name: 'wager_processing_outcomes_total', help: 'Committed processing outcomes, excluding replay.', labelNames: ['kind','status'], registers: [this.registry] });
  private readonly duplicates = new Counter({ name: 'wager_duplicates_total', help: 'Duplicate deliveries and identity conflicts detected.', labelNames: ['source'], registers: [this.registry] });
  private readonly retries = new Counter({ name: 'wager_retries_total', help: 'Scheduled retries by component.', labelNames: ['component'], registers: [this.registry] });
  private readonly dlqMessages = new Counter({ name: 'wager_dlq_sent_total', help: 'Messages explicitly sent to DLQ by this process.', registers: [this.registry] });
  private readonly lockConflicts = new Counter({ name: 'wager_lock_conflicts_total', help: 'Lock timeout, deadlock or serialization conflicts.', registers: [this.registry] });
  private readonly processing = new Histogram({ name: 'wager_processing_seconds', help: 'Financial processing latency including replay and lock wait.', labelNames: ['kind'], buckets: [0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2,5,10], registers: [this.registry] });
  private readonly http = new Histogram({ name: 'http_request_seconds', help: 'HTTP request latency.', labelNames: ['method','route','status'], buckets: [0.005,0.025,0.1,0.5,1,5,10], registers: [this.registry] });
  private readonly reconciliations = new Counter({ name: 'wallet_reconciliations_total', help: 'Reconciliation reports by consistency.', labelNames: ['consistent'], registers: [this.registry] });
  private readonly divergences = new Counter({ name: 'wallet_reconciliation_divergences_total', help: 'Detected balance/ledger divergences; no automatic repair.', registers: [this.registry] });
  private readonly persisted = new Gauge({ name: 'wager_transactions_persisted', help: 'Global database transaction count by current status; do not sum across app replicas.', labelNames: ['status'], registers: [this.registry] });
  private readonly outboxLag = new Gauge({ name: 'outbox_lag_seconds', help: 'Age of oldest unpublished event in the shared database.', registers: [this.registry] });
  private readonly outboxPending = new Gauge({ name: 'outbox_pending_messages', help: 'Unpublished events in shared database.', registers: [this.registry] });
  private readonly outboxRetries = new Gauge({ name: 'outbox_retry_attempts_persisted', help: 'Retry attempts stored in shared database.', registers: [this.registry] });
  private readonly dlqDepth = new Gauge({ name: 'sqs_dlq_messages', help: 'Approximate visible and inflight DLQ depth; do not sum across replicas.', registers: [this.registry] });
  private queueCollector: (() => Promise<number | null>) | undefined;
  constructor(private readonly orm: MikroORM, private readonly sink: (entry: Record<string, unknown>) => void = entry => console.log(JSON.stringify(entry))) {}
  setQueueCollector(collector: () => Promise<number | null>): void { this.queueCollector = collector; }
  log(level: 'info' | 'warn' | 'error', code: string, context: AuditContext = {}, extra: Record<string, string | number | boolean | null> = {}): void {
    const fields: Record<string, unknown> = {};
    for (const key of ['correlationId','messageId','transactionId','walletId','providerId'] as const) fields[key] = typeof context[key] === 'string' ? context[key].slice(0, 256) : null;
    const allowed = ['kind','status','idempotentReplay','consistent','checkedEntries','method','route','httpStatus','durationMs','errorType','attempts','disposition','eventId'];
    for (const [key, value] of Object.entries(extra)) if (allowed.includes(key)) fields[key] = value;
    try { this.sink({ timestamp: new Date().toISOString(), level, code, ...fields }); }
    catch { /* A diagnostic sink failure must not change a committed financial result. */ }
  }
  wager(kind: string, status: string, replay: boolean, seconds: number): void {
    if (!replay) this.outcomes.inc({ kind, status });
    this.processing.observe({ kind }, seconds);
  }
  failure(code: string): void { if (['55P03','40P01','40001'].includes(code)) this.lockConflicts.inc(); }
  retry(component: 'sqs' | 'outbox' | 'reference'): void { this.retries.inc({ component }); }
  duplicate(source: 'http' | 'sqs' | 'conflict'): void { this.duplicates.inc({ source }); }
  dlq(): void { this.dlqMessages.inc(); }
  reconciliation(consistent: boolean): void { this.reconciliations.inc({ consistent: String(consistent) }); if (!consistent) this.divergences.inc(); }
  request(method: string, route: string, status: number, seconds: number): void { this.http.observe({ method, route, status: String(status) }, seconds); }
  async render(): Promise<string> {
    const em = this.orm.em.fork();
    const [statuses, outbox] = await Promise.all([
      em.execute<Array<{ status: string; count: string }>>('SELECT status,count(*)::text AS count FROM wager_transactions GROUP BY status'),
      em.execute<Array<{ pending: string; lag: string; retries: string }>>(`SELECT count(*) FILTER(WHERE published_at IS NULL)::text AS pending,
        GREATEST(0,COALESCE(EXTRACT(EPOCH FROM now()-MIN(occurred_at) FILTER(WHERE published_at IS NULL)),0))::text AS lag,
        COALESCE(sum(attempts),0)::text AS retries FROM outbox_messages`),
    ]);
    for (const status of ['PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED']) this.persisted.set({ status }, 0);
    for (const row of statuses) this.persisted.set({ status: row.status }, Number(row.count));
    this.outboxPending.set(Number(outbox[0]?.pending ?? '0')); this.outboxLag.set(Number(outbox[0]?.lag ?? '0')); this.outboxRetries.set(Number(outbox[0]?.retries ?? '0'));
    this.dlqDepth.reset();
    if (this.queueCollector) {
      try { const depth = await this.queueCollector(); if (depth !== null) this.dlqDepth.set(depth); }
      catch { this.log('warn', 'METRICS_SQS_UNAVAILABLE'); }
    }
    return this.registry.metrics();
  }
}
