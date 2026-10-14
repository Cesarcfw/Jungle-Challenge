import { DomainError } from './domain-error';
import type { IntegrationEvent } from './integration-event';

interface OutboxState {
  id: string; aggregateId: string; eventType: string; payload: Readonly<Record<string, unknown>>;
  occurredAt: Date; attempts: number; nextAttemptAt?: Date; publishedAt?: Date;
}
export class OutboxMessage {
  private constructor(private readonly state: OutboxState) {
    this.state = { ...state, payload: Object.freeze(JSON.parse(JSON.stringify(state.payload)) as Record<string, unknown>),
      occurredAt: new Date(state.occurredAt), ...(state.nextAttemptAt ? { nextAttemptAt: new Date(state.nextAttemptAt) } : {}),
      ...(state.publishedAt ? { publishedAt: new Date(state.publishedAt) } : {}) };
  }
  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    const envelope = event.toJSON();
    return new OutboxMessage({ id: envelope.eventId, aggregateId: envelope.aggregateId, eventType: envelope.eventType,
      payload: envelope, occurredAt: new Date(envelope.occurredAt), attempts: 0 });
  }
  static rehydrate(state: OutboxState): OutboxMessage { return new OutboxMessage(state); }
  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get eventType(): string { return this.state.eventType; }
  get payload(): Readonly<Record<string, unknown>> { return JSON.parse(JSON.stringify(this.state.payload)) as Record<string, unknown>; }
  get occurredAt(): Date { return new Date(this.state.occurredAt); }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date | undefined { return this.state.nextAttemptAt ? new Date(this.state.nextAttemptAt) : undefined; }
  get publishedAt(): Date | undefined { return this.state.publishedAt ? new Date(this.state.publishedAt) : undefined; }
  isPending(): boolean { return this.state.publishedAt === undefined; }
  isDue(now: Date): boolean { return this.isPending() && (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now); }
  markPublished(at: Date): void {
    if (!this.isPending()) throw new DomainError('OUTBOX_ALREADY_PUBLISHED', 'Outbox message is already published.');
    this.state.publishedAt = new Date(at);
    delete this.state.nextAttemptAt;
  }
  scheduleRetry(now: Date): void {
    if (!this.isPending()) throw new DomainError('OUTBOX_ALREADY_PUBLISHED', 'Published messages cannot retry.');
    this.state.attempts++;
    this.state.nextAttemptAt = new Date(now.getTime() + Math.min(60_000, 1000 * 2 ** Math.min(this.state.attempts, 6)));
  }
}
