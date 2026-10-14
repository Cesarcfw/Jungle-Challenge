import { DomainError } from './domain-error';
import { Money } from './money';

export type TransactionStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export interface BetProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  money: Money;
  kind?: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  referenceExternalTransactionId?: string;
}

export class WagerTransaction {
  private constructor(public readonly props: Readonly<BetProps>, private _status: TransactionStatus, private _failureCode: string | undefined) {}

  static create(props: BetProps): WagerTransaction {
    const kind = props.kind ?? 'BET';
    if (kind !== 'LOSS' && !props.money.isPositive()) throw new DomainError('INVALID_MOVEMENT_AMOUNT', 'Financial operation amount must be positive.');
    if ((kind === 'REFUND' || kind === 'ROLLBACK') && !props.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED', 'Reversals require referenceExternalTransactionId.');
    }
    if ((kind === 'BET' || kind === 'LOSS') && props.referenceExternalTransactionId) throw new DomainError('REFERENCE_NOT_ALLOWED', 'BET and LOSS do not accept a reference.');
    if (props.referenceExternalTransactionId === props.externalTransactionId) throw new DomainError('SELF_REFERENCE', 'A transaction cannot reference itself.');
    return new WagerTransaction(Object.freeze({ ...props }), 'PENDING', undefined);
  }

  static rehydrate(props: BetProps, status: TransactionStatus, failureCode?: string): WagerTransaction {
    return new WagerTransaction(Object.freeze({ ...props }), status, failureCode);
  }

  get status(): TransactionStatus { return this._status; }
  get failureCode(): string | undefined { return this._failureCode; }
  markProcessed(): void { this.assertPending(); this._status = 'PROCESSED'; }
  markPendingReference(): void { this.assertPending(); this._status = 'PENDING_REFERENCE'; }
  reject(code: string): void { this.assertPending(); this._status = 'REJECTED'; this._failureCode = code; }
  fail(code: string): void { this.assertPending(); this._status = 'FAILED'; this._failureCode = code; }
  affectsBalance(): boolean { return this.props.kind !== 'LOSS'; }
  requiresReference(): boolean { return this.props.kind === 'REFUND' || this.props.kind === 'ROLLBACK'; }
  ledgerDirectionFor(referenceDirection?: 'DEBIT' | 'CREDIT'): 'DEBIT' | 'CREDIT' {
    if (this.props.kind === 'ROLLBACK') {
      if (!referenceDirection) throw new DomainError('INVALID_REFERENCE', 'ROLLBACK needs the reference ledger direction.');
      return referenceDirection === 'DEBIT' ? 'CREDIT' : 'DEBIT';
    }
    return (this.props.kind ?? 'BET') === 'BET' ? 'DEBIT' : 'CREDIT';
  }
  matchesPayload(hash: string): boolean { return this.props.payloadHash === hash; }
  private assertPending(): void {
    if (this._status !== 'PENDING' && this._status !== 'PENDING_REFERENCE') throw new DomainError('INVALID_TRANSACTION_STATE', 'Terminal transactions cannot transition.');
  }
}
