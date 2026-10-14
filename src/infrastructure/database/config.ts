import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { WalletSchema } from './wallet-record';
import { Migration20261013000100 } from './migrations/Migration20261013000100';
import { Migration20261013000200 } from './migrations/Migration20261013000200';
import { Migration20261013000300 } from './migrations/Migration20261013000300';
import { Migration20261013000400 } from './migrations/Migration20261013000400';

export function databaseConfig(clientUrl = process.env.DATABASE_URL ?? 'postgresql://jungle:jungle@localhost:5432/jungle') {
  return defineConfig({
    clientUrl,
    entities: [WalletSchema],
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration20261013000100, Migration20261013000200, Migration20261013000300, Migration20261013000400],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: false,
    driverOptions: { connection: { statement_timeout: 10_000, lock_timeout: 5_000 } },
  });
}
