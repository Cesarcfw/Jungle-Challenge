import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MikroORM } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { databaseConfig } from '../src/infrastructure/database/config';
import { initializeQueues, sqsClient } from '../src/infrastructure/messaging/sqs';
import type { MoneyProps } from '../src/domain/money';
import type { TransactionResult } from '../src/application/financial-store';

interface WalletReply { id: string; playerId: string; balance: MoneyProps; version: number }
interface State { wallets: Array<{ id: string; amount: string; version: number }>; originalBetId: string }
const bases = (process.env.API_BASE_URLS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',');
if (bases.length < 3) throw new Error('Smoke test requires at least three API URLs.');
const file = join(tmpdir(), 'jungle-compose-smoke.json');
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function request<T>(instance: number, path: string, body?: unknown, key = randomUUID()) {
  const response = await fetch(bases[instance % bases.length]! + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as T };
}
async function ready() {
  for (let i = 0; i < bases.length; i++) assert((await request(i, '/health/ready')).status === 200, `Instance ${i + 1} is not ready.`);
}
async function open() {
  const response = await request<WalletReply>(0, '/wallets', { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } });
  assert(response.status === 201, 'Wallet creation failed.'); return response.data;
}
function operation(wallet: WalletReply, amount: string, kind = 'BET', reference?: string) {
  return { providerId: 'compose-smoke', externalTransactionId: randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' }, ...(reference ? { referenceExternalTransactionId: reference } : {}) };
}
async function checkWallet(id: string, amount: string, instance = 0) {
  const wallet = await request<WalletReply>(instance, `/wallets/${id}`);
  const report = await request<{ consistent: boolean; calculatedBalance: MoneyProps }>(instance, `/wallets/${id}/reconciliation`, {});
  assert(wallet.status === 200 && wallet.data.balance.amount === amount, 'Unexpected persisted balance.');
  assert(report.status === 200 && report.data.consistent && report.data.calculatedBalance.amount === amount, 'Ledger reconciliation failed.');
  return { id, amount, version: wallet.data.version };
}

await ready();
if (process.argv[2] === 'check') {
  const state = await Bun.file(file).json() as State;
  for (let i = 0; i < state.wallets.length; i++) {
    const expected = state.wallets[i]!;
    const current = await checkWallet(expected.id, expected.amount, i % 3);
    assert(current.version === expected.version, 'Wallet version changed after restart.');
  }
  const result = await request<TransactionResult>(2, `/wagering/transactions/${state.originalBetId}`);
  assert(result.status === 200 && result.data.status === 'PROCESSED' && result.data.balance.amount === '75.00', 'Original result changed after restart.');
  console.log(JSON.stringify({ status: 'ok', phase: 'after-restart', verifiedWallets: state.wallets.length }));
} else {
  const wallet = await open(); const input = operation(wallet, '25.00'); const key = randomUUID();
  const duplicateResults = await Promise.all(Array.from({ length: 50 }, (_, i) => request<TransactionResult & { idempotentReplay: boolean }>(i % 3, '/wagering/transactions', input, key)));
  assert(duplicateResults.every(r => r.status === 200), 'Some duplicate submissions failed.');
  assert(new Set(duplicateResults.map(r => r.data.transactionId)).size === 1, 'Duplicate transaction IDs.');
  assert(duplicateResults.filter(r => !r.data.idempotentReplay).length === 1, 'Expected exactly one original application.');
  const duplicateWallet = await checkWallet(wallet.id, '75.00');
  const page = await request<{ items: object[]; nextCursor: string }>(0, `/wallets/${wallet.id}/ledger?limit=1`);
  const secondPage = await request<{ items: object[]; nextCursor: string | null }>(2, `/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(page.data.nextCursor)}`);
  assert(page.data.items.length === 1 && secondPage.data.items.length === 1 && secondPage.data.nextCursor === null, 'Cursor was not portable across replicas.');

  const race = await open();
  const competed = await Promise.all([request(0, '/wagering/transactions', operation(race, '80.00')), request(1, '/wagering/transactions', operation(race, '80.00'))]);
  assert(competed.map(r => r.status).sort().join(',') === '200,422', 'Expected one successful bet and one rejection.');
  const raceWallet = await checkWallet(race.id, '20.00', 1);

  const outOfOrder = await open(); const futureBet = operation(outOfOrder, '10.00');
  const pending = await request<TransactionResult>(1, '/wagering/transactions', operation(outOfOrder, '10.00', 'REFUND', futureBet.externalTransactionId));
  assert(pending.status === 202, 'Reference should be pending.');
  assert((await request(2, '/wagering/transactions', futureBet)).status === 200, 'Reference BET failed.');
  let resolved = false;
  for (let i = 0; i < 100; i++) {
    await Bun.sleep(100);
    const response = await request<TransactionResult>(0, `/wagering/transactions/${pending.data.transactionId}`);
    if (response.data.status === 'PROCESSED') { resolved = true; break; }
  }
  assert(resolved, 'Reference worker did not resolve the transaction.');
  const referenceWallet = await checkWallet(outOfOrder.id, '100.00', 2);

  const sqsWallet = await open(); const sqsInput = operation(sqsWallet, '25.00'); const messageId = randomUUID();
  const client = sqsClient();
  try {
    const queues = await initializeQueues(client);
    const envelope = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: { ...sqsInput, idempotencyKey: randomUUID() } };
    for (let i = 0; i < 2; i++) await client.send(new SendMessageCommand({ QueueUrl: queues.requests, MessageBody: JSON.stringify(envelope), MessageGroupId: sqsWallet.id, MessageDeduplicationId: randomUUID() }));
    let applied = false;
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(100);
      if ((await request<WalletReply>(0, `/wallets/${sqsWallet.id}`)).data.balance.amount === '75.00') { applied = true; break; }
    }
    assert(applied, 'SQS consumer did not apply the transaction.');
  } finally { client.destroy(); }
  const sqsSnapshot = await checkWallet(sqsWallet.id, '75.00');
  const orm = await MikroORM.init(databaseConfig());
  try {
    let published = false;
    for (let i = 0; i < 100; i++) {
      const rows = await orm.em.fork().execute<Array<{ inbox: string; debits: string; published: string }>>(`
        SELECT (SELECT count(*)::text FROM inbox_messages WHERE message_id=? AND processed_at IS NOT NULL) AS inbox,
        (SELECT count(*)::text FROM wallet_ledger WHERE wallet_id=? AND direction='DEBIT') AS debits,
        (SELECT count(*)::text FROM outbox_messages WHERE aggregate_id=? AND published_at IS NOT NULL) AS published`, [messageId, sqsWallet.id, sqsWallet.id]);
      assert(rows[0]?.debits === '1' && rows[0]?.inbox === '1', 'SQS duplicated financial effect or lost inbox.');
      if (rows[0]?.published === '4') { published = true; break; }
      await Bun.sleep(100);
    }
    assert(published, 'Publisher did not deliver all confirmed events.');
  } finally { await orm.close(true); }
  const state: State = { wallets: [duplicateWallet, raceWallet, referenceWallet, sqsSnapshot], originalBetId: duplicateResults[0]!.data.transactionId };
  await Bun.write(file, JSON.stringify(state));
  console.log(JSON.stringify({ status: 'ok', phase: 'three-replicas', parallelCopies: 50, wallets: state.wallets, snapshotFile: file }));
}
