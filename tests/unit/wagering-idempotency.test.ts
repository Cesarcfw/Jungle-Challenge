import { expect, test } from 'bun:test';
import type { BetInput } from '../../src/application/contracts';
import type { FinancialSession, FinancialStore, StoredTransaction } from '../../src/application/financial-store';
import { payloadHash } from '../../src/application/payload-hash';
import { WageringService } from '../../src/application/wagering-service';
import { DomainError } from '../../src/domain/domain-error';

const input: BetInput = { providerId: 'provider', externalTransactionId: 'external', playerId: 'player', walletId: 'wallet',
  roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' } };
const original: StoredTransaction = { id: 'transaction', idempotency_key: 'same-key', payload_hash: payloadHash(input), input,
  result: { transactionId: 'transaction', status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } },
  reference_transaction_id: null, reference_attempts: 0, created_at: new Date(), next_reference_attempt_at: null, ledger_direction: 'DEBIT' };

function serviceWithOriginal(): WageringService {
  // Unexpected access (including financial writes) fails immediately.
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected persistence operation during replay/conflict'); };
  const session: FinancialSession = {
    findTransaction: async () => [original], receiveInbox: unexpected, markInboxProcessed: unexpected,
    lockWallet: unexpected, insertTransaction: unexpected, updateTransaction: unexpected,
    findReference: unexpected, alreadyReversed: unexpected, saveWallet: unexpected, insertLedger: unexpected, enqueue: unexpected,
  };
  const store: FinancialStore = {
    transaction: async <T>(work: (session: FinancialSession) => Promise<T>) => work(session),
    getWallet: unexpected, getTransaction: unexpected, dueReferences: unexpected,
    getExternalTransaction: unexpected, reconcile: unexpected, ledger: unexpected,
  };
  return new WageringService(store);
}

test('same idempotency key with divergent business payload is a conflict without financial writes', async () => {
  try {
    await serviceWithOriginal().bet({ ...input, money: { amount: '26.00', currency: 'BRL' } }, 'same-key', 'correlation');
    throw new Error('Expected idempotency conflict');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('IDEMPOTENCY_CONFLICT');
  }
});

test('same key and business payload replay the original balance despite different transport correlation', async () => {
  expect(await serviceWithOriginal().bet(input, 'same-key', 'new-correlation')).toEqual({ ...original.result, idempotentReplay: true });
});
