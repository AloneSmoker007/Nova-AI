-- ============================================================
-- Migration 007: Tenant-Scoped Integrity Hardening
-- Prevents cross-tenant identity references at the database layer.
-- ============================================================

-- ------------------------------------------------------------
-- SECTION 1 — Preflight Data Integrity Checks
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM refresh_tokens rt
    JOIN users u ON u.id = rt.user_id
    WHERE rt.tenant_id IS DISTINCT FROM u.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: refresh_tokens ↔ users tenant mismatch. '
      'Fix tenant_id on refresh_tokens before running this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM processed_messages pm
    LEFT JOIN tenants t ON t.id = pm.tenant_id
    WHERE t.id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: processed_messages contains an unknown tenant_id. '
      'Fix tenant_id before running this migration.';
  END IF;

  RAISE NOTICE 'Preflight passed: authentication and idempotency tenant IDs are consistent.';
END;
$$;

-- ------------------------------------------------------------
-- SECTION 2 — Composite FK Target for Users
-- ------------------------------------------------------------

ALTER TABLE users
  ADD CONSTRAINT uq_users_tenant_id
  UNIQUE (tenant_id, id);

-- ------------------------------------------------------------
-- SECTION 3 — Tenant-Aware Refresh Token FK
-- ------------------------------------------------------------

ALTER TABLE refresh_tokens
  DROP CONSTRAINT IF EXISTS refresh_tokens_user_id_fkey;

ALTER TABLE refresh_tokens
  ADD CONSTRAINT fk_refresh_tokens_user
  FOREIGN KEY (tenant_id, user_id)
  REFERENCES users (tenant_id, id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant_user
  ON refresh_tokens (tenant_id, user_id);

-- ------------------------------------------------------------
-- SECTION 4 — Tenant FK for Durable Idempotency Records
-- ------------------------------------------------------------

ALTER TABLE processed_messages
  ADD CONSTRAINT fk_processed_messages_tenant
  FOREIGN KEY (tenant_id)
  REFERENCES tenants (id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_processed_messages_tenant_status_started
  ON processed_messages (tenant_id, status, started_at);
