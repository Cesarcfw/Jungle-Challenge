import { expect, test } from 'bun:test';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { Money } from '../../src/domain/money';
import { canonicalJSON, payloadHash } from '../../src/application/payload-hash';

const props = { id: 'tx', providerId: 'provider', externalTransactionId: 'ext', idempotencyKey: 'key', payloadHash: 'hash',
  walletId: 'wallet', playerId: 'player', roundId: 'round', gameId: 'game', money: Money.from({ amount: '1.00', currency: 'BRL' }) };

test('processed and rejected states cannot transition again', () => {
  const processed = WagerTransaction.create(props);
  processed.markProcessed();
  expect(() => processed.reject('INSUFFICIENT_FUNDS')).toThrow();
  const rejected = WagerTransaction.create(props);
  rejected.reject('INSUFFICIENT_FUNDS');
  expect(rejected.failureCode).toBe('INSUFFICIENT_FUNDS');
  expect(() => rejected.markProcessed()).toThrow();
});
test('BET cannot be zero', () => {
  expect(() => WagerTransaction.create({ ...props, money: Money.zero('BRL') })).toThrow();
});
test('canonical hashing ignores object key order and detects changed business values', () => {
  const a = { money: { amount: '1.00', currency: 'BRL' }, kind: 'BET' };
  const b = { kind: 'BET', money: { currency: 'BRL', amount: '1.00' } };
  expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  expect(payloadHash(a)).toBe(payloadHash(b));
  expect(payloadHash(a)).not.toBe(payloadHash({ ...a, kind: 'WIN' }));
});
test('LOSS permits zero and does not affect balance', () => {
  const loss = WagerTransaction.create({ ...props, kind: 'LOSS', money: Money.zero('BRL') });
  expect(loss.affectsBalance()).toBe(false);
  loss.markProcessed();
  expect(loss.status).toBe('PROCESSED');
});
test('WIN credits and BET debits', () => {
  expect(WagerTransaction.create({ ...props, kind: 'WIN' }).ledgerDirectionFor()).toBe('CREDIT');
  expect(WagerTransaction.create(props).ledgerDirectionFor()).toBe('DEBIT');
});
test('REFUND requires reference and credits', () => {
  expect(() => WagerTransaction.create({ ...props, kind: 'REFUND' })).toThrow();
  const refund = WagerTransaction.create({ ...props, kind: 'REFUND', referenceExternalTransactionId: 'bet' });
  expect(refund.requiresReference()).toBe(true);
  expect(refund.ledgerDirectionFor()).toBe('CREDIT');
});
test('ROLLBACK requires reference and inverts its ledger direction', () => {
  expect(() => WagerTransaction.create({ ...props, kind: 'ROLLBACK' })).toThrow();
  const rollback = WagerTransaction.create({ ...props, kind: 'ROLLBACK', referenceExternalTransactionId: 'win' });
  expect(rollback.ledgerDirectionFor('CREDIT')).toBe('DEBIT');
  expect(rollback.ledgerDirectionFor('DEBIT')).toBe('CREDIT');
  expect(() => rollback.ledgerDirectionFor()).toThrow();
});
test('pending reference may resolve or reject but terminal states remain immutable', () => {
  const tx = WagerTransaction.create({ ...props, kind: 'REFUND', referenceExternalTransactionId: 'bet' });
  tx.markPendingReference();
  expect(tx.status).toBe('PENDING_REFERENCE');
  tx.markProcessed();
  expect(() => tx.markPendingReference()).toThrow();
  const failed = WagerTransaction.create(props);
  failed.fail('PERMANENT_INFRASTRUCTURE_ERROR');
  expect(() => failed.markProcessed()).toThrow();
});
