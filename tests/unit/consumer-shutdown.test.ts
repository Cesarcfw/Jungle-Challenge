import { expect, test } from 'bun:test';
import { SQSClient, type Message } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { WageringService } from '../../src/application/wagering-service';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';

test('shutdown waits for every handler even when another handler rejects', async () => {
  const client = new SQSClient({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  let receives = 0;
  client.middlewareStack.add(() => async () => {
    receives++;
    return { response: {}, output: { $metadata: {}, Messages: [{ MessageId: 'failed' }, { MessageId: 'slow' }] } };
  }, { step: 'initialize', name: 'controlledReceive' });
  const failure = new Error('Acknowledgment and visibility update unavailable');
  let fail!: () => void;
  let release!: () => void;
  let notify!: () => void;
  const failed = new Promise<void>((_, reject) => { fail = () => reject(failure); });
  const slow = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { notify = resolve; });
  let handlerFinished = false;
  // Only batch coordination is under test; controlled handlers replace financial I/O.
  class ControlledConsumer extends WagerConsumer {
    override async handle(message: Message): Promise<void> {
      if (message.MessageId === 'failed') return failed;
      notify();
      await slow;
      handlerFinished = true;
    }
  }
  const consumer = new ControlledConsumer({} as MikroORM, {} as WageringService, client,
    { requests: 'requests', dlq: 'dlq', events: 'events' });
  let stopped = false;
  let stopping: Promise<void> | undefined;
  try {
    consumer.start();
    await entered;
    fail();
    stopping = consumer.stop().then(() => { stopped = true; });
    // Let rejection propagation and the run-loop shutdown finish if they can.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(handlerFinished).toBe(false);
    expect(receives).toBe(1);
    release();
    await stopping;
    expect(handlerFinished).toBe(true);
    expect(stopped).toBe(true);
  } finally {
    release();
    await stopping;
    await consumer.stop();
    client.destroy();
  }
});
