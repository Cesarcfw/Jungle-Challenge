import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { initializeQueues, sqsClient } from '../src/infrastructure/messaging/sqs';
const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
const client = sqsClient();
try {
  const queues = await initializeQueues(client);
  const response = await fetch(`${base}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }) });
  if (!response.ok) throw new Error('Wallet creation failed; start the API and apply migrations.');
  const wallet = await response.json() as { id: string; playerId: string };
  const externalTransactionId = randomUUID();
  const envelope = { messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: {
    providerId: 'sqs-demo', externalTransactionId, idempotencyKey: `sqs-demo:${externalTransactionId}`, playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'sqs-round', gameId: 'sqs-game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  } };
  // Different broker dedup IDs force both deliveries so database idempotency is exercised.
  for (let i = 0; i < 2; i++) await client.send(new SendMessageCommand({ QueueUrl: queues.requests, MessageBody: JSON.stringify(envelope), MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID() }));
  let snapshot: { balance: { amount: string }; version: number } | undefined;
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    snapshot = await (await fetch(`${base}/wallets/${wallet.id}`)).json() as typeof snapshot;
    if (snapshot?.balance.amount === '75.00') break;
  }
  if (snapshot?.balance.amount !== '75.00') throw new Error('Consumer did not apply BET in the demonstration window.');
  console.log(JSON.stringify({ walletId: wallet.id, messageId: envelope.messageId, sentCopies: 2, expectedBalance: '75.00', wallet: snapshot }, null, 2));
} finally { client.destroy(); }
