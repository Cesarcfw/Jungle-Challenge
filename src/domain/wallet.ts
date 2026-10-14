import { DomainError } from './domain-error';
import { Money } from './money';
import { WalletLedgerEntry, type LedgerDirection } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

export class Wallet {
  private constructor(private state: WalletState) {
    this.state = { ...state, createdAt: new Date(state.createdAt), updatedAt: new Date(state.updatedAt) };
  }

  static open(props: { id: string; playerId: string; initialBalance: Money; at?: Date }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError('NEGATIVE_INITIAL_BALANCE', 'Initial balance cannot be negative.');
    }
    const at = props.at ?? new Date();
    return new Wallet({ id: props.id, playerId: props.playerId, balance: props.initialBalance, version: 1, createdAt: at, updatedAt: at });
  }

  static rehydrate(state: WalletState): Wallet { return new Wallet(state); }

  get id(): string { return this.state.id; }
  get playerId(): string { return this.state.playerId; }
  get currency(): string { return this.state.balance.currency; }
  get balance(): Money { return this.state.balance; }
  get version(): number { return this.state.version; }
  get createdAt(): Date { return new Date(this.state.createdAt); }
  get updatedAt(): Date { return new Date(this.state.updatedAt); }

  debit(money: Money, ctx: MovementContext, failureCode = 'INSUFFICIENT_FUNDS'): WalletLedgerEntry {
    return this.move('DEBIT', money, ctx, failureCode);
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    return this.move('CREDIT', money, ctx);
  }

  private move(direction: LedgerDirection, money: Money, ctx: MovementContext, failureCode = 'INSUFFICIENT_FUNDS'): WalletLedgerEntry {
    if (money.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Movement currency differs from wallet currency.');
    }
    if (!money.isPositive()) {
      throw new DomainError('INVALID_MOVEMENT_AMOUNT', 'Balance movements must be positive.');
    }
    const after = direction === 'CREDIT' ? this.balance.add(money) : this.balance.subtract(money);
    if (after.isNegative()) {
      throw new DomainError(failureCode, 'Movement would produce a negative balance.');
    }
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId, walletId: this.id, transactionId: ctx.transactionId,
      direction, money, balanceBefore: this.balance, balanceAfter: after, createdAt: ctx.at,
    });
    this.state = { ...this.state, balance: after, version: this.version + 1, updatedAt: new Date(ctx.at) };
    return entry;
  }
}
