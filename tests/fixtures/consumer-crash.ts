import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/config';
import { sqsClient } from '../../src/infrastructure/messaging/sqs';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { WageringService } from '../../src/application/wagering-service';
import { PostgresFinancialStore } from '../../src/infrastructure/database/postgres-financial-store';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated test database required.');
const orm = await MikroORM.init(databaseConfig(url));
const queues = JSON.parse(process.env.TEST_QUEUE_URLS!) as { requests: string; dlq: string; events: string };
const consumer = new WagerConsumer(orm, new WageringService(new PostgresFinancialStore(orm)), sqsClient(), queues,
  { visibilitySeconds: 1, afterCommit: async () => { process.exit(113); } });
await consumer.pollOnce();
throw new Error('Expected crash after commit.');
