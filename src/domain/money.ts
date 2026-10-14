import Decimal from 'decimal.js';
import { DomainError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// NUMERIC(20,2): 18 integer digits. Extra precision protects intermediate sums.
const ExactDecimal = Decimal.clone({ precision: 40 });
const MAX_AMOUNT = new ExactDecimal('999999999999999999.99');
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^\d+\.\d{2}$/.test(props.amount)) {
      throw new DomainError('INVALID_AMOUNT', 'Amount must be a nonnegative decimal string with exactly two places.');
    }
    if (!CURRENCIES.has(props.currency)) {
      throw new DomainError('INVALID_CURRENCY', 'Currency must be a supported ISO-4217 code.');
    }
    return Money.checked(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  /** Database/report values may be signed; input contracts still use from(). */
  static rehydrate(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^-?\d+\.\d{2}$/.test(props.amount) || !CURRENCIES.has(props.currency)) {
      throw new DomainError('INVALID_PERSISTED_MONEY', 'Invalid persisted decimal or currency.');
    }
    return Money.checked(new ExactDecimal(props.amount), props.currency);
  }

  private static checked(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(MAX_AMOUNT)) {
      throw new DomainError('AMOUNT_OUT_OF_RANGE', 'Amount exceeds NUMERIC(20,2) capacity.');
    }
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.value.sub(other.value), this.currency);
  }

  negate(): Money { return Money.checked(this.value.negated(), this.currency); }
  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.greaterThan('0'); }
  isNegative(): boolean { return this.value.lessThan('0'); }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
  toString(): string { return this.value.toFixed(2); }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Money currencies must match.');
    }
  }
}
