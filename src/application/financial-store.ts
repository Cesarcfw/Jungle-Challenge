import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { MoneyProps } from '../domain/money';
import type { BetInput } from './contracts';
import type { IntegrationEvent } from '../domain/integration-event';
export interface InboxContext { consumerName: string; messageId: string; payloadHash: string }

export interface TransactionResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';
  balance: MoneyProps;
  failureCode?: string;
}
export interface StoredTransaction {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  result: TransactionResult;
  input: Omit<BetInput, 'kind'> & { kind: BetInput['kind'] | 'OPENING' };
  reference_transaction_id: string | null;
  reference_attempts: number;
  created_at: Date;
  next_reference_attempt_at: Date | null;
  ledger_direction: 'DEBIT' | 'CREDIT' | null;
}
export interface TransactionWrite {
  id: string; input: Omit<BetInput, 'kind'> & { kind: BetInput['kind'] | 'OPENING' };
  idempotencyKey: string; payloadHash: string; result: TransactionResult; at: Date;
  referenceTransactionId?: string;
  referenceAttempts?: number;
  nextReferenceAttemptAt?: Date;
}
export interface FinancialSession {
  receiveInbox(context: InboxContext): Promise<void>;
  markInboxProcessed(context: InboxContext): Promise<void>;
  lockWallet(id: string): Promise<Wallet | null>;
  findTransaction(key: string, provider: string, external: string): Promise<StoredTransaction[]>;
  insertTransaction(transaction: TransactionWrite): Promise<boolean>;
  updateTransaction(transaction: TransactionWrite): Promise<void>;
  findReference(provider: string, external: string): Promise<StoredTransaction | null>;
  alreadyReversed(id: string, kind: string): Promise<boolean>;
  saveWallet(wallet: Wallet, insert: boolean): Promise<void>;
  insertLedger(entry: WalletLedgerEntry, version: number): Promise<void>;
  enqueue(event: IntegrationEvent<object>): Promise<void>;
}
export interface FinancialStore {
  transaction<T>(work: (session: FinancialSession) => Promise<T>): Promise<T>;
  getWallet(id: string): Promise<Wallet | null>;
  getTransaction(id: string): Promise<StoredTransaction | null>;
  dueReferences(now: Date): Promise<StoredTransaction[]>;
  getExternalTransaction(providerId: string, externalId: string): Promise<StoredTransaction | null>;
  reconcile(walletId: string): Promise<Reconciliation | null>;
  ledger(walletId: string, after: number, ceiling: number, limit: number): Promise<LedgerItem[]>;
}

export interface Reconciliation {
  walletId: string; storedBalance: MoneyProps; calculatedBalance: MoneyProps; difference: MoneyProps;
  consistent: boolean; checkedEntries: number;
}
export interface LedgerItem {
  id: string; walletId: string; transactionId: string; direction: 'DEBIT' | 'CREDIT'; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number; createdAt: string;
}
