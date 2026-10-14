import type { MoneyProps } from '../domain/money';
import { DomainError } from '../domain/domain-error';

export interface BetInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_PAYLOAD', 'Expected an object.');
  return value as Record<string, unknown>;
}

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value !== value.trim()) {
    throw new DomainError('INVALID_PAYLOAD', `${name} must be a nonempty string, at most 256 characters, without surrounding whitespace.`);
  }
  return value;
}

export function uuid(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) {
    throw new DomainError('INVALID_PAYLOAD', `${name} must be a UUID.`);
  }
  return result.toLowerCase();
}

export function moneyProps(value: unknown): MoneyProps {
  const input = object(value);
  onlyKeys(input, ['amount', 'currency']);
  return { amount: text(input.amount, 'amount'), currency: text(input.currency, 'currency') };
}

export function onlyKeys(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some(key => !keys.includes(key))) throw new DomainError('INVALID_PAYLOAD', 'Unknown payload fields.');
}

export function betInput(value: unknown): BetInput {
  const input = object(value);
  onlyKeys(input, ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId']);
  if (!['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'].includes(String(input.kind))) throw new DomainError('INVALID_KIND', 'Unsupported operation. OPENING is internal.');
  return {
    providerId: text(input.providerId, 'providerId'), externalTransactionId: text(input.externalTransactionId, 'externalTransactionId'),
    playerId: uuid(input.playerId, 'playerId'), walletId: uuid(input.walletId, 'walletId'),
    roundId: text(input.roundId, 'roundId'), gameId: text(input.gameId, 'gameId'), kind: input.kind as BetInput['kind'], money: moneyProps(input.money),
    ...(input.referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId: text(input.referenceExternalTransactionId, 'referenceExternalTransactionId') } : {}),
  };
}
