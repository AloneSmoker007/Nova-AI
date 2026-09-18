-- Migration 020: durable WhatsApp message deletion markers
-- Preserve original message text while recording that WhatsApp deleted it.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_reason TEXT;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_status_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_status_check
  CHECK (status IN ('received', 'processing', 'sent', 'delivered', 'read', 'failed', 'deleted'));

CREATE INDEX IF NOT EXISTS idx_messages_tenant_deleted_at
  ON messages (tenant_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;
