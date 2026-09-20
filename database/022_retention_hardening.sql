-- Migration 022: bounded data retention cleanup
-- Keeps operational/idempotency state bounded while retaining durable
-- customer messages until their explicit message-retention policy expires.

CREATE INDEX IF NOT EXISTS idx_webhook_messages_retention
  ON webhook_messages (state, completed_at)
  WHERE state = 'COMPLETED';

CREATE INDEX IF NOT EXISTS idx_messages_retention_deleted
  ON messages (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ocr_documents_retention
  ON ocr_documents (created_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_retention
  ON usage_events (created_at);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_retention
  ON payment_webhook_events (received_at);
