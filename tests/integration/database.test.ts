import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { walletFromRecord, walletToRecord, WalletRecord } from '../../src/infrastructure/database/wallet-record';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { Migration20261013000100 } from '../../src/infrastructure/database/migrations/Migration20261013000100';

// Isolated first-migration tests; financial tests run against the complete schema.
const url = process.env.SCHEMA_TEST_DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle_schema_test';
if (!new URL(url).pathname.endsWith('_test')) {
  throw new Error('Integration tests require a dedicated database with a name ending in _test.');
}

let orm: MikroORM;
beforeAll(async () => {
  const config = databaseConfig(url);
  config.migrations = { ...config.migrations, migrationsList: [Migration20261013000100] };
  orm = await MikroORM.init(config);
  await orm.getMigrator().up();
});
afterAll(async () => { if (orm) await orm.close(true); });

describe('PostgreSQL wallet foundation', () => {
  test('ORM persists and rehydrates monetary values as exact strings', async () => {
    const em = orm.em.fork();
    const wallet = Wallet.open({ id: randomUUID(), playerId: randomUUID(), initialBalance: Money.from({ amount: '9007199254740993.01', currency: 'BRL' }) });
    await em.persistAndFlush(walletToRecord(wallet));
    em.clear();
    const record = await em.findOneOrFail(WalletRecord, wallet.id);
    expect(typeof record.balance).toBe('string');
    expect(record.balance).toBe('9007199254740993.01');
    expect(walletFromRecord(record).balance.toString()).toBe('9007199254740993.01');
    await em.nativeDelete(WalletRecord, { id: wallet.id });
  });

  test('database rejects negative balance even when bypassing the domain', async () => {
    const sql = orm.em.getConnection();
    await expect(sql.execute(`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, 'BRL', -0.01, 1, now(), now())`, [randomUUID(), randomUUID()])).rejects.toThrow();
  });

  test('database forbids duplicate wallet for player and currency', async () => {
    const em = orm.em.fork();
    const playerId = randomUUID();
    const originalId = randomUUID();
    const sql = em.getConnection();
    const insert = `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, 'BRL', 0.00, 1, now(), now())`;
    await sql.execute(insert, [originalId, playerId]);
    try {
      await expect(sql.execute(insert, [randomUUID(), playerId])).rejects.toThrow();
    } finally {
      await em.nativeDelete(WalletRecord, { id: originalId });
    }
  });

  test('migration can be reversed and reapplied in the dedicated test database', async () => {
    const sql = orm.em.getConnection();
    const count = await sql.execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM wallets');
    expect(count[0]?.count).toBe('0');
    await orm.getMigrator().down();
    const removed = await sql.execute<Array<{ table_name: string | null }>>("SELECT to_regclass('public.wallets')::text AS table_name");
    expect(removed[0]?.table_name).toBeNull();
    await orm.getMigrator().up();
    const restored = await sql.execute<Array<{ table_name: string }>>("SELECT to_regclass('public.wallets')::text AS table_name");
    expect(restored[0]?.table_name).toBe('wallets');
  });

  test('financial migration up/down preserves the initial empty schema', async () => {
    const complete = await MikroORM.init(databaseConfig(url));
    try {
      await complete.getMigrator().up();
      for (let i = 0; i < 3; i++) await complete.getMigrator().down();
      const tables = await complete.em.getConnection().execute<Array<{ ledger: string | null; wallet: string }>>("SELECT to_regclass('public.wallet_ledger')::text AS ledger, to_regclass('public.wallets')::text AS wallet");
      expect(tables[0]?.ledger).toBeNull();
      expect(tables[0]?.wallet).toBe('wallets');
    } finally { await complete.close(true); }
  });
});
