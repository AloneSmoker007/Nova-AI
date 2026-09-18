-- ============================================================
-- Migration 009: Tenant-Scoped Durable Idempotency
-- Makes the legacy processed_messages identity consistent with
-- the tenant-scoped service contract.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM processed_messages pm
    JOIN tenants t ON t.id = pm.tenant_id
    WHERE pm.tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Preflight failed: processed_messages contains NULL tenant_id.';
  END IF;
END;
$$;

ALTER TABLE processed_messages
  DROP CONSTRAINT IF EXISTS processed_messages_pkey;

ALTER TABLE processed_messages
  ADD CONSTRAINT processed_messages_pkey
  PRIMARY KEY (tenant_id, message_id);

CREATE INDEX IF NOT EXISTS idx_processed_messages_message_id
  ON processed_messages (message_id);
