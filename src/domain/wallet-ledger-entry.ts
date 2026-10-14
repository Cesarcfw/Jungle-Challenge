import { DomainError } from './domain-error';
import { Money } from './money';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(private readonly state: LedgerEntryState) {
    this.state = Object.freeze({ ...state, createdAt: new Date(state.createdAt) });
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.money.isPositive() || state.balanceBefore.isNegative() || state.balanceAfter.isNegative()) {
      throw new DomainError('INVALID_LEDGER_ENTRY', 'Ledger entries require positive movement and nonnegative balances.');
    }
    const entry = new WalletLedgerEntry(state);
    if (!entry.isBalanced()) {
      throw new DomainError('UNBALANCED_LEDGER_ENTRY', 'Ledger arithmetic does not match balances.');
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry { return new WalletLedgerEntry(state); }

  get id(): string { return this.state.id; }
  get walletId(): string { return this.state.walletId; }
  get transactionId(): string { return this.state.transactionId; }
  get direction(): LedgerDirection { return this.state.direction; }
  get money(): Money { return this.state.money; }
  get balanceBefore(): Money { return this.state.balanceBefore; }
  get balanceAfter(): Money { return this.state.balanceAfter; }
  get createdAt(): Date { return new Date(this.state.createdAt); }

  isBalanced(): boolean {
    const expected = this.direction === 'CREDIT'
      ? this.balanceBefore.add(this.money)
      : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
