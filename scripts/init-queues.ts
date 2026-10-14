import { initializeQueues, sqsClient } from '../src/infrastructure/messaging/sqs';
const client = sqsClient();
try { console.log(JSON.stringify(await initializeQueues(client), null, 2)); }
finally { client.destroy(); }
