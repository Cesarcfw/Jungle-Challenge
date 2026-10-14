import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../domain/domain-error';

export interface LedgerCursor { version: 1; walletId: string; afterVersion: number; ceilingVersion: number }
export class LedgerCursorCodec {
  constructor(private readonly secret = process.env.CURSOR_SECRET ?? 'local-development-cursor-key-change-before-production') {}
  encode(cursor: LedgerCursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${this.sign(payload).toString('base64url')}`;
  }
  decode(value: string, walletId: string): LedgerCursor {
    try {
      if (value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const [payload, signature] = value.split('.');
      const supplied = Buffer.from(signature!, 'base64url');
      const expected = this.sign(payload!);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
      const cursor = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as LedgerCursor;
      if (cursor.version !== 1 || cursor.walletId !== walletId || !Number.isInteger(cursor.afterVersion) || !Number.isInteger(cursor.ceilingVersion) ||
          cursor.afterVersion < 0 || cursor.ceilingVersion < 1 || cursor.afterVersion > cursor.ceilingVersion || cursor.ceilingVersion > 2147483647) throw new Error();
      return cursor;
    } catch { throw new DomainError('INVALID_CURSOR', 'Invalid ledger cursor or wallet binding.'); }
  }
  private sign(payload: string): Buffer { return createHmac('sha256', this.secret).update(payload).digest(); }
}
