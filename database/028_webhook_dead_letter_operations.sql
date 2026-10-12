-- Migration 028: operator-visible durable webhook dead letters and audited manual retries.
ALTER TABLE webhook_messages
  ADD COLUMN IF NOT EXISTS manual_retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (manual_retry_count >= 0),
  ADD COLUMN IF NOT EXISTS last_manual_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_manual_retry_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_manual_retry_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_webhook_messages_dead_letter_tenant
  ON webhook_messages (tenant_id, updated_at DESC)
  WHERE state = 'DEAD_LETTER';
