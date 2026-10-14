import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { createApp } from '../../src/http/app';
import type { INestApplication } from '@nestjs/common';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_test';
if (!new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required.');
let orm: MikroORM;
let app: INestApplication;
let base: string;
beforeAll(async () => {
  orm = await MikroORM.init(databaseConfig(url));
  await orm.getMigrator().up();
  app = await createApp(orm);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
afterAll(async () => { if (app) await app.close(); if (orm) await orm.close(true); });

async function request(path: string, body?: unknown, key?: string) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() as Record<string, any> };
}
async function open(amount = '100.00') {
  const response = await request('/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201);
  return response.data as { id: string; playerId: string; version: number };
}
function bet(wallet: { id: string; playerId: string }, amount = '25.00') {
  return { providerId: 'provider-a', externalTransactionId: randomUUID(), playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round-1', gameId: 'game-1', kind: 'BET', money: { amount, currency: 'BRL' } };
}
async function invariant(walletId: string) {
  const rows = await orm.em.fork().execute<Array<{ balance: string; calculated: string }>>(`
    SELECT w.balance::text AS balance, COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated
    FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [walletId]);
  expect(rows[0]?.balance).toBe(rows[0]?.calculated);
}

describe('HTTP and real PostgreSQL financial flow', () => {
  test('opening credit, zero opening and duplicate wallet', async () => {
    const w = await open();
    const duplicate = await request('/wallets', { playerId: w.playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    expect(duplicate.status).toBe(409);
    const ledger = await orm.em.fork().execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM wallet_ledger WHERE wallet_id=?', [w.id]);
    expect(ledger[0]?.count).toBe('1');
    expect(w.version).toBe(1);
    const zero = await open('0.00');
    const noLedger = await orm.em.fork().execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM wallet_ledger WHERE wallet_id=?', [zero.id]);
    expect(noLedger[0]?.count).toBe('0');
    await invariant(w.id); await invariant(zero.id);
  });

  test('50 parallel duplicates produce one debit and original result', async () => {
    const w = await open();
    const input = bet(w);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 50 }, () => request('/wagering/transactions', input, key)));
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(new Set(results.map(r => r.data.transactionId)).size).toBe(1);
    expect(results.filter(r => r.data.idempotentReplay === false)).toHaveLength(1);
    expect((await request(`/wallets/${w.id}`)).data.balance.amount).toBe('75.00');
    await request('/wagering/transactions', bet(w, '10.00'), randomUUID());
    const replay = await request('/wagering/transactions', input, key);
    expect(replay.data.balance.amount).toBe('75.00');
    expect(replay.data.idempotentReplay).toBe(true);
    await invariant(w.id);
  });

  test('two simultaneous 80.00 bets on 100.00 leave 20.00 and one debit', async () => {
    const w = await open();
    const results = await Promise.all([request('/wagering/transactions', bet(w, '80.00'), randomUUID()), request('/wagering/transactions', bet(w, '80.00'), randomUUID())]);
    expect(results.map(r => r.status).sort()).toEqual([200, 422]);
    expect(results.find(r => r.status === 422)?.data.failureCode).toBe('INSUFFICIENT_FUNDS');
    const snapshot = await request(`/wallets/${w.id}`);
    expect(snapshot.data.balance.amount).toBe('20.00'); expect(snapshot.data.version).toBe(2);
    const rows = await orm.em.fork().execute<Array<{ count: string }>>("SELECT count(*)::text AS count FROM wallet_ledger WHERE wallet_id=? AND direction='DEBIT'", [w.id]);
    expect(rows[0]?.count).toBe('1');
    await invariant(w.id);
  });

  test('payload conflict and external identity under a different key are conflicts', async () => {
    const w = await open(); const input = bet(w); const key = randomUUID();
    expect((await request('/wagering/transactions', input, key)).status).toBe(200);
    expect((await request('/wagering/transactions', { ...input, money: { amount: '26.00', currency: 'BRL' } }, key)).status).toBe(409);
    expect((await request('/wagering/transactions', input, randomUUID())).status).toBe(409);
    await invariant(w.id);
  });

  test('rejects missing key, invalid money, OPENING and unknown fields', async () => {
    const w = await open(); const input = bet(w);
    expect((await request('/wagering/transactions', input)).status).toBe(400);
    expect((await request('/wagering/transactions', { ...input, money: { amount: 25, currency: 'BRL' } }, randomUUID())).status).toBe(400);
    expect((await request('/wagering/transactions', { ...input, kind: 'OPENING' }, randomUUID())).status).toBe(400);
    expect((await request('/wagering/transactions', { ...input, unexpected: true }, randomUUID())).status).toBe(400);
    await invariant(w.id);
  });

  test('currency/player mismatches are auditable rejections without ledger', async () => {
    const w = await open(); const input = bet(w);
    const result = await request('/wagering/transactions', { ...input, money: { amount: '25.00', currency: 'USD' } }, randomUUID());
    expect(result.status).toBe(422); expect(result.data.failureCode).toBe('CURRENCY_MISMATCH');
    expect((await request(`/wagering/transactions/${result.data.transactionId}`)).data.status).toBe('REJECTED');
    expect((await request('/wagering/transactions', { ...bet(w), playerId: randomUUID() }, randomUUID())).data.failureCode).toBe('PLAYER_MISMATCH');
    await invariant(w.id);
  });

  test('database prevents balance changes without ledger and mutation of ledger', async () => {
    const w = await open(); const sql = orm.em.fork();
    await expect(sql.execute('UPDATE wallets SET balance=99.00,version=2 WHERE id=?', [w.id])).rejects.toThrow();
    await expect(sql.execute('UPDATE wallet_ledger SET amount=1.00 WHERE wallet_id=?', [w.id])).rejects.toThrow();
    await expect(sql.execute('DELETE FROM wallet_ledger WHERE wallet_id=?', [w.id])).rejects.toThrow();
    await invariant(w.id);
  });

  test('successful commit includes transaction, one ledger and two outbox events', async () => {
    const w = await open();
    const response = await request('/wagering/transactions', bet(w), randomUUID());
    const id = response.data.transactionId as string;
    const rows = await orm.em.fork().execute<Array<{ ledger_count: string; event_count: string }>>(`
      SELECT (SELECT count(*)::text FROM wallet_ledger WHERE transaction_id=?) AS ledger_count,
      (SELECT count(*)::text FROM outbox_messages WHERE payload->'data'->>'transactionId'=?) AS event_count`, [id, id]);
    expect(rows[0]?.ledger_count).toBe('1'); expect(rows[0]?.event_count).toBe('2');
    await expect(orm.em.fork().execute("UPDATE wager_transactions SET status='REJECTED',failure_code='TEST' WHERE id=?", [id])).rejects.toThrow();
    await invariant(w.id);
  });

  test('three independent processes deduplicate and serialize the same wallet', async () => {
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      const bases = await Promise.all(Array.from({ length: 3 }, async () => {
        const child = Bun.spawn([process.execPath, 'src/main.ts'], {
          env: { ...process.env, DATABASE_URL: url, PORT: '0', ENABLE_MESSAGING: 'false' }, stdout: 'pipe', stderr: 'pipe',
        });
        children.push(child);
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let output = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Child exited before startup: ${await new Response(child.stderr).text()}`);
          output += decoder.decode(chunk.value);
          const line = output.split('\n').find(line => line.includes('HTTP server listening'));
          if (line) {
            const address = JSON.parse(line) as { url: string };
            reader.releaseLock();
            return address.url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
          }
        }
      }));
      const w = await open(); const input = bet(w, '80.00'); const key = randomUUID();
      const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => fetch(`${bases[i % 3]}/wagering/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(input),
      })));
      expect(responses.every(response => response.status === 200)).toBe(true);
      const results = await Promise.all(responses.map(response => response.json() as Promise<{ transactionId: string; idempotentReplay: boolean }>));
      expect(new Set(results.map(result => result.transactionId)).size).toBe(1);
      expect(results.filter(result => !result.idempotentReplay)).toHaveLength(1);
      expect((await request(`/wallets/${w.id}`)).data.balance.amount).toBe('20.00');
      await invariant(w.id);
      const wallets = await Promise.all([open(), open(), open()]);
      const distinct = await Promise.all(wallets.map((wallet, i) => fetch(`${bases[i]}/wagering/transactions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify(bet(wallet)),
      })));
      expect(distinct.every(response => response.status === 200)).toBe(true);
      for (const wallet of wallets) await invariant(wallet.id);
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map(child => child.exited));
    }
  }, 15000);

  test('failed transaction rolls wallet and outbox back together', async () => {
    const walletId = randomUUID(); const eventId = randomUUID();
    await expect(orm.em.fork().transactional(async em => {
      await em.execute("INSERT INTO wallets(id,player_id,currency,balance,version,created_at,updated_at) VALUES(?,?,'BRL',10.00,1,now(),now())", [walletId, randomUUID()]);
      await em.execute("INSERT INTO outbox_messages(id,aggregate_id,event_type,payload,occurred_at) VALUES(?,?,'Test','{}',now())", [eventId, walletId]);
      // Deferred ledger consistency rejects the commit.
    })).rejects.toThrow();
    expect(await orm.em.fork().execute('SELECT id FROM wallets WHERE id=?', [walletId])).toHaveLength(0);
    expect(await orm.em.fork().execute('SELECT id FROM outbox_messages WHERE id=?', [eventId])).toHaveLength(0);
  });
});
