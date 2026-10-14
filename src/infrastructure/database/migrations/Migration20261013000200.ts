import { Migration } from '@mikro-orm/migrations';

export class Migration20261013000200 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wallets ADD CONSTRAINT wallets_id_currency_unique UNIQUE(id, currency);
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id TEXT NOT NULL,
        external_transaction_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('OPENING', 'BET')),
        amount NUMERIC(20,2) NOT NULL CHECK(amount > 0),
        currency VARCHAR(3) NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'PROCESSED', 'REJECTED')),
        failure_code TEXT,
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        UNIQUE(provider_id, external_transaction_id),
        UNIQUE(id, wallet_id, currency),
        CHECK ((status = 'REJECTED') = (failure_code IS NOT NULL)),
        CHECK (status = 'PENDING' OR (result IS NOT NULL AND processed_at IS NOT NULL))
      );
      CREATE TABLE wallet_ledger (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL,
        transaction_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('DEBIT', 'CREDIT')),
        amount NUMERIC(20,2) NOT NULL CHECK(amount > 0),
        balance_before NUMERIC(20,2) NOT NULL CHECK(balance_before >= 0),
        balance_after NUMERIC(20,2) NOT NULL CHECK(balance_after >= 0),
        wallet_version INTEGER NOT NULL CHECK(wallet_version > 0),
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE(transaction_id, wallet_id),
        UNIQUE(wallet_id, wallet_version),
        FOREIGN KEY(wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY(transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
        CHECK(balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX wallet_ledger_cursor_idx ON wallet_ledger(wallet_id, wallet_version);
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );
      CREATE INDEX outbox_pending_idx ON outbox_messages(occurred_at) WHERE published_at IS NULL;

      CREATE FUNCTION deny_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ledger is immutable' USING ERRCODE = '23514'; END $$;
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION deny_ledger_mutation();

      CREATE FUNCTION guard_wallet_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
          RAISE EXCEPTION 'wallet identity is immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.version <> OLD.version + (CASE WHEN NEW.balance <> OLD.balance THEN 1 ELSE 0 END) THEN
          RAISE EXCEPTION 'wallet version must follow balance changes' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER wallet_update_guard BEFORE UPDATE ON wallets FOR EACH ROW EXECUTE FUNCTION guard_wallet_update();

      CREATE FUNCTION guard_transaction_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED') THEN
          RAISE EXCEPTION 'transaction is terminal' USING ERRCODE = '23514';
        END IF;
        IF (to_jsonb(NEW) - ARRAY['status','failure_code','result','processed_at']) IS DISTINCT FROM
           (to_jsonb(OLD) - ARRAY['status','failure_code','result','processed_at']) THEN
          RAISE EXCEPTION 'transaction identity is immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER transaction_update_guard BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION guard_transaction_update();

      CREATE FUNCTION guard_ledger_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous wallet_ledger; transaction_kind TEXT;
      BEGIN
        PERFORM 1 FROM wallets WHERE id = NEW.wallet_id FOR UPDATE;
        SELECT * INTO previous FROM wallet_ledger WHERE wallet_id = NEW.wallet_id ORDER BY wallet_version DESC LIMIT 1;
        SELECT kind INTO transaction_kind FROM wager_transactions WHERE id = NEW.transaction_id;
        IF FOUND AND transaction_kind = 'OPENING' THEN
          IF previous.id IS NOT NULL OR NEW.wallet_version <> 1 OR NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'invalid opening entry' USING ERRCODE = '23514';
          END IF;
        ELSE
          IF NEW.balance_before <> COALESCE(previous.balance_after, 0) OR NEW.wallet_version <> COALESCE(previous.wallet_version, 1) + 1 THEN
            RAISE EXCEPTION 'invalid ledger chain' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ledger_chain_guard BEFORE INSERT ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION guard_ledger_chain();

      CREATE FUNCTION check_wallet_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wallet_uuid UUID; stored NUMERIC; calculated NUMERIC; stored_version INTEGER; last_version INTEGER;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wallet_uuid := NEW.id; ELSE wallet_uuid := NEW.wallet_id; END IF;
        SELECT balance, version INTO stored, stored_version FROM wallets WHERE id = wallet_uuid FOR UPDATE;
        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0), COALESCE(MAX(wallet_version), 1)
          INTO calculated, last_version FROM wallet_ledger WHERE wallet_id = wallet_uuid;
        IF stored IS DISTINCT FROM calculated OR stored_version IS DISTINCT FROM last_version THEN
          RAISE EXCEPTION 'wallet and ledger diverge' USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_ledger_consistency AFTER INSERT OR UPDATE ON wallets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_wallet_ledger();

      CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE transaction_uuid UUID; tx wager_transactions; entries INTEGER; entry wallet_ledger;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN transaction_uuid := NEW.id; ELSE transaction_uuid := NEW.transaction_id; END IF;
        SELECT * INTO tx FROM wager_transactions WHERE id = transaction_uuid;
        SELECT COUNT(*) INTO entries FROM wallet_ledger WHERE transaction_id = transaction_uuid;
        IF (tx.status = 'PROCESSED' AND entries <> 1) OR (tx.status <> 'PROCESSED' AND entries <> 0) THEN
          RAISE EXCEPTION 'transaction and ledger diverge' USING ERRCODE = '23514';
        END IF;
        IF entries = 1 THEN
          SELECT * INTO entry FROM wallet_ledger WHERE transaction_id = transaction_uuid;
          IF entry.amount <> tx.amount OR entry.direction <> (CASE tx.kind WHEN 'BET' THEN 'DEBIT' ELSE 'CREDIT' END) THEN
            RAISE EXCEPTION 'ledger does not match transaction' USING ERRCODE = '23514';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER transaction_ledger_consistency AFTER INSERT OR UPDATE ON wager_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
      CREATE CONSTRAINT TRIGGER ledger_transaction_consistency AFTER INSERT ON wallet_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER wallet_ledger_consistency ON wallets;
      DROP TRIGGER wallet_update_guard ON wallets;
      DROP TABLE outbox_messages;
      DROP TABLE wallet_ledger;
      DROP TABLE wager_transactions;
      DROP FUNCTION check_transaction_ledger();
      DROP FUNCTION check_wallet_ledger();
      DROP FUNCTION guard_ledger_chain();
      DROP FUNCTION guard_transaction_update();
      DROP FUNCTION guard_wallet_update();
      DROP FUNCTION deny_ledger_mutation();
      ALTER TABLE wallets DROP CONSTRAINT wallets_id_currency_unique;
    `);
  }
}
