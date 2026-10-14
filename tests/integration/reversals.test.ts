import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { createApp } from '../../src/http/app';
import { WageringService } from '../../src/application/wagering-service';
import { PostgresFinancialStore } from '../../src/infrastructure/database/postgres-financial-store';
import type { INestApplication } from '@nestjs/common';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required.');
let orm: MikroORM;
let app: INestApplication;
let base: string;
let service: WageringService;
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url)); await orm.getMigrator().up();
  service = new WageringService(new PostgresFinancialStore(orm));
  app = await createApp(orm); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => { if (app) await app.close(); if (orm) await orm.close(true); });
async function post(path: string, body: unknown, key = randomUUID()) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as Record<string, any> };
}
async function open(amount = '100.00') {
  const result = await post('/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(result.status).toBe(201);
  return result.data as { id: string; playerId: string };
}
function operation(wallet: { id: string; playerId: string }, kind: string, amount: string, reference?: string) {
  return { providerId: 'reversal-provider', externalTransactionId: randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' }, ...(reference ? { referenceExternalTransactionId: reference } : {}) };
}
async function snapshot(walletId: string) {
  const rows = await orm.em.fork().execute<Array<{ balance: string; calculated: string; version: number; entries: string }>>(`
    SELECT w.balance::text AS balance,w.version,count(l.id)::text AS entries,
      COALESCE(sum(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated
    FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [walletId]);
  expect(rows[0]?.balance).toBe(rows[0]?.calculated); return rows[0]!;
}

describe('results and reversals on real PostgreSQL', () => {
  test('WIN credits and LOSS preserves balance, version and ledger', async () => {
    const wallet = await open();
    const bet = operation(wallet, 'BET', '25.00'); await post('/wagering/transactions', bet);
    expect((await post('/wagering/transactions', operation(wallet, 'WIN', '40.00', bet.externalTransactionId))).status).toBe(200);
    const before = await snapshot(wallet.id);
    const loss = await post('/wagering/transactions', operation(wallet, 'LOSS', '0.00'));
    expect(loss.status).toBe(200); expect(loss.data.status).toBe('PROCESSED');
    expect(await snapshot(wallet.id)).toEqual(before); expect(before.balance).toBe('115.00');
    const events = await orm.em.fork().execute<Array<{ event_type: string }>>("SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId'=?", [loss.data.transactionId]);
    expect(events.map(e => e.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  test('REFUND credits only once under parallel reversals and replays its original result', async () => {
    const wallet = await open(); const bet = operation(wallet, 'BET', '80.00'); await post('/wagering/transactions', bet);
    const a = operation(wallet, 'REFUND', '80.00', bet.externalTransactionId);
    const b = operation(wallet, 'REFUND', '80.00', bet.externalTransactionId); const key = randomUUID();
    const results = await Promise.all([post('/wagering/transactions', a, key), post('/wagering/transactions', b)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 422]);
    expect(results.find(r => r.status === 422)?.data.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    const replay = await post('/wagering/transactions', a, key);
    expect(replay.data.idempotentReplay).toBe(true);
    expect((await snapshot(wallet.id)).balance).toBe('100.00');
  });

  test('ROLLBACK inverts BET, WIN and REFUND', async () => {
    const wallet = await open(); const bet = operation(wallet, 'BET', '10.00'); await post('/wagering/transactions', bet);
    expect((await post('/wagering/transactions', operation(wallet, 'ROLLBACK', '10.00', bet.externalTransactionId))).data.balance.amount).toBe('100.00');
    const win = operation(wallet, 'WIN', '20.00'); await post('/wagering/transactions', win);
    expect((await post('/wagering/transactions', operation(wallet, 'ROLLBACK', '20.00', win.externalTransactionId))).data.balance.amount).toBe('100.00');
    const secondBet = operation(wallet, 'BET', '10.00'); await post('/wagering/transactions', secondBet);
    const refund = operation(wallet, 'REFUND', '10.00', secondBet.externalTransactionId); await post('/wagering/transactions', refund);
    expect((await post('/wagering/transactions', operation(wallet, 'ROLLBACK', '10.00', refund.externalTransactionId))).data.balance.amount).toBe('90.00');
    await snapshot(wallet.id);
  });

  test('debit reversal without available funds is rejected with its own code', async () => {
    const wallet = await open('0.00'); const win = operation(wallet, 'WIN', '50.00'); await post('/wagering/transactions', win);
    await post('/wagering/transactions', operation(wallet, 'BET', '50.00'));
    const rollback = await post('/wagering/transactions', operation(wallet, 'ROLLBACK', '50.00', win.externalTransactionId));
    expect(rollback.status).toBe(422); expect(rollback.data.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect((await snapshot(wallet.id)).balance).toBe('0.00');
  });

  test('validates required reference, reference kind, amount, identity and state', async () => {
    const wallet = await open(); const bet = operation(wallet, 'BET', '10.00'); await post('/wagering/transactions', bet);
    expect((await post('/wagering/transactions', operation(wallet, 'REFUND', '10.00'))).status).toBe(400);
    expect((await post('/wagering/transactions', operation(wallet, 'REFUND', '9.00', bet.externalTransactionId))).data.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
    expect((await post('/wagering/transactions', { ...operation(wallet, 'REFUND', '10.00', bet.externalTransactionId), roundId: 'other' })).data.failureCode).toBe('REFERENCE_IDENTITY_MISMATCH');
    const win = operation(wallet, 'WIN', '10.00'); await post('/wagering/transactions', win);
    expect((await post('/wagering/transactions', operation(wallet, 'REFUND', '10.00', win.externalTransactionId))).data.failureCode).toBe('INVALID_REFERENCE_KIND');
    const rejected = operation(wallet, 'BET', '999.00'); await post('/wagering/transactions', rejected);
    expect((await post('/wagering/transactions', operation(wallet, 'REFUND', '999.00', rejected.externalTransactionId))).data.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    await snapshot(wallet.id);
  });

  test('REFUND before BET is durable, then two workers resolve it once', async () => {
    const wallet = await open(); const bet = operation(wallet, 'BET', '30.00');
    const pending = await post('/wagering/transactions', operation(wallet, 'REFUND', '30.00', bet.externalTransactionId));
    expect(pending.status).toBe(202); expect(pending.data.status).toBe('PENDING_REFERENCE');
    expect((await snapshot(wallet.id)).balance).toBe('100.00');
    await post('/wagering/transactions', bet);
    const future = new Date(Date.now() + 5000);
    await Promise.all([service.reprocessReferences(future), service.reprocessReferences(future)]);
    const result = await (await fetch(`${base}/wagering/transactions/${pending.data.transactionId}`)).json() as { status: string };
    expect(result.status).toBe('PROCESSED');
    const final = await snapshot(wallet.id); expect(final.balance).toBe('100.00'); expect(final.entries).toBe('3');
  });

  test('ROLLBACK before WIN resolves through a new database connection', async () => {
    const wallet = await open(); const win = operation(wallet, 'WIN', '10.00');
    const pending = await post('/wagering/transactions', operation(wallet, 'ROLLBACK', '10.00', win.externalTransactionId));
    expect(pending.status).toBe(202);
    await post('/wagering/transactions', win);
    const reopened = await MikroORM.init(databaseConfig(url));
    try { await new WageringService(new PostgresFinancialStore(reopened)).reprocessReferences(new Date(Date.now() + 5000)); }
    finally { await reopened.close(true); }
    const result = await (await fetch(`${base}/wagering/transactions/${pending.data.transactionId}`)).json() as { status: string };
    expect(result.status).toBe('PROCESSED'); expect((await snapshot(wallet.id)).balance).toBe('100.00');
  });

  test('scheduled worker resolves pending reference without manual invocation', async () => {
    const wallet = await open(); const bet = operation(wallet, 'BET', '10.00');
    const pending = await post('/wagering/transactions', operation(wallet, 'REFUND', '10.00', bet.externalTransactionId));
    expect(pending.status).toBe(202);
    await post('/wagering/transactions', bet);
    let status = 'PENDING_REFERENCE';
    for (let attempt = 0; attempt < 60 && status === 'PENDING_REFERENCE'; attempt++) {
      await Bun.sleep(100);
      status = ((await (await fetch(`${base}/wagering/transactions/${pending.data.transactionId}`)).json()) as { status: string }).status;
    }
    expect(status).toBe('PROCESSED'); expect((await snapshot(wallet.id)).balance).toBe('100.00');
  }, 10000);

  test('missing reference retries with backoff, then expires with a rejection event', async () => {
    const wallet = await open(); const pending = await post('/wagering/transactions', operation(wallet, 'REFUND', '10.00', randomUUID()));
    await service.reprocessReferences(new Date(Date.now() + 5000));
    const state = await orm.em.fork().execute<Array<{ reference_attempts: number; next_reference_attempt_at: Date }>>('SELECT reference_attempts,next_reference_attempt_at FROM wager_transactions WHERE id=?', [pending.data.transactionId]);
    expect(state[0]?.reference_attempts).toBe(1);
    expect(new Date(state[0]!.next_reference_attempt_at).getTime()).toBeGreaterThan(Date.now() + 5000);
    await service.reprocessReferences(new Date(Date.now() + 25 * 60 * 60 * 1000));
    const result = await (await fetch(`${base}/wagering/transactions/${pending.data.transactionId}`)).json() as { status: string; failureCode: string };
    expect(result.status).toBe('REJECTED'); expect(result.failureCode).toBe('REFERENCE_EXPIRED');
    const events = await orm.em.fork().execute<Array<{ event_type: string }>>("SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId'=? ORDER BY occurred_at", [pending.data.transactionId]);
    expect(events.map(e => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    await snapshot(wallet.id);
  });
});
