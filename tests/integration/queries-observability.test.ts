import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { createApp } from '../../src/http/app';
import { Metrics } from '../../src/infrastructure/observability/metrics';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required.');
let orm: MikroORM;
let app: INestApplication;
let base: string;
const logs: Record<string, unknown>[] = [];
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url)); await orm.getMigrator().up();
  app = await createApp(orm, { logSink: entry => logs.push(entry) }); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => { if (app) await app.close(); if (orm) await orm.close(true); });
async function request(path: string, body?: unknown, key: string = randomUUID(), correlation: string = randomUUID()) {
  const response = await fetch(base + path, { method: body !== undefined ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'idempotency-key': key, 'x-correlation-id': correlation }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, headers: response.headers, data: await response.json() as Record<string, any> };
}
async function open(amount = '100.00') {
  const response = await request('/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201); return response.data as { id: string; playerId: string };
}
function operation(w: { id: string; playerId: string }, kind = 'BET', amount = '10.00') {
  return { providerId: `queries-${randomUUID()}`, externalTransactionId: randomUUID(), playerId: w.playerId, walletId: w.id,
    roundId: 'round', gameId: 'game', kind, money: { amount, currency: 'BRL' } };
}

test('external identity lookup returns original result and scopes by provider', async () => {
  const w = await open(); const input = operation(w); const submitted = await request('/wagering/transactions', input);
  await request('/wagering/transactions', operation(w, 'WIN', '5.00'));
  const external = await request(`/providers/${input.providerId}/wagering/transactions/${input.externalTransactionId}`);
  expect(external.status).toBe(200); expect(external.data.transactionId).toBe(submitted.data.transactionId); expect(external.data.balance.amount).toBe('90.00');
  expect((await request(`/providers/other-provider/wagering/transactions/${input.externalTransactionId}`)).status).toBe(404);
});

test('reconciliation includes opening and counts only movements; zero wallet is consistent', async () => {
  const w = await open(); await request('/wagering/transactions', operation(w, 'BET', '20.00')); await request('/wagering/transactions', operation(w, 'WIN', '30.00'));
  await request('/wagering/transactions', operation(w, 'LOSS', '0.00'));
  const report = await request(`/wallets/${w.id}/reconciliation`, {});
  expect(report.status).toBe(200); expect(report.data.storedBalance.amount).toBe('110.00'); expect(report.data.calculatedBalance.amount).toBe('110.00');
  expect(report.data.difference.amount).toBe('0.00'); expect(report.data.consistent).toBe(true); expect(report.data.checkedEntries).toBe(3);
  const zero = await open('0.00'); const empty = await request(`/wallets/${zero.id}/reconciliation`, {});
  expect(empty.data.checkedEntries).toBe(0); expect(empty.data.consistent).toBe(true);
  expect((await request(`/wallets/${zero.id}/ledger`)).data).toEqual({ items: [], nextCursor: null });
});

test('ledger pagination has stable snapshot, signed wallet cursor and exact money strings', async () => {
  const w = await open(); await request('/wagering/transactions', operation(w)); await request('/wagering/transactions', operation(w, 'WIN', '20.00'));
  const first = await request(`/wallets/${w.id}/ledger?limit=1`); expect(first.status).toBe(200);
  expect(first.data.items[0].walletVersion).toBe(1); expect(typeof first.data.items[0].money.amount).toBe('string'); expect(first.data.nextCursor).toBeTruthy();
  await request('/wagering/transactions', operation(w, 'WIN', '5.00'));
  const second = await request(`/wallets/${w.id}/ledger?limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`);
  const third = await request(`/wallets/${w.id}/ledger?limit=1&cursor=${encodeURIComponent(second.data.nextCursor)}`);
  expect([first.data.items[0].walletVersion, second.data.items[0].walletVersion, third.data.items[0].walletVersion]).toEqual([1,2,3]); expect(third.data.nextCursor).toBeNull();
  const fresh = await request(`/wallets/${w.id}/ledger`); expect(fresh.data.items).toHaveLength(4);
  expect((await request(`/wallets/${w.id}/ledger?cursor=${first.data.nextCursor}.forged`)).status).toBe(400);
  const other = await open(); expect((await request(`/wallets/${other.id}/ledger?cursor=${first.data.nextCursor}`)).status).toBe(400);
  for (const limit of ['0','101','1.5','NaN','1&limit=2']) expect((await request(`/wallets/${w.id}/ledger?limit=${limit}`)).status).toBe(400);
});

test('concurrent reconciliation never observes a partial financial commit', async () => {
  const w = await open();
  const results = await Promise.all(Array.from({ length: 25 }, async () => {
    const [bet, report] = await Promise.all([request('/wagering/transactions', operation(w, 'BET', '1.00')), request(`/wallets/${w.id}/reconciliation`, {})]);
    expect(bet.status).toBe(200); expect(report.data.consistent).toBe(true); return report;
  }));
  expect(results).toHaveLength(25);
  const final = await request(`/wallets/${w.id}/reconciliation`, {}); expect(final.data.storedBalance.amount).toBe('75.00'); expect(final.data.checkedEntries).toBe(26);
});

test('corruption is reported and counted without repair or financial payload in logs', async () => {
  const w = await open();
  const corrupt = async (amount: string) => orm.em.fork().transactional(async em => {
    // Deliberate administrator fault injection, transaction-local and on a dedicated test wallet.
    await em.execute("SET LOCAL session_replication_role='replica'");
    await em.execute('UPDATE wallets SET balance=? WHERE id=?', [amount, w.id]);
  });
  await corrupt('99.00');
  try {
    const response = await request(`/wallets/${w.id}/reconciliation`, {}, randomUUID(), 'reconcile-test');
    expect(response.status).toBe(200); expect(response.data.consistent).toBe(false); expect(response.data.difference.amount).toBe('-1.00');
    expect((await request(`/wallets/${w.id}`)).data.balance.amount).toBe('99.00');
    const alert = logs.find(entry => entry.code === 'RECONCILIATION_DIVERGENCE' && entry.walletId === w.id);
    expect(alert?.correlationId).toBe('reconcile-test'); expect(alert?.level).toBe('error'); expect(alert).not.toHaveProperty('difference'); expect(alert).not.toHaveProperty('balance');
    const metrics = await (await fetch(base + '/metrics')).text(); expect(metrics).toContain('wallet_reconciliation_divergences_total 1');
  } finally { await corrupt('100.00'); }
  expect((await request(`/wallets/${w.id}/reconciliation`, {})).data.consistent).toBe(true);
});

test('HTTP logs carry correlation and transaction IDs without amounts, auth or passwords', async () => {
  const w = await open(); const input = operation(w); const key = randomUUID();
  const submitted = await request('/wagering/transactions', input, key, 'audit-test');
  expect(submitted.headers.get('x-correlation-id')).toBe('audit-test');
  await request('/wagering/transactions', input, key, 'audit-replay');
  await request('/wagering/transactions', { ...input, password: 'NEVER_LOG_SECRET_123' });
  const entry = logs.find(entry => entry.code === 'HTTP_REQUEST' && entry.correlationId === 'audit-test');
  expect(entry?.transactionId).toBe(submitted.data.transactionId); expect(entry?.walletId).toBe(w.id); expect(entry?.providerId).toBe(input.providerId);
  expect(entry).toHaveProperty('messageId', null); expect(JSON.stringify(logs)).not.toContain('NEVER_LOG_SECRET_123');
  expect(logs.every(entry => !('money' in entry) && !('balance' in entry) && !('playerId' in entry))).toBe(true);
});

test('metrics expose outcomes, duplicates, latency and database gauges with bounded labels', async () => {
  const response = await fetch(base + '/metrics'); expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/plain');
  const metrics = await response.text();
  for (const name of ['wager_processing_outcomes_total','wager_duplicates_total','wager_processing_seconds','wager_transactions_persisted','outbox_lag_seconds','outbox_pending_messages','wallet_reconciliations_total','http_request_seconds','wager_lock_conflicts_total','wager_dlq_sent_total']) expect(metrics).toContain(name);
  expect(metrics).toMatch(/wager_duplicates_total\{source="http"\} [1-9]/);
  expect(metrics).not.toContain('walletId='); expect(metrics).not.toContain('transactionId=');
  expect(metrics).toContain('# TYPE wager_retries_total counter');
});
