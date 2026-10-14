import { Migration } from '@mikro-orm/migrations';

export class Migration20261013000400 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        PRIMARY KEY(consumer_name,message_id)
      );
      CREATE TABLE message_failures (
        consumer_name TEXT NOT NULL,
        message_id TEXT NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        failure_code TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('ACK','DLQ')),
        occurred_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY(consumer_name,message_id,payload_hash)
      );
    `);
  }
  override async down(): Promise<void> {
    this.addSql('DROP TABLE message_failures; DROP TABLE inbox_messages;');
  }
}
