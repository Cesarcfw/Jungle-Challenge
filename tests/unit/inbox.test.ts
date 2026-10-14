import { expect, test } from 'bun:test';
import { InboxMessage } from '../../src/domain/inbox-message';
test('inbox detects payload conflicts and protects processed state', () => {
  const inbox = InboxMessage.receive('message', 'consumer', 'hash');
  expect(inbox.matchesPayload('hash')).toBe(true);
  expect(inbox.matchesPayload('changed')).toBe(false);
  expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(new Date('2026-10-13T12:00:00Z'));
  expect(inbox.isProcessed()).toBe(true);
  inbox.processedAt!.setFullYear(1990);
  expect(inbox.processedAt!.getUTCFullYear()).toBe(2026);
  expect(() => inbox.markProcessed(new Date())).toThrow();
});
