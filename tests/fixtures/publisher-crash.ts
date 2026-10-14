import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { sqsClient } from '../../src/infrastructure/messaging/sqs';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required.');
const orm = await MikroORM.init(databaseConfig(url));
const publisher = new OutboxPublisher(orm, sqsClient(), process.env.TEST_EVENTS_URL!,
  { aggregateId: process.env.TEST_AGGREGATE_ID!, afterSend: async () => { process.exit(114); } });
await publisher.publishBatch(1);
throw new Error('Expected crash after publish.');
