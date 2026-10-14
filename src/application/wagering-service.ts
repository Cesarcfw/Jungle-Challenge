import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/domain-error';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference, WagerTransactionFailed } from '../domain/integration-event';
import type { BetInput } from './contracts';
import type { FinancialStore, FinancialSession, StoredTransaction, TransactionResult, InboxContext } from './financial-store';
import { payloadHash } from './payload-hash';
import { LedgerCursorCodec } from './ledger-cursor';
import { silentTelemetry, type Telemetry } from './telemetry';

export class WageringService {
  constructor(private readonly store: FinancialStore, private readonly telemetry: Telemetry = silentTelemetry, private readonly cursors = new LedgerCursorCodec()) {}

  async createWallet(playerId: string, initialBalance: MoneyProps, correlationId: string) {
    const money = Money.from(initialBalance);
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance: money });
    return this.store.transaction(async session => {
      await session.saveWallet(wallet, true);
      if (money.isPositive()) {
        const id = randomUUID();
        const at = new Date();
        const input = { providerId: '__internal__', externalTransactionId: wallet.id, playerId, walletId: wallet.id,
          roundId: '__opening__', gameId: '__opening__', kind: 'OPENING' as const, money: money.toJSON() };
        const result: TransactionResult = { transactionId: id, status: 'PROCESSED', balance: money.toJSON() };
        await session.insertTransaction({ id, input, idempotencyKey: `opening:${wallet.id}`, payloadHash: payloadHash(input), result, at });
        const entry = WalletLedgerEntry.create({ id: randomUUID(), walletId: wallet.id, transactionId: id,
          direction: 'CREDIT', money, balanceBefore: Money.zero(wallet.currency), balanceAfter: money, createdAt: at });
        await session.insertLedger(entry, 1);
        await this.events(session, result, wallet, entry, '__internal__', correlationId, at);
      }
      return this.walletJSON(wallet);
    });
  }

  async bet(input: BetInput, idempotencyKey: string, correlationId: string, retry?: { id: string; now: Date }, inbox?: InboxContext): Promise<TransactionResult & { idempotentReplay: boolean }> {
    const started = performance.now();
    if (input.providerId === '__internal__') throw new DomainError('INVALID_PROVIDER', 'Reserved provider identity.');
    const money = Money.from(input.money);
    const normalized = { ...input, money: money.toJSON() };
    const hash = payloadHash(normalized);
    // Creation validates contracts before persistence; worker rehydrates under the wallet lock.
    let wager = WagerTransaction.create({ ...input, id: retry?.id ?? randomUUID(), idempotencyKey, payloadHash: hash, money });
    try {
    const result = await this.store.transaction(async session => {
      if (inbox) await session.receiveInbox(inbox);
      const apply = async () => {
      const existing = await session.findTransaction(idempotencyKey, input.providerId, input.externalTransactionId);
      if (existing.length && !retry) return this.replay(existing, idempotencyKey, hash);
      const wallet = await session.lockWallet(input.walletId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found.');
      const afterLock = await session.findTransaction(idempotencyKey, input.providerId, input.externalTransactionId);
      if (afterLock.length && !retry) return this.replay(afterLock, idempotencyKey, hash);
      let previous: StoredTransaction | undefined;
      const at = retry?.now ?? new Date();
      if (retry) {
        this.replay(afterLock, idempotencyKey, hash);
        previous = afterLock[0];
        if (!previous || previous.id !== retry.id || previous.result.status !== 'PENDING_REFERENCE' ||
            (previous.next_reference_attempt_at && previous.next_reference_attempt_at > at)) {
          return this.replay(afterLock, idempotencyKey, hash);
        }
        wager = WagerTransaction.rehydrate(wager.props, 'PENDING_REFERENCE');
      }
      let entry: WalletLedgerEntry | undefined;
      let reference: StoredTransaction | null = null;
      try {
        if (wallet.playerId !== input.playerId) throw new DomainError('PLAYER_MISMATCH', 'Player does not own wallet.');
        if (wallet.currency !== money.currency) throw new DomainError('CURRENCY_MISMATCH', 'Operation currency differs from wallet currency.');
        if (previous && at.getTime() - previous.created_at.getTime() >= 24 * 60 * 60 * 1000) {
          throw new DomainError('REFERENCE_EXPIRED', 'Reference wait exceeded 24 hours.');
        }
        if (input.referenceExternalTransactionId) {
          reference = await session.findReference(input.providerId, input.referenceExternalTransactionId);
          if (!reference || reference.result.status === 'PENDING_REFERENCE') {
            wager.markPendingReference();
          } else {
            this.validateReference(input, reference);
            if (wager.requiresReference() && await session.alreadyReversed(reference.id, input.kind)) {
              throw new DomainError('REFERENCE_ALREADY_REVERSED', 'Reference already reversed by this operation type.');
            }
          }
        }
        if (wager.status !== 'PENDING_REFERENCE' || (reference && reference.result.status === 'PROCESSED')) {
          if (wager.affectsBalance()) {
            const direction = wager.ledgerDirectionFor(reference?.ledger_direction ?? undefined);
            const ctx = { entryId: randomUUID(), transactionId: wager.props.id, at };
            entry = direction === 'CREDIT' ? wallet.credit(money, ctx) : wallet.debit(money, ctx, input.kind === 'ROLLBACK' ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
          }
          wager.markProcessed();
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        wager.reject(error.code);
      }
      const result: TransactionResult = { transactionId: wager.props.id, status: wager.status as TransactionResult['status'], balance: wallet.balance.toJSON(),
        ...(wager.failureCode ? { failureCode: wager.failureCode } : {}) };
      const attempts = (previous?.reference_attempts ?? 0) + (previous ? 1 : 0);
      const write = { id: wager.props.id, input: normalized, idempotencyKey, payloadHash: hash, result, at,
        ...(reference ? { referenceTransactionId: reference.id } : {}), referenceAttempts: attempts,
        ...(result.status === 'PENDING_REFERENCE' ? { nextReferenceAttemptAt: new Date(at.getTime() + Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8))) } : {}) };
      if (previous) await session.updateTransaction(write);
      else if (!await session.insertTransaction(write)) return this.replay(await session.findTransaction(idempotencyKey, input.providerId, input.externalTransactionId), idempotencyKey, hash);
      if (entry) {
        await session.saveWallet(wallet, false);
        await session.insertLedger(entry, wallet.version);
      }
      if (!previous || result.status !== 'PENDING_REFERENCE') await this.events(session, result, wallet, entry, input.providerId, correlationId, at);
      return { ...result, idempotentReplay: false };
      };
      const result = await apply();
      if (inbox) await session.markInboxProcessed(inbox);
      return result;
    });
    this.telemetry.wager(input.kind, result.status, result.idempotentReplay, (performance.now() - started) / 1000);
    if (result.idempotentReplay) this.telemetry.duplicate(inbox ? 'sqs' : 'http');
    this.telemetry.log('info', 'WAGER_RESULT', { correlationId, ...(inbox ? { messageId: inbox.messageId } : {}), transactionId: result.transactionId, walletId: input.walletId, providerId: input.providerId },
      { kind: input.kind, status: result.status, idempotentReplay: result.idempotentReplay });
    return result;
    } catch (error) {
      const code = error instanceof DomainError ? error.code : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'INTERNAL_ERROR';
      this.telemetry.failure(code);
      if (['IDEMPOTENCY_CONFLICT','INBOX_PAYLOAD_CONFLICT'].includes(code)) this.telemetry.duplicate('conflict');
      this.telemetry.log('warn', code, { correlationId, ...(inbox ? { messageId: inbox.messageId } : {}), walletId: input.walletId, providerId: input.providerId }, { kind: input.kind });
      throw error;
    }
  }

  private validateReference(input: BetInput, reference: StoredTransaction): void {
    const ref = reference.input;
    if (reference.result.status !== 'PROCESSED') throw new DomainError('REFERENCE_NOT_PROCESSED', 'Referenced transaction was not processed.');
    if (ref.playerId !== input.playerId || ref.walletId !== input.walletId || ref.roundId !== input.roundId || ref.money.currency !== input.money.currency) {
      throw new DomainError('REFERENCE_IDENTITY_MISMATCH', 'Reference must share provider, player, wallet, currency and round.');
    }
    if ((input.kind === 'REFUND' || input.kind === 'WIN') && ref.kind !== 'BET') throw new DomainError('INVALID_REFERENCE_KIND', 'REFUND and referenced WIN require BET.');
    if (input.kind === 'ROLLBACK' && !['BET', 'WIN', 'REFUND'].includes(ref.kind)) throw new DomainError('INVALID_REFERENCE_KIND', 'ROLLBACK requires BET, WIN or REFUND.');
    if ((input.kind === 'REFUND' || input.kind === 'ROLLBACK') && !Money.from(input.money).equals(Money.from(ref.money))) {
      throw new DomainError('REFERENCE_AMOUNT_MISMATCH', 'Partial reversals are unsupported.');
    }
  }

  async failSubmission(input: BetInput, key: string, correlationId: string, code: string, inbox?: InboxContext): Promise<void> {
    const started = performance.now();
    const money = Money.from(input.money);
    const normalized = { ...input, money: money.toJSON() };
    const hash = payloadHash(normalized);
    const wager = WagerTransaction.create({ ...input, money, id: randomUUID(), idempotencyKey: key, payloadHash: hash });
    const created = await this.store.transaction(async session => {
      if (inbox) await session.receiveInbox(inbox);
      const existing = await session.findTransaction(key, input.providerId, input.externalTransactionId);
      if (existing.length) { this.replay(existing, key, hash); if (inbox) await session.markInboxProcessed(inbox); return; }
      const wallet = await session.lockWallet(input.walletId);
      if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found.');
      const afterLock = await session.findTransaction(key, input.providerId, input.externalTransactionId);
      if (afterLock.length) { this.replay(afterLock, key, hash); if (inbox) await session.markInboxProcessed(inbox); return; }
      wager.fail(code);
      const at = new Date();
      const result: TransactionResult = { transactionId: wager.props.id, status: 'FAILED', failureCode: code, balance: wallet.balance.toJSON() };
      if (!await session.insertTransaction({ id: wager.props.id, input: normalized, idempotencyKey: key, payloadHash: hash, result, at })) {
        this.replay(await session.findTransaction(key, input.providerId, input.externalTransactionId), key, hash);
        if (inbox) await session.markInboxProcessed(inbox);
        return;
      }
      await this.events(session, result, wallet, undefined, input.providerId, correlationId, at);
      if (inbox) await session.markInboxProcessed(inbox);
      return { transactionId: result.transactionId };
    });
    if (created) {
      this.telemetry.wager(input.kind, 'FAILED', false, (performance.now() - started) / 1000);
      this.telemetry.log('error', code, { correlationId, messageId: correlationId, transactionId: created.transactionId, walletId: input.walletId, providerId: input.providerId }, { kind: input.kind, status: 'FAILED' });
    }
  }

  async reprocessReferences(now = new Date()): Promise<number> {
    const due = await this.store.dueReferences(now);
    for (const pending of due) {
      if (pending.input.kind === 'OPENING') throw new Error('Internal OPENING cannot wait on a reference.');
      this.telemetry.retry('reference');
      await this.bet(pending.input as BetInput, pending.idempotency_key, pending.id, { id: pending.id, now });
    }
    return due.length;
  }

  private replay(rows: StoredTransaction[], key: string, hash: string): TransactionResult & { idempotentReplay: boolean } {
    const original = rows[0];
    if (rows.length !== 1 || !original || original.idempotency_key !== key || original.payload_hash !== hash) {
      throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key or external identity conflicts with an existing transaction.');
    }
    return { ...original.result, idempotentReplay: true };
  }

  async getWallet(id: string) {
    const wallet = await this.store.getWallet(id);
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found.');
    return this.walletJSON(wallet);
  }

  async getTransaction(id: string) {
    const transaction = await this.store.getTransaction(id);
    if (!transaction) throw new DomainError('TRANSACTION_NOT_FOUND', 'Transaction not found.');
    return transaction.result;
  }

  async getExternalTransaction(providerId: string, externalId: string) {
    const transaction = await this.store.getExternalTransaction(providerId, externalId);
    if (!transaction) throw new DomainError('TRANSACTION_NOT_FOUND', 'Transaction not found.');
    return transaction.result;
  }
  async reconcile(walletId: string, correlationId: string) {
    const report = await this.store.reconcile(walletId);
    if (!report) throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found.');
    this.telemetry.reconciliation(report.consistent);
    this.telemetry.log(report.consistent ? 'info' : 'error', report.consistent ? 'RECONCILIATION_OK' : 'RECONCILIATION_DIVERGENCE', { correlationId, walletId },
      { consistent: report.consistent, checkedEntries: report.checkedEntries });
    return report;
  }
  async ledger(walletId: string, limit: number, cursor?: string) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID_LIMIT', 'Ledger limit must be between 1 and 100.');
    const wallet = await this.store.getWallet(walletId);
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found.');
    const position = cursor ? this.cursors.decode(cursor, walletId) : { version: 1 as const, walletId, afterVersion: 0, ceilingVersion: wallet.version };
    const rows = await this.store.ledger(walletId, position.afterVersion, position.ceilingVersion, limit + 1);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: rows.length > limit && last ? this.cursors.encode({ ...position, afterVersion: last.walletVersion }) : null };
  }

  private walletJSON(wallet: Wallet) { return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version }; }

  private async events(session: FinancialSession, result: TransactionResult, wallet: Wallet, entry: WalletLedgerEntry | undefined,
    providerId: string, correlationId: string, occurredAt: Date): Promise<void> {
    const context = () => ({ eventId: randomUUID(), aggregateId: wallet.id, correlationId, occurredAt });
    const data = { transactionId: result.transactionId, walletId: wallet.id, providerId, ...(result.failureCode ? { failureCode: result.failureCode } : {}) };
    const event = result.status === 'PROCESSED' ? WagerTransactionProcessed.from(context(), data) : result.status === 'PENDING_REFERENCE' ? WagerTransactionPendingReference.from(context(), data) : result.status === 'FAILED' ? WagerTransactionFailed.from(context(), data) : WagerTransactionRejected.from(context(), data);
    await session.enqueue(event);
    if (entry) {
      await session.enqueue(WalletBalanceChanged.from(context(), { walletId: wallet.id, transactionId: entry.transactionId,
        direction: entry.direction, money: entry.money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(), balanceAfter: entry.balanceAfter.toJSON(), walletVersion: wallet.version }));
    }
  }
}
