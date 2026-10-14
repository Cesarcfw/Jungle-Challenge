import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { WageringService } from '../../application/wagering-service';
import { initializeQueues, sqsClient, type QueueUrls } from './sqs';
import { WagerConsumer } from './wager-consumer';
import { OutboxPublisher } from './outbox-publisher';
import { silentTelemetry, type Telemetry } from '../../application/telemetry';
import type { Metrics } from '../observability/metrics';

export class MessagingRuntime {
  private readonly client = sqsClient();
  private queues: QueueUrls | undefined;
  private consumer: WagerConsumer | undefined;
  private publisher: OutboxPublisher | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private lastProvisionedAt = 0;
  constructor(private readonly orm: MikroORM, private readonly service: WageringService, private readonly enabled: boolean, private readonly telemetry: Telemetry = silentTelemetry) {
    if ('setQueueCollector' in telemetry) (telemetry as Metrics).setQueueCollector(async () => {
      if (!this.enabled || !this.queues) return null;
      const response = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queues.dlq, AttributeNames: ['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible'] }));
      return Number(response.Attributes?.ApproximateNumberOfMessages ?? '0') + Number(response.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
    });
  }
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }
  private tick(): void {
    if (this.running || this.stopping) return;
    this.running = this.work().catch(error => {
      this.telemetry.retry('outbox');
      this.telemetry.log('warn', 'MESSAGING_WORKER_RETRY', {}, { errorType: error instanceof Error ? error.name : 'Unknown' });
    }).finally(() => { this.running = undefined; });
  }
  private async work(): Promise<void> {
    // Periodic idempotent provisioning also recovers queues after an emulator restart.
    if (!this.queues || Date.now() - this.lastProvisionedAt >= 30_000) {
      this.queues = await initializeQueues(this.client);
      this.lastProvisionedAt = Date.now();
      if (!this.consumer) {
        this.consumer = new WagerConsumer(this.orm, this.service, this.client, this.queues, { telemetry: this.telemetry });
        this.publisher = new OutboxPublisher(this.orm, this.client, this.queues.events, { telemetry: this.telemetry });
        if (!this.stopping) this.consumer.start();
      }
    }
    await this.publisher!.publishBatch();
  }
  async checkReady(): Promise<void> {
    await this.orm.em.fork().execute('SELECT 1');
    if (!this.enabled) throw new Error('SQS is disabled for this application instance.');
    if (!this.queues) throw new Error('SQS queues are not initialized.');
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queues.requests, AttributeNames: ['QueueArn'] }));
  }
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    await this.consumer?.stop();
    this.client.destroy();
  }
}
