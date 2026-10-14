import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand, SendMessageCommand, type Message } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { WageringService } from '../../application/wagering-service';
import { betInput, object, text } from '../../application/contracts';
import type { BetInput } from '../../application/contracts';
import { payloadHash } from '../../application/payload-hash';
import { DomainError } from '../../domain/domain-error';
import type { QueueUrls } from './sqs';
import { infrastructureCode } from '../infrastructure-error';
import { silentTelemetry, type Telemetry } from '../../application/telemetry';

export class WagerConsumer {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private abort: AbortController | undefined;
  constructor(private readonly orm: MikroORM, private readonly service: WageringService,
    private readonly client: SQSClient, private readonly queues: QueueUrls,
    private readonly options: { maxAttempts?: number; afterCommit?: () => Promise<void>; visibilitySeconds?: number; telemetry?: Telemetry } = {}) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }
  private async run(): Promise<void> {
    while (!this.stopping) {
      try { await this.pollOnce(1); }
      catch (error) {
        if (this.stopping) break;
        const telemetry = this.options.telemetry ?? silentTelemetry;
        telemetry.retry('sqs'); telemetry.log('warn', 'SQS_POLL_RETRY', {}, { errorType: error instanceof Error ? error.name : 'Unknown' });
        await Bun.sleep(500);
      }
    }
  }
  async stop(): Promise<void> { this.stopping = true; this.abort?.abort(); await this.loop; this.loop = undefined; }
  async pollOnce(waitSeconds = 0): Promise<number> {
    this.abort = new AbortController();
    const response = await this.client.send(new ReceiveMessageCommand({ QueueUrl: this.queues.requests, MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds, VisibilityTimeout: this.options.visibilitySeconds ?? 30, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }), { abortSignal: this.abort.signal });
    this.abort = undefined;
    // A failed acknowledgment must not detach the other handlers from shutdown.
    const results = await Promise.allSettled((response.Messages ?? []).map(message => this.handle(message)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return response.Messages?.length ?? 0;
  }
  async handle(message: Message): Promise<void> {
    if (!message.ReceiptHandle || !message.Body) return;
    const receipt = message.ReceiptHandle;
    const brokerId = message.MessageId ?? 'unknown';
    const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const heartbeat = setInterval(() => {
      void this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.requests, ReceiptHandle: receipt, VisibilityTimeout: 30 })).catch(() => {});
    }, 10_000);
    heartbeat.unref();
    let messageId = brokerId;
    let financialCommitted = false;
    let validInput: BetInput | undefined;
    let validKey: string | undefined;
    try {
      let envelope: Record<string, unknown>;
      try { envelope = object(JSON.parse(message.Body)); }
      catch { throw new DomainError('INVALID_MESSAGE', 'Malformed JSON message.'); }
      messageId = text(envelope.messageId, 'messageId');
      if (envelope.type !== 'WagerTransactionRequested') throw new DomainError('INVALID_MESSAGE_TYPE', 'Unsupported message type.');
      if (typeof envelope.occurredAt !== 'string' || !Number.isFinite(Date.parse(envelope.occurredAt))) throw new DomainError('INVALID_MESSAGE_DATE', 'Invalid occurredAt.');
      const data = object(envelope.data);
      const { idempotencyKey, ...business } = data;
      const input = betInput(business);
      const key = text(idempotencyKey, 'idempotencyKey');
      validInput = input; validKey = key;
      const result = await this.service.bet(input, key, messageId, undefined, { consumerName: 'wager-transactions', messageId, payloadHash: payloadHash({ ...input, idempotencyKey: key }) });
      financialCommitted = true;
      (this.options.telemetry ?? silentTelemetry).log('info', 'SQS_TRANSACTION_COMMITTED', { correlationId: messageId, messageId, transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId }, { status: result.status, idempotentReplay: result.idempotentReplay });
      await this.options.afterCommit?.();
      // Acknowledgment is strictly after the financial transaction resolves.
      await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queues.requests, ReceiptHandle: receipt }));
    } catch (error) {
      if (financialCommitted) {
        // Never quarantine or mutate committed work because acknowledgment failed.
        await this.retryVisibility(receipt, attempts);
        return;
      }
      const code = error instanceof DomainError ? error.code : infrastructureCode(error);
      const telemetry = this.options.telemetry ?? silentTelemetry;
      const business = error instanceof DomainError && ['IDEMPOTENCY_CONFLICT','INBOX_PAYLOAD_CONFLICT','WALLET_NOT_FOUND'].includes(code);
      const permanent = error instanceof DomainError || code === 'PERMANENT_INFRASTRUCTURE_ERROR';
      if (business || permanent || attempts >= (this.options.maxAttempts ?? 5)) {
        const failureCode = attempts >= (this.options.maxAttempts ?? 5) && !permanent ? 'RETRY_EXHAUSTED' : code;
        if (!business && !(error instanceof DomainError) && validInput && validKey) {
          // If persistence is unavailable, leave the message unacked for broker redrive.
          await this.service.failSubmission(validInput, validKey, messageId, failureCode,
            { consumerName: 'wager-transactions', messageId, payloadHash: payloadHash({ ...validInput, idempotencyKey: validKey }) });
        }
        if (!business) {
          await this.client.send(new SendMessageCommand({ QueueUrl: this.queues.dlq, MessageBody: message.Body, MessageGroupId: 'quarantine', MessageDeduplicationId: payloadHash({ brokerId, body: message.Body }) }));
          telemetry.dlq();
        }
        await this.orm.em.fork().execute(`INSERT INTO message_failures(consumer_name,message_id,payload_hash,failure_code,disposition,occurred_at) VALUES('wager-transactions',?,?,?,?,now()) ON CONFLICT DO NOTHING`,
          [messageId, payloadHash(message.Body), failureCode, business ? 'ACK' : 'DLQ']);
        await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queues.requests, ReceiptHandle: receipt }));
      } else await this.retryVisibility(receipt, attempts);
      telemetry.log('warn', code, { correlationId: messageId, messageId, ...(validInput ? { walletId: validInput.walletId, providerId: validInput.providerId } : {}) },
        { attempts, disposition: business ? 'ACK' : permanent || attempts >= (this.options.maxAttempts ?? 5) ? 'DLQ' : 'RETRY' });
    } finally { clearInterval(heartbeat); }
  }
  private async retryVisibility(receipt: string, attempts: number): Promise<void> {
    (this.options.telemetry ?? silentTelemetry).retry('sqs');
    await this.client.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.requests, ReceiptHandle: receipt, VisibilityTimeout: Math.min(60, 2 ** Math.min(attempts, 6)) }));
  }
}
