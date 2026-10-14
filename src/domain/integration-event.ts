import type { MoneyProps } from './money';

export interface EventContext { eventId: string; aggregateId: string; correlationId: string; occurredAt: Date }
export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  protected constructor(protected readonly context: EventContext, protected readonly data: Readonly<T>) {}
  toJSON() {
    return { eventId: this.context.eventId, aggregateId: this.context.aggregateId,
      correlationId: this.context.correlationId, occurredAt: this.context.occurredAt.toISOString(),
      eventType: this.eventType, version: this.version, data: this.data };
  }
}

interface TransactionEventData { transactionId: string; walletId: string; providerId: string; failureCode?: string }
export class WagerTransactionProcessed extends IntegrationEvent<TransactionEventData> {
  readonly version = 1;
  readonly eventType = 'WagerTransactionProcessed';
  static from(context: EventContext, data: TransactionEventData): WagerTransactionProcessed { return new this(context, data); }
}
export class WagerTransactionRejected extends IntegrationEvent<TransactionEventData> {
  readonly version = 1;
  readonly eventType = 'WagerTransactionRejected';
  static from(context: EventContext, data: TransactionEventData): WagerTransactionRejected { return new this(context, data); }
}
export class WagerTransactionPendingReference extends IntegrationEvent<TransactionEventData> {
  readonly version = 1;
  readonly eventType = 'WagerTransactionPendingReference';
  static from(context: EventContext, data: TransactionEventData): WagerTransactionPendingReference { return new this(context, data); }
}
export class WagerTransactionFailed extends IntegrationEvent<TransactionEventData> {
  readonly version = 1;
  readonly eventType = 'WagerTransactionFailed';
  static from(context: EventContext, data: TransactionEventData): WagerTransactionFailed { return new this(context, data); }
}
interface BalanceEventData {
  walletId: string; transactionId: string; direction: 'DEBIT' | 'CREDIT'; money: MoneyProps;
  balanceBefore: MoneyProps; balanceAfter: MoneyProps; walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<BalanceEventData> {
  readonly version = 1;
  readonly eventType = 'WalletBalanceChanged';
  static from(context: EventContext, data: BalanceEventData): WalletBalanceChanged { return new this(context, data); }
}
