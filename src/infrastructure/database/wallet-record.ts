import { DecimalType, EntitySchema } from '@mikro-orm/core';
import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';

// Infrastructure records stay separate from domain entities and their invariants.
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', length: 3 },
    balance: { type: new DecimalType('string'), precision: 20, scale: 2 },
    version: { type: 'integer', default: 1 },
    createdAt: { type: 'datetime', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
  uniques: [{ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] }],
});

export function walletToRecord(wallet: Wallet): WalletRecord {
  return Object.assign(new WalletRecord(), {
    id: wallet.id, playerId: wallet.playerId, currency: wallet.currency,
    balance: wallet.balance.toString(), version: wallet.version,
    createdAt: wallet.createdAt, updatedAt: wallet.updatedAt,
  });
}

export function walletFromRecord(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id, playerId: record.playerId,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version, createdAt: record.createdAt, updatedAt: record.updatedAt,
  });
}
