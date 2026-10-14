import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../../domain/outbox-message';
import { silentTelemetry, type Telemetry } from '../../application/telemetry';

export class OutboxPublisher {
  constructor(private readonly orm: MikroORM, private readonly client: SQSClient, private readonly queueUrl: string,
    private readonly options: { aggregateId?: string; afterSend?: () => Promise<void>; telemetry?: Telemetry } = {}) {}
  async publishBatch(limit = 10): Promise<number> {
    let sent = 0;
    for (let i = 0; i < limit; i++) {
      const published = await this.orm.em.fork().transactional(async em => {
        const rows = await em.execute<Array<{ id: string; aggregate_id: string; event_type: string; payload: Record<string, unknown>; attempts: number; occurred_at: string }>>(`
          SELECT id,aggregate_id,event_type,payload,attempts,occurred_at FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at<=now())
          ${this.options.aggregateId ? 'AND aggregate_id=?' : ''} ORDER BY occurred_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, this.options.aggregateId ? [this.options.aggregateId] : []);
        const row = rows[0]; if (!row) return false;
        const message = OutboxMessage.rehydrate({ id: row.id, aggregateId: row.aggregate_id, eventType: row.event_type,
          payload: row.payload, attempts: row.attempts, occurredAt: new Date(row.occurred_at) });
        try {
          await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(row.payload), MessageGroupId: row.aggregate_id, MessageDeduplicationId: row.id }));
        } catch (error) {
          message.scheduleRetry(new Date());
          await em.execute('UPDATE outbox_messages SET attempts=?,next_attempt_at=? WHERE id=?', [message.attempts, message.nextAttemptAt, row.id]);
          const telemetry = this.options.telemetry ?? silentTelemetry;
          telemetry.retry('outbox');
          const data = row.payload.data as Record<string, unknown> | undefined;
          telemetry.log('warn', 'OUTBOX_RETRY', { walletId: row.aggregate_id,
            ...(typeof row.payload.correlationId === 'string' ? { correlationId: row.payload.correlationId } : {}),
            ...(typeof data?.transactionId === 'string' ? { transactionId: data.transactionId } : {}),
            ...(typeof data?.providerId === 'string' ? { providerId: data.providerId } : {}) }, { eventId: row.id, errorType: error instanceof Error ? error.name : 'Unknown' });
          return false;
        }
        await this.options.afterSend?.();
        message.markPublished(new Date());
        await em.execute('UPDATE outbox_messages SET published_at=?,next_attempt_at=NULL WHERE id=?', [message.publishedAt, row.id]);
        return true;
      });
      if (!published) break;
      sent++;
    }
    return sent;
  }
}
