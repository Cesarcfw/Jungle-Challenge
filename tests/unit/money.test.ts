import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  test('adds decimal values exactly without changing the operands', () => {
    const original = brl('0.10');
    expect(original.add(brl('0.20')).toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
    expect(original.toString()).toBe('0.10');
    expect(Object.isFrozen(original)).toBe(true);
  });

  test('preserves values beyond JavaScript safe integer precision', () => {
    expect(brl('9007199254740993.00').add(brl('0.01')).toString()).toBe('9007199254740993.01');
  });

  test('supports signed internal arithmetic and fixed-scale serialization', () => {
    expect(brl('1.00').subtract(brl('2.25')).toString()).toBe('-1.25');
    expect(brl('2.25').negate().toString()).toBe('-2.25');
    expect(Money.zero('BRL').toString()).toBe('0.00');
  });

  test.each(['NaN', 'Infinity', '1e2', '', '-1.00', '1.001', '1', '1.0', ' 1.00', '+1.00', '1,00'])('rejects invalid input %p instead of silently rounding', (amount) => {
    expect(() => brl(amount)).toThrow();
  });

  test('rejects numeric input at runtime', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow();
  });

  test('rejects unsupported currency codes', () => {
    expect(() => Money.zero('ZZZ')).toThrow();
  });

  test('rejects currency conflicts for arithmetic and comparisons', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow();
    expect(() => brl('1.00').subtract(usd)).toThrow();
    expect(() => brl('1.00').equals(usd)).toThrow();
    expect(() => brl('1.00').isLessThan(usd)).toThrow();
  });

  test('checks signs and exact comparisons', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('1.00').isPositive()).toBe(true);
    expect(brl('1.00').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('2.00'))).toBe(true);
    expect(brl('1.00').equals(brl('01.00'))).toBe(true);
  });

  test('rejects input and arithmetic beyond database precision', () => {
    expect(() => brl('1000000000000000000.00')).toThrow();
    expect(() => brl('999999999999999999.99').add(brl('0.01'))).toThrow();
  });
});
