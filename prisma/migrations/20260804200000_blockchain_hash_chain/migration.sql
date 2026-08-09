-- Blockchain integrity: per-batch tamper-evident hash chain + DB-level immutability.
--
-- Each ledger row links to the batch's previous row via `previous_hash`, and
-- `block_hash` = sha256(previous_hash|payload_hash|event_type|batch_id|submitted_at).
-- Editing any past row breaks the hash of every row after it, which the
-- application's verifyChain() detects. The trigger below additionally makes
-- the historical columns physically immutable, so "blockchain records cannot
-- be edited through the app" is enforced by the database, not by convention.

-- pgcrypto provides digest() for the backfill below.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. New chain columns.
ALTER TABLE "blockchain_transactions"
  ADD COLUMN "previous_hash" TEXT,
  ADD COLUMN "block_hash" TEXT NOT NULL DEFAULT '';

CREATE INDEX "blockchain_transactions_batch_id_submitted_at_idx"
  ON "blockchain_transactions"("batch_id", "submitted_at");

-- 2. Backfill existing rows into a valid chain, ordered per batch. The string
--    layout must match computeBlockHash() in src/blockchain/blockchain.service.ts.
DO $$
DECLARE
  rec RECORD;
  prev TEXT;
  current_batch UUID := NULL;
  computed TEXT;
BEGIN
  FOR rec IN
    SELECT id, batch_id, payload_hash, event_type, submitted_at
    FROM "blockchain_transactions"
    ORDER BY batch_id, submitted_at ASC
  LOOP
    IF current_batch IS DISTINCT FROM rec.batch_id THEN
      current_batch := rec.batch_id;
      prev := NULL;
    END IF;

    computed := encode(
      digest(
        COALESCE(prev, 'genesis') || '|' ||
        rec.payload_hash || '|' ||
        rec.event_type::TEXT || '|' ||
        rec.batch_id::TEXT || '|' ||
        to_char(rec.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'sha256'
      ),
      'hex'
    );

    UPDATE "blockchain_transactions"
      SET previous_hash = prev, block_hash = computed
      WHERE id = rec.id;

    prev := computed;
  END LOOP;
END $$;

-- 3. Immutability guard.
--    DELETE is always forbidden. UPDATE is forbidden except the one legitimate
--    mutation the service performs: settling a PENDING row to CONFIRMED/FAILED
--    (status, tx_hash, confirmed_at, error_message). The historical/identifying
--    columns can never change once written.
CREATE OR REPLACE FUNCTION "blockchain_transactions_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'blockchain_transactions are immutable: DELETE is not permitted';
  END IF;

  -- Historical columns are write-once.
  IF NEW.batch_id      IS DISTINCT FROM OLD.batch_id
  OR NEW.event_type    IS DISTINCT FROM OLD.event_type
  OR NEW.payload       IS DISTINCT FROM OLD.payload
  OR NEW.payload_hash  IS DISTINCT FROM OLD.payload_hash
  OR NEW.previous_hash IS DISTINCT FROM OLD.previous_hash
  OR NEW.block_hash    IS DISTINCT FROM OLD.block_hash
  OR NEW.submitted_at  IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'blockchain_transactions are immutable: ledger columns cannot be modified';
  END IF;

  -- Only a PENDING row may be settled; a settled row is final.
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'blockchain_transactions are immutable: % records cannot be modified', OLD.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_blockchain_transactions_immutable" ON "blockchain_transactions";
CREATE TRIGGER "trg_blockchain_transactions_immutable"
  BEFORE UPDATE OR DELETE ON "blockchain_transactions"
  FOR EACH ROW EXECUTE FUNCTION "blockchain_transactions_immutable"();
