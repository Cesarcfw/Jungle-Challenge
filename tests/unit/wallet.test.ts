import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const ctx = { entryId: 'entry-1', transactionId: 'tx-1', at: new Date('2026-10-13T12:00:00Z') };
const wallet = () => Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl('100.00') });

describe('Wallet and ledger', () => {
  test('opening initializes version one', () => {
    expect(wallet().version).toBe(1);
    expect(wallet().balance.toString()).toBe('100.00');
  });

  test('debit produces a balanced immutable ledger entry', () => {
    const w = wallet();
    const entry = w.debit(brl('80.00'), ctx);
    expect(w.balance.toString()).toBe('20.00');
    expect(w.version).toBe(2);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.equals(w.balance)).toBe(true);
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });

  test('rejecting a debit preserves wallet state and version', () => {
    const w = wallet();
    expect(() => w.debit(brl('100.01'), ctx)).toThrow();
    expect(w.balance.toString()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('reversal insufficiency has a distinct failure code', () => {
    expect(() => wallet().debit(brl('200.00'), ctx, 'REVERSAL_INSUFFICIENT_FUNDS')).toThrow(
      expect.objectContaining({ code: 'REVERSAL_INSUFFICIENT_FUNDS' }),
    );
  });

  test('credit increments version and returns matching ledger', () => {
    const w = wallet();
    const entry = w.credit(brl('25.00'), ctx);
    expect(w.balance.toString()).toBe('125.00');
    expect(w.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.isBalanced()).toBe(true);
  });

  test('currency mismatch and zero movements preserve state', () => {
    const w = wallet();
    expect(() => w.credit(Money.from({ amount: '1.00', currency: 'USD' }), ctx)).toThrow();
    expect(() => w.debit(brl('0.00'), ctx)).toThrow();
    expect(w.version).toBe(1);
  });

  test('rejects negative opening and inconsistent ledger arithmetic', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate() })).toThrow();
    expect(() => WalletLedgerEntry.create({ id: 'e', walletId: 'w', transactionId: 't', direction: 'DEBIT', money: brl('1.00'), balanceBefore: brl('100.00'), balanceAfter: brl('100.00'), createdAt: ctx.at })).toThrow();
  });

  test('defensive date copies protect persisted state', () => {
    const w = wallet();
    const entry = w.credit(brl('1.00'), ctx);
    entry.createdAt.setFullYear(1990);
    w.updatedAt.setFullYear(1990);
    expect(entry.createdAt.getUTCFullYear()).toBe(2026);
    expect(w.updatedAt.getUTCFullYear()).toBe(2026);
  });
});
