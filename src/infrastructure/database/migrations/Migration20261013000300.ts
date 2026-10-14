import { Migration } from '@mikro-orm/migrations';

export class Migration20261013000300 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_kind_check;
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_amount_check;
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_status_check;
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_check;
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_check1;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_kind_valid CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'));
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_amount_valid CHECK((kind='LOSS' AND amount>=0) OR (kind<>'LOSS' AND amount>0));
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_status_valid CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'));
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_failure_valid CHECK((status IN ('REJECTED','FAILED'))=(failure_code IS NOT NULL));
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_result_valid CHECK(status='PENDING' OR result IS NOT NULL);
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_processed_at_valid CHECK((status IN ('PROCESSED','REJECTED','FAILED'))=(processed_at IS NOT NULL));
      ALTER TABLE wager_transactions ADD COLUMN reference_external_transaction_id TEXT;
      ALTER TABLE wager_transactions ADD COLUMN reference_transaction_id UUID REFERENCES wager_transactions(id);
      ALTER TABLE wager_transactions ADD COLUMN reference_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reference_attempts>=0);
      ALTER TABLE wager_transactions ADD COLUMN next_reference_attempt_at TIMESTAMPTZ;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_reference_required CHECK(kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL);
      CREATE UNIQUE INDEX wager_single_reversal_idx ON wager_transactions(reference_transaction_id,kind) WHERE status='PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX wager_pending_reference_idx ON wager_transactions(next_reference_attempt_at) WHERE status='PENDING_REFERENCE';

      CREATE OR REPLACE FUNCTION guard_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN RAISE EXCEPTION 'transaction is terminal' USING ERRCODE='23514'; END IF;
        IF (to_jsonb(NEW)-ARRAY['status','failure_code','result','processed_at','reference_transaction_id','reference_attempts','next_reference_attempt_at']) IS DISTINCT FROM
           (to_jsonb(OLD)-ARRAY['status','failure_code','result','processed_at','reference_transaction_id','reference_attempts','next_reference_attempt_at']) THEN
          RAISE EXCEPTION 'transaction identity is immutable' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END $$;

      CREATE OR REPLACE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE transaction_uuid UUID; tx wager_transactions; entries INTEGER; entry wallet_ledger; ref wager_transactions; reference_direction TEXT;
      BEGIN
        IF TG_TABLE_NAME='wager_transactions' THEN transaction_uuid:=NEW.id; ELSE transaction_uuid:=NEW.transaction_id; END IF;
        SELECT * INTO tx FROM wager_transactions WHERE id=transaction_uuid;
        SELECT COUNT(*) INTO entries FROM wallet_ledger WHERE transaction_id=transaction_uuid;
        IF (tx.status='PROCESSED' AND tx.kind<>'LOSS' AND entries<>1) OR ((tx.status<>'PROCESSED' OR tx.kind='LOSS') AND entries<>0) THEN
          RAISE EXCEPTION 'transaction and ledger diverge' USING ERRCODE='23514';
        END IF;
        IF tx.status='PROCESSED' AND tx.reference_external_transaction_id IS NOT NULL THEN
          SELECT * INTO ref FROM wager_transactions WHERE id=tx.reference_transaction_id;
          IF ref.id IS NULL OR ref.status<>'PROCESSED' OR
             (ref.provider_id,ref.player_id,ref.wallet_id,ref.currency,ref.round_id,ref.external_transaction_id) IS DISTINCT FROM
             (tx.provider_id,tx.player_id,tx.wallet_id,tx.currency,tx.round_id,tx.reference_external_transaction_id) THEN
            RAISE EXCEPTION 'invalid processed reference' USING ERRCODE='23514';
          END IF;
          IF (tx.kind IN ('REFUND','WIN') AND ref.kind<>'BET') OR
             (tx.kind='ROLLBACK' AND ref.kind NOT IN ('BET','WIN','REFUND')) OR
             (tx.kind IN ('REFUND','ROLLBACK') AND tx.amount<>ref.amount) THEN
            RAISE EXCEPTION 'invalid reference kind or amount' USING ERRCODE='23514';
          END IF;
        END IF;
        IF entries=1 THEN
          SELECT * INTO entry FROM wallet_ledger WHERE transaction_id=transaction_uuid;
          IF tx.kind='ROLLBACK' THEN
            SELECT direction INTO reference_direction FROM wallet_ledger WHERE transaction_id=tx.reference_transaction_id;
          END IF;
          IF entry.amount<>tx.amount OR entry.direction<>(CASE WHEN tx.kind='BET' THEN 'DEBIT' WHEN tx.kind='ROLLBACK' AND reference_direction='CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END) THEN
            RAISE EXCEPTION 'ledger does not match transaction' USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
    `);
  }

  override async down(): Promise<void> {
    // Refuse a lossy rollback once new operation kinds or pending records exist.
    this.addSql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM wager_transactions WHERE kind NOT IN ('BET','OPENING') OR status IN ('PENDING_REFERENCE','FAILED')) THEN RAISE EXCEPTION 'rollback requires no extended operation records'; END IF; END $$;`);
    this.addSql(`
      DROP INDEX wager_pending_reference_idx;
      DROP INDEX wager_single_reversal_idx;
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_reference_required;
      ALTER TABLE wager_transactions DROP COLUMN reference_external_transaction_id, DROP COLUMN reference_transaction_id, DROP COLUMN reference_attempts, DROP COLUMN next_reference_attempt_at;
      ALTER TABLE wager_transactions DROP CONSTRAINT wager_kind_valid, DROP CONSTRAINT wager_amount_valid, DROP CONSTRAINT wager_status_valid, DROP CONSTRAINT wager_failure_valid, DROP CONSTRAINT wager_result_valid, DROP CONSTRAINT wager_processed_at_valid;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_kind_check CHECK(kind IN ('OPENING','BET'));
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_amount_check CHECK(amount>0);
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_status_check CHECK(status IN ('PENDING','PROCESSED','REJECTED'));
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_check CHECK((status='REJECTED')=(failure_code IS NOT NULL));
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_check1 CHECK(status='PENDING' OR (result IS NOT NULL AND processed_at IS NOT NULL));
      CREATE OR REPLACE FUNCTION guard_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED') THEN RAISE EXCEPTION 'transaction is terminal' USING ERRCODE='23514'; END IF;
        IF (to_jsonb(NEW)-ARRAY['status','failure_code','result','processed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','failure_code','result','processed_at']) THEN RAISE EXCEPTION 'transaction identity is immutable' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE transaction_uuid UUID; tx wager_transactions; entries INTEGER; entry wallet_ledger;
      BEGIN
        IF TG_TABLE_NAME='wager_transactions' THEN transaction_uuid:=NEW.id; ELSE transaction_uuid:=NEW.transaction_id; END IF;
        SELECT * INTO tx FROM wager_transactions WHERE id=transaction_uuid;
        SELECT COUNT(*) INTO entries FROM wallet_ledger WHERE transaction_id=transaction_uuid;
        IF (tx.status='PROCESSED' AND entries<>1) OR (tx.status<>'PROCESSED' AND entries<>0) THEN RAISE EXCEPTION 'transaction and ledger diverge' USING ERRCODE='23514'; END IF;
        IF entries=1 THEN
          SELECT * INTO entry FROM wallet_ledger WHERE transaction_id=transaction_uuid;
          IF entry.amount<>tx.amount OR entry.direction<>(CASE tx.kind WHEN 'BET' THEN 'DEBIT' ELSE 'CREDIT' END) THEN RAISE EXCEPTION 'ledger does not match transaction' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NULL;
      END $$;
    `);
  }
}
