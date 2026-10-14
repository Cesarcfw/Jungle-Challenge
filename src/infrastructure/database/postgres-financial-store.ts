import { LockMode } from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import type { FinancialSession, FinancialStore, StoredTransaction, TransactionWrite, InboxContext, Reconciliation, LedgerItem } from '../../application/financial-store';
import { Money } from '../../domain/money';
import { DomainError } from '../../domain/domain-error';
import { InboxMessage } from '../../domain/inbox-message';
import { OutboxMessage } from '../../domain/outbox-message';
import type { IntegrationEvent } from '../../domain/integration-event';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WalletRecord, walletFromRecord, walletToRecord } from './wallet-record';

const transactionSelect = `SELECT t.id,t.idempotency_key,t.payload_hash,t.result,t.reference_transaction_id,t.reference_attempts,t.created_at,t.next_reference_attempt_at,l.direction AS ledger_direction,
  jsonb_build_object('providerId',t.provider_id,'externalTransactionId',t.external_transaction_id,'playerId',t.player_id,'walletId',t.wallet_id,'roundId',t.round_id,'gameId',t.game_id,'kind',t.kind,'money',jsonb_build_object('amount',t.amount::text,'currency',t.currency))
  || CASE WHEN t.reference_external_transaction_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('referenceExternalTransactionId',t.reference_external_transaction_id) END AS input
  FROM wager_transactions t LEFT JOIN wallet_ledger l ON l.transaction_id=t.id`;

type RawTransaction = Omit<StoredTransaction, 'created_at' | 'next_reference_attempt_at'> & {
  created_at: Date | string; next_reference_attempt_at: Date | string | null;
};
function rehydrateTransaction(row: RawTransaction): StoredTransaction {
  return { ...row, created_at: new Date(row.created_at), next_reference_attempt_at: row.next_reference_attempt_at ? new Date(row.next_reference_attempt_at) : null };
}

class PostgresSession implements FinancialSession {
  constructor(private readonly em: EntityManager) {}
  async receiveInbox(context: InboxContext): Promise<void> {
    await this.em.execute('INSERT INTO inbox_messages(consumer_name,message_id,payload_hash,received_at) VALUES(?,?,?,now()) ON CONFLICT DO NOTHING',
      [context.consumerName, context.messageId, context.payloadHash]);
    const rows = await this.em.execute<Array<{ payload_hash: string }>>('SELECT payload_hash FROM inbox_messages WHERE consumer_name=? AND message_id=? FOR UPDATE', [context.consumerName, context.messageId]);
    const message = InboxMessage.rehydrate(context.messageId, context.consumerName, rows[0]!.payload_hash);
    if (!message.matchesPayload(context.payloadHash)) throw new DomainError('INBOX_PAYLOAD_CONFLICT', 'Message identity reused with divergent payload.');
  }
  async markInboxProcessed(context: InboxContext): Promise<void> {
    await this.em.execute('UPDATE inbox_messages SET processed_at=COALESCE(processed_at,now()) WHERE consumer_name=? AND message_id=?', [context.consumerName, context.messageId]);
  }
  async lockWallet(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? walletFromRecord(record) : null;
  }
  async findTransaction(key: string, provider: string, external: string): Promise<StoredTransaction[]> {
    const rows = await this.em.execute<RawTransaction[]>(transactionSelect + ' WHERE t.idempotency_key = ? OR (t.provider_id = ? AND t.external_transaction_id = ?)', [key, provider, external]);
    return rows.map(rehydrateTransaction);
  }
  async insertTransaction(tx: TransactionWrite): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>(`
      INSERT INTO wager_transactions (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,failure_code,result,created_at,processed_at,reference_external_transaction_id,reference_transaction_id,reference_attempts,next_reference_attempt_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING id`,
    [tx.id, tx.input.providerId, tx.input.externalTransactionId, tx.idempotencyKey, tx.payloadHash,
      tx.input.walletId, tx.input.playerId, tx.input.roundId, tx.input.gameId, tx.input.kind,
      tx.input.money.amount, tx.input.money.currency, tx.result.status, tx.result.failureCode ?? null, JSON.stringify(tx.result), tx.at,
      tx.result.status === 'PENDING_REFERENCE' ? null : tx.at, tx.input.referenceExternalTransactionId ?? null, tx.referenceTransactionId ?? null,
      tx.referenceAttempts ?? 0, tx.nextReferenceAttemptAt ?? null]);
    return rows.length === 1;
  }
  async updateTransaction(tx: TransactionWrite): Promise<void> {
    await this.em.execute(`UPDATE wager_transactions SET status=?,failure_code=?,result=?::jsonb,processed_at=?,reference_transaction_id=?,reference_attempts=?,next_reference_attempt_at=? WHERE id=?`,
      [tx.result.status, tx.result.failureCode ?? null, JSON.stringify(tx.result), tx.result.status === 'PENDING_REFERENCE' ? null : tx.at,
        tx.referenceTransactionId ?? null, tx.referenceAttempts ?? 0, tx.nextReferenceAttemptAt ?? null, tx.id]);
  }
  async findReference(provider: string, external: string): Promise<StoredTransaction | null> {
    const rows = await this.em.execute<RawTransaction[]>(transactionSelect + ' WHERE t.provider_id=? AND t.external_transaction_id=?', [provider, external]);
    return rows[0] ? rehydrateTransaction(rows[0]) : null;
  }
  async alreadyReversed(id: string, kind: string): Promise<boolean> {
    const rows = await this.em.execute<Array<{ id: string }>>("SELECT id FROM wager_transactions WHERE reference_transaction_id=? AND kind=? AND status='PROCESSED'", [id, kind]);
    return rows.length > 0;
  }
  async saveWallet(wallet: Wallet, insert: boolean): Promise<void> {
    const data = walletToRecord(wallet);
    if (insert) {
      await this.em.persistAndFlush(data);
    } else {
      const record = await this.em.findOneOrFail(WalletRecord, wallet.id);
      this.em.assign(record, { balance: data.balance, version: data.version, updatedAt: data.updatedAt });
      await this.em.flush();
    }
  }
  async insertLedger(entry: WalletLedgerEntry, version: number): Promise<void> {
    await this.em.execute(`INSERT INTO wallet_ledger(id,wallet_id,transaction_id,currency,direction,amount,balance_before,balance_after,wallet_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [entry.id, entry.walletId, entry.transactionId, entry.money.currency, entry.direction, entry.money.toString(), entry.balanceBefore.toString(), entry.balanceAfter.toString(), version, entry.createdAt]);
  }
  async enqueue(event: IntegrationEvent<object>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    await this.em.execute('INSERT INTO outbox_messages(id,aggregate_id,event_type,payload,occurred_at) VALUES(?,?,?,?::jsonb,?)',
      [message.id, message.aggregateId, message.eventType, JSON.stringify(message.payload), message.occurredAt]);
  }
}

export class PostgresFinancialStore implements FinancialStore {
  constructor(private readonly orm: MikroORM) {}
  transaction<T>(work: (session: FinancialSession) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(em => work(new PostgresSession(em)));
  }
  async getWallet(id: string): Promise<Wallet | null> {
    const record = await this.orm.em.fork().findOne(WalletRecord, id);
    return record ? walletFromRecord(record) : null;
  }
  async getTransaction(id: string): Promise<StoredTransaction | null> {
    const rows = await this.orm.em.fork().execute<RawTransaction[]>(transactionSelect + ' WHERE t.id = ?', [id]);
    return rows[0] ? rehydrateTransaction(rows[0]) : null;
  }
  async dueReferences(now: Date): Promise<StoredTransaction[]> {
    const rows = await this.orm.em.fork().execute<RawTransaction[]>(transactionSelect + " WHERE t.status='PENDING_REFERENCE' AND t.next_reference_attempt_at<=? ORDER BY t.next_reference_attempt_at,t.id LIMIT 50", [now]);
    return rows.map(rehydrateTransaction);
  }
  async getExternalTransaction(providerId: string, externalId: string): Promise<StoredTransaction | null> {
    const rows = await this.orm.em.fork().execute<RawTransaction[]>(transactionSelect + ' WHERE t.provider_id=? AND t.external_transaction_id=?', [providerId, externalId]);
    return rows[0] ? rehydrateTransaction(rows[0]) : null;
  }
  async reconcile(walletId: string): Promise<Reconciliation | null> {
    // One SQL statement gives wallet and ledger the same MVCC snapshot.
    const rows = await this.orm.em.fork().execute<Array<{ currency: string; balance: string; calculated: string; entries: string }>>(`
      SELECT w.currency,w.balance::text AS balance,
        COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),0)::numeric(20,2)::text AS calculated,
        COUNT(l.id)::text AS entries FROM wallets w LEFT JOIN wallet_ledger l ON l.wallet_id=w.id WHERE w.id=? GROUP BY w.id`, [walletId]);
    const row = rows[0]; if (!row) return null;
    const stored = Money.rehydrate({ amount: row.balance, currency: row.currency });
    const calculated = Money.rehydrate({ amount: row.calculated, currency: row.currency });
    return { walletId, storedBalance: stored.toJSON(), calculatedBalance: calculated.toJSON(), difference: stored.subtract(calculated).toJSON(),
      consistent: stored.equals(calculated), checkedEntries: Number(row.entries) };
  }
  async ledger(walletId: string, after: number, ceiling: number, limit: number): Promise<LedgerItem[]> {
    const rows = await this.orm.em.fork().execute<Array<{ id: string; transaction_id: string; direction: 'DEBIT' | 'CREDIT'; amount: string; currency: string; balance_before: string; balance_after: string; wallet_version: number; created_at: string }>>(`
      SELECT id,transaction_id,direction,amount::text,currency,balance_before::text,balance_after::text,wallet_version,created_at
      FROM wallet_ledger WHERE wallet_id=? AND wallet_version>? AND wallet_version<=? ORDER BY wallet_version LIMIT ?`, [walletId, after, ceiling, limit]);
    return rows.map(row => ({ id: row.id, walletId, transactionId: row.transaction_id, direction: row.direction,
      money: { amount: row.amount, currency: row.currency }, balanceBefore: { amount: row.balance_before, currency: row.currency },
      balanceAfter: { amount: row.balance_after, currency: row.currency }, walletVersion: row.wallet_version, createdAt: new Date(row.created_at).toISOString() }));
  }
}
