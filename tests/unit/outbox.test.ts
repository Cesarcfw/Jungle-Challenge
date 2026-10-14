import { expect, test } from 'bun:test';
import { OutboxMessage } from '../../src/domain/outbox-message';
test('outbox backoff is bounded and publication is terminal', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const message = OutboxMessage.rehydrate({ id: 'event', aggregateId: 'wallet', eventType: 'Event', payload: { nested: { value: 'original' } }, occurredAt: now, attempts: 0 });
  expect(message.isDue(now)).toBe(true);
  message.scheduleRetry(now);
  expect(message.attempts).toBe(1); expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(2000);
  expect(message.isDue(now)).toBe(false);
  for (let i = 0; i < 20; i++) message.scheduleRetry(now);
  expect(message.nextAttemptAt!.getTime() - now.getTime()).toBe(60_000);
  (message.payload.nested as { value: string }).value = 'changed';
  expect((message.payload.nested as { value: string }).value).toBe('original');
  message.markPublished(now);
  expect(message.isPending()).toBe(false); expect(message.isDue(new Date(now.getTime() + 100_000))).toBe(false);
  expect(() => message.scheduleRetry(now)).toThrow(); expect(() => message.markPublished(now)).toThrow();
});
