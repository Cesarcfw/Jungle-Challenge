import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

export interface QueueUrls { requests: string; dlq: string; events: string }
export function sqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1', endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
    maxAttempts: 1, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
  });
}
export async function initializeQueues(client: SQSClient, prefix = 'wager'): Promise<QueueUrls> {
  const create = async (name: string, attributes: Record<string, string> = {}) => {
    const response = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes } }));
    if (!response.QueueUrl) throw new Error('SQS returned no queue URL.');
    // Queue URLs returned by an emulator may advertise localhost, which points
    // at the API container itself. Preserve the path but use this client's host.
    const address = new URL(response.QueueUrl);
    const endpoint = new URL(process.env.SQS_ENDPOINT ?? 'http://localhost:4566');
    address.protocol = endpoint.protocol;
    address.host = endpoint.host;
    return address.toString();
  };
  const dlq = await create(`${prefix}-transactions-dlq.fifo`);
  const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
  const requests = await create(`${prefix}-transactions.fifo`, { VisibilityTimeout: '30', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: attributes.Attributes?.QueueArn, maxReceiveCount: '5' }) });
  const events = await create(`${prefix}-events.fifo`);
  return { requests, dlq, events };
}
