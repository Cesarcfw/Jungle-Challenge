import { DomainError } from './domain-error';

export class InboxMessage {
  private constructor(public readonly messageId: string, public readonly consumerName: string,
    public readonly payloadHash: string, private _processedAt: Date | undefined) {}
  static receive(messageId: string, consumerName: string, payloadHash: string): InboxMessage {
    return new InboxMessage(messageId, consumerName, payloadHash, undefined);
  }
  static rehydrate(messageId: string, consumerName: string, payloadHash: string, processedAt?: Date): InboxMessage {
    return new InboxMessage(messageId, consumerName, payloadHash, processedAt ? new Date(processedAt) : undefined);
  }
  get processedAt(): Date | undefined { return this._processedAt ? new Date(this._processedAt) : undefined; }
  isProcessed(): boolean { return this._processedAt !== undefined; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new DomainError('INBOX_ALREADY_PROCESSED', 'Inbox message is already processed.');
    this._processedAt = new Date(at);
  }
}
