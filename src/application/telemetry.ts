export interface AuditContext {
  correlationId?: string; messageId?: string; transactionId?: string; walletId?: string; providerId?: string;
}
export interface Telemetry {
  log(level: 'info' | 'warn' | 'error', code: string, context?: AuditContext, extra?: Record<string, string | number | boolean | null>): void;
  wager(kind: string, status: string, replay: boolean, seconds: number): void;
  failure(code: string): void;
  retry(component: 'sqs' | 'outbox' | 'reference'): void;
  duplicate(source: 'http' | 'sqs' | 'conflict'): void;
  dlq(): void;
  reconciliation(consistent: boolean): void;
}
export const silentTelemetry: Telemetry = {
  log() {}, wager() {}, failure() {}, retry() {}, duplicate() {}, dlq() {}, reconciliation() {},
};
