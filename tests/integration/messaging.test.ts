import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand, ReceiveMessageCommand, ChangeMessageVisibilityCommand, DeleteMessageCommand, DeleteQueueCommand, type Message } from '@aws-sdk/client-sqs';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { WageringService } from '../../src/application/wagering-service';
import { PostgresFinancialStore } from '../../src/infrastructure/database/postgres-financial-store';
import { initializeQueues, sqsClient, type QueueUrls } from '../../src/infrastructure/messaging/sqs';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { payloadHash } from '../../src/application/payload-hash';
import { Metrics } from '../../src/infrastructure/observability/metrics';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required.');
const client = sqsClient();
let orm: MikroORM;
let service: WageringService;
const createdQueues: QueueUrls[] = [];
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url)); await orm.getMigrator().up();
  service = new WageringService(new PostgresFinancialStore(orm));
});
afterAll(async () => {
  for (const queues of createdQueues) for (const QueueUrl of Object.values(queues)) await client.send(new DeleteQueueCommand({ QueueUrl }));
  client.destroy(); if (orm) await orm.close(true);
});
async function setup() {
  const queues = await initializeQueues(client, `test-${randomUUID()}`); createdQueues.push(queues); return queues;
}
async function open() { return service.createWallet(randomUUID(), { amount: '100.00', currency: 'BRL' }, randomUUID()); }
function envelope(wallet: { id: string; playerId: string }, amount = '25.00') {
  const externalTransactionId = randomUUID();
  return { messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: {
    providerId: 'sqs-test', externalTransactionId, idempotencyKey: `sqs-test:${externalTransactionId}`, playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round', gameId: 'game', kind: 'BET' as const, money: { amount, currency: 'BRL' },
  } };
}
async function send(queues: QueueUrls, body: unknown, group: string = randomUUID()) {
  await client.send(new SendMessageCommand({ QueueUrl: queues.requests, MessageBody: typeof body === 'string' ? body : JSON.stringify(body), MessageGroupId: group, MessageDeduplicationId: randomUUID() }));
}
async function receive(queue: string, visibility = 30): Promise<Message> {
  const response = await client.send(new ReceiveMessageCommand({ QueueUrl: queue, MaxNumberOfMessages: 1, WaitTimeSeconds: 1, VisibilityTimeout: visibility, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
  if (!response.Messages?.[0]) throw new Error('Expected an SQS message.');
  return response.Messages[0];
}
async function invariant(walletId: string) {
  const rows = await orm.em.fork().execute<Array<{ balance: string; calculated: string; debits: string }>>(`
    SELECT w.balance::text AS balance,COALESCE(sum(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated,
      count(l.id) FILTER(WHERE l.direction='DEBIT')::text AS debits FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [walletId]);
  expect(rows[0]?.balance).toBe(rows[0]?.calculated); return rows[0]!;
}

test('SQS duplicates are deduplicated by persistent inbox with one debit and two financial events', async () => {
  const queues = await setup(); const wallet = await open(); const body = envelope(wallet);
  await send(queues, body, wallet.id); await send(queues, body, wallet.id);
  const consumer = new WagerConsumer(orm, service, client, queues);
  for (let i = 0; i < 3; i++) await consumer.pollOnce();
  const state = await invariant(wallet.id); expect(state.balance).toBe('75.00'); expect(state.debits).toBe('1');
  const inbox = await orm.em.fork().execute<Array<{ processed_at: string | null }>>('SELECT processed_at FROM inbox_messages WHERE message_id=?', [body.messageId]);
  expect(inbox).toHaveLength(1); expect(inbox[0]?.processed_at).not.toBeNull();
  const counts = await orm.em.fork().execute<Array<{ count: string }>>("SELECT count(*)::text AS count FROM outbox_messages WHERE payload->'data'->>'transactionId'=(SELECT id::text FROM wager_transactions WHERE idempotency_key=?)", [body.data.idempotencyKey]);
  expect(counts[0]?.count).toBe('2');
}, 15000);

test('same application messageId with divergent payload is audited and acknowledged without extra effect', async () => {
  const queues = await setup(); const wallet = await open(); const body = envelope(wallet);
  const consumer = new WagerConsumer(orm, service, client, queues);
  await send(queues, body); await consumer.pollOnce();
  await send(queues, { ...body, data: { ...body.data, money: { amount: '26.00', currency: 'BRL' } } }); await consumer.pollOnce();
  const failure = await orm.em.fork().execute<Array<{ failure_code: string; disposition: string }>>('SELECT failure_code,disposition FROM message_failures WHERE message_id=?', [body.messageId]);
  expect(failure[0]?.failure_code).toBe('INBOX_PAYLOAD_CONFLICT'); expect(failure[0]?.disposition).toBe('ACK');
  expect((await invariant(wallet.id)).balance).toBe('75.00');
}, 15000);

test('business rejection is committed to inbox and acked; malformed JSON goes to DLQ', async () => {
  const queues = await setup(); const wallet = await open(); const body = envelope(wallet, '999.00');
  const consumer = new WagerConsumer(orm, service, client, queues);
  await send(queues, body); await consumer.pollOnce();
  const result = await orm.em.fork().execute<Array<{ status: string }>>('SELECT status FROM wager_transactions WHERE idempotency_key=?', [body.data.idempotencyKey]);
  expect(result[0]?.status).toBe('REJECTED'); expect((await invariant(wallet.id)).balance).toBe('100.00');
  await send(queues, 'invalid-json'); await consumer.pollOnce();
  expect((await receive(queues.dlq)).Body).toBe('invalid-json');
}, 15000);

test('transient SQL failure retries, then reaches DLQ without partial inbox or financial effect', async () => {
  const queues = await setup(); const wallet = await open(); const body = envelope(wallet);
  const suffix = randomUUID().replaceAll('-', '');
  const sql = orm.em.fork();
  await sql.execute(`CREATE FUNCTION test_fault_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM wager_transactions WHERE id=NEW.transaction_id AND external_transaction_id='${body.data.externalTransactionId}') THEN RAISE EXCEPTION 'test serialization failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_fault_${suffix} BEFORE INSERT ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION test_fault_${suffix}();`);
  try {
    const metrics = new Metrics(orm, () => {});
    const measuredService = new WageringService(new PostgresFinancialStore(orm), metrics);
    const consumer = new WagerConsumer(orm, measuredService, client, queues, { maxAttempts: 2, telemetry: metrics });
    await send(queues, body);
    const first = await receive(queues.requests); await consumer.handle(first);
    expect(await sql.execute('SELECT message_id FROM inbox_messages WHERE message_id=?', [body.messageId])).toHaveLength(0);
    expect(await sql.execute('SELECT id FROM wager_transactions WHERE idempotency_key=?', [body.data.idempotencyKey])).toHaveLength(0);
    await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queues.requests, ReceiptHandle: first.ReceiptHandle!, VisibilityTimeout: 0 }));
    const second = await receive(queues.requests); expect(Number(second.Attributes?.ApproximateReceiveCount)).toBeGreaterThanOrEqual(2);
    await consumer.handle(second);
    expect((await receive(queues.dlq)).Body).toBe(JSON.stringify(body));
    const failure = await sql.execute<Array<{ failure_code: string }>>('SELECT failure_code FROM message_failures WHERE message_id=?', [body.messageId]);
    expect(failure[0]?.failure_code).toBe('RETRY_EXHAUSTED'); expect((await invariant(wallet.id)).balance).toBe('100.00');
    const failed = await sql.execute<Array<{ status: string; failure_code: string }>>('SELECT status,failure_code FROM wager_transactions WHERE idempotency_key=?', [body.data.idempotencyKey]);
    expect(failed[0]?.status).toBe('FAILED'); expect(failed[0]?.failure_code).toBe('RETRY_EXHAUSTED');
    expect(await sql.execute('SELECT message_id FROM inbox_messages WHERE message_id=? AND processed_at IS NOT NULL', [body.messageId])).toHaveLength(1);
    const rendered = await metrics.render();
    expect(rendered).toContain('wager_retries_total{component="sqs"} 1');
    expect(rendered).toContain('wager_lock_conflicts_total 2');
    expect(rendered).toContain('wager_dlq_sent_total 1');
    expect(rendered).toContain('wager_processing_outcomes_total{kind="BET",status="FAILED"} 1');
  } finally { await sql.execute(`DROP TRIGGER test_fault_${suffix} ON wallet_ledger; DROP FUNCTION test_fault_${suffix}();`); }
}, 15000);

test('two publishers claim the same outbox without losing or normally duplicating events', async () => {
  const queues = await setup(); const wallet = await open();
  const a = new OutboxPublisher(orm, client, queues.events, { aggregateId: wallet.id });
  const b = new OutboxPublisher(orm, client, queues.events, { aggregateId: wallet.id });
  const totals = await Promise.all([a.publishBatch(), b.publishBatch()]); expect(totals.reduce((sum, n) => sum + n, 0)).toBe(2);
  const received: string[] = [];
  for (let i = 0; i < 2; i++) {
    const message = await receive(queues.events); const event = JSON.parse(message.Body!) as { eventId: string };
    received.push(event.eventId);
    await client.send(new DeleteMessageCommand({ QueueUrl: queues.events, ReceiptHandle: message.ReceiptHandle! }));
  }
  expect(new Set(received).size).toBe(2);
  const rows = await orm.em.fork().execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id=? AND published_at IS NOT NULL', [wallet.id]);
  expect(rows[0]?.count).toBe('2'); await invariant(wallet.id);
}, 15000);

test('failed publication persists backoff and leaves confirmed events recoverable', async () => {
  const queues = await setup(); const wallet = await open();
  const broken = new OutboxPublisher(orm, client, `${queues.events}-missing`, { aggregateId: wallet.id });
  expect(await broken.publishBatch()).toBe(0);
  const rows = await orm.em.fork().execute<Array<{ attempts: number; next_attempt_at: string; published_at: string | null }>>('SELECT attempts,next_attempt_at,published_at FROM outbox_messages WHERE aggregate_id=? AND attempts>0', [wallet.id]);
  expect(rows[0]?.attempts).toBe(1); expect(rows[0]?.published_at).toBeNull(); expect(rows[0]?.next_attempt_at).not.toBeNull();
  await orm.em.fork().execute('UPDATE outbox_messages SET next_attempt_at=now() WHERE aggregate_id=?', [wallet.id]);
  expect(await new OutboxPublisher(orm, client, queues.events, { aggregateId: wallet.id }).publishBatch()).toBe(2); await invariant(wallet.id);
}, 15000);

test('worker process killed after commit and before ack redelivers without a second debit', async () => {
  const queues = await setup(); const wallet = await open(); const body = envelope(wallet); await send(queues, body);
  const child = Bun.spawn([process.execPath, 'tests/fixtures/consumer-crash.ts'], { env: { ...process.env, TEST_DATABASE_URL: url, TEST_QUEUE_URLS: JSON.stringify(queues) }, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(113);
  expect((await invariant(wallet.id)).balance).toBe('75.00');
  await Bun.sleep(1200);
  await new WagerConsumer(orm, service, client, queues).pollOnce(1);
  const state = await invariant(wallet.id); expect(state.balance).toBe('75.00'); expect(state.debits).toBe('1');
  const inbox = await orm.em.fork().execute('SELECT message_id FROM inbox_messages WHERE message_id=? AND processed_at IS NOT NULL', [body.messageId]);
  expect(inbox).toHaveLength(1);
}, 20000);

test('publisher killed after send resumes and duplicate event is safe for a durable consumer', async () => {
  const queues = await setup(); const wallet = await open();
  const child = Bun.spawn([process.execPath, 'tests/fixtures/publisher-crash.ts'], { env: { ...process.env, TEST_DATABASE_URL: url, TEST_EVENTS_URL: queues.events, TEST_AGGREGATE_ID: wallet.id }, stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(114);
  const unmarked = await orm.em.fork().execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id=? AND published_at IS NOT NULL', [wallet.id]);
  expect(unmarked[0]?.count).toBe('0');
  await new OutboxPublisher(orm, client, queues.events, { aggregateId: wallet.id }).publishBatch();
  const message = await receive(queues.events); const event = JSON.parse(message.Body!) as { eventId: string };
  const store = new PostgresFinancialStore(orm);
  for (let i = 0; i < 2; i++) await store.transaction(async session => {
    const context = { consumerName: 'test-event-consumer', messageId: event.eventId, payloadHash: payloadHash(event) };
    await session.receiveInbox(context); await session.markInboxProcessed(context);
  });
  const receipt = await orm.em.fork().execute('SELECT message_id FROM inbox_messages WHERE consumer_name=? AND message_id=?', ['test-event-consumer', event.eventId]);
  expect(receipt).toHaveLength(1);
  const published = await orm.em.fork().execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM outbox_messages WHERE aggregate_id=? AND published_at IS NOT NULL', [wallet.id]);
  expect(published[0]?.count).toBe('2'); await invariant(wallet.id);
}, 20000);

test('consumer shutdown finishes in-flight committed work and acknowledgment', async () => {
  const queues = await setup(); const wallet = await open(); await send(queues, envelope(wallet));
  let notify!: () => void;
  const entered = new Promise<void>(resolve => { notify = resolve; });
  let finished = false;
  const consumer = new WagerConsumer(orm, service, client, queues, { afterCommit: async () => { notify(); await Bun.sleep(100); finished = true; } });
  consumer.start();
  try {
    await Promise.race([entered, Bun.sleep(5000).then(() => { throw new Error('Consumer did not enter handler.'); })]);
    await consumer.stop();
    expect(finished).toBe(true);
    const remaining = await client.send(new ReceiveMessageCommand({ QueueUrl: queues.requests, WaitTimeSeconds: 0 }));
    expect(remaining.Messages ?? []).toHaveLength(0); expect((await invariant(wallet.id)).balance).toBe('75.00');
  } finally { await consumer.stop(); }
}, 15000);
