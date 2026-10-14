import { expect, test } from 'bun:test';
import { LedgerCursorCodec } from '../../src/application/ledger-cursor';
import { routeTemplate } from '../../src/http/audit-middleware';
test('ledger cursor is signed, versioned, bound to wallet and portable between instances', () => {
  const codec = new LedgerCursorCodec('test-secret');
  const state = { version: 1 as const, walletId: 'wallet', afterVersion: 2, ceilingVersion: 5 };
  const cursor = codec.encode(state);
  expect(new LedgerCursorCodec('test-secret').decode(cursor, 'wallet')).toEqual(state);
  expect(() => codec.decode(cursor, 'other-wallet')).toThrow();
  expect(() => new LedgerCursorCodec('different-secret').decode(cursor, 'wallet')).toThrow();
  expect(() => codec.decode(cursor + '.extra', 'wallet')).toThrow();
});
test('cursor rejects a forged payload even when it is valid base64 and JSON', () => {
  const codec = new LedgerCursorCodec('secret');
  const cursor = codec.encode({ version: 1, walletId: 'w', afterVersion: 1, ceilingVersion: 2 });
  const signature = cursor.split('.')[1]!;
  const forgedPayload = Buffer.from(JSON.stringify({ version: 1, walletId: 'w', afterVersion: 1, ceilingVersion: 999 })).toString('base64url');
  expect(() => codec.decode(`${forgedPayload}.${signature}`, 'w')).toThrow();
});
test('HTTP route labels omit user identifiers and query strings', () => {
  expect(routeTemplate('/wallets/secret-wallet/ledger?cursor=secret')).toBe('/wallets/:walletId/ledger');
  expect(routeTemplate('/providers/provider-id/wagering/transactions/external-id')).toBe('/providers/:providerId/wagering/transactions/:externalTransactionId');
  expect(routeTemplate('/secret-token')).toBe('unmatched');
});
