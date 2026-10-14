-- Migration 032: reservation ownership, expiry leases and recovery metadata for
-- billable AI operations. The current reservation token owns any release/commit.
-- Persist the usage event key on successful records so cleanup can reconcile
-- a crash that happened after persistence but before commitAiUsage ran.

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS reservation_status TEXT NOT NULL DEFAULT 'committed',
  ADD COLUMN IF NOT EXISTS reservation_token UUID,
  ADD COLUMN IF NOT EXISTS reservation_lease_until TIMESTAMPTZ;

ALTER TABLE usage_events
  DROP CONSTRAINT IF EXISTS usage_events_reservation_state_check;

ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_reservation_state_check
  CHECK (
    (
      reservation_status = 'committed'
      AND reservation_token IS NULL
      AND reservation_lease_until IS NULL
    )
    OR
    (
      reservation_status = 'reserved'
      AND reservation_token IS NOT NULL
      AND reservation_lease_until IS NOT NULL
      AND event_type IN ('ai_message', 'copilot_draft', 'ocr_document')
    )
  );

CREATE INDEX IF NOT EXISTS idx_usage_events_expired_ai_reservations
  ON usage_events (tenant_id, reservation_lease_until)
  WHERE reservation_status = 'reserved';

ALTER TABLE ai_copilot_drafts
  ADD COLUMN IF NOT EXISTS usage_event_key TEXT;

ALTER TABLE ocr_documents
  ADD COLUMN IF NOT EXISTS usage_event_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_copilot_drafts_tenant_usage_event
  ON ai_copilot_drafts (tenant_id, usage_event_key)
  WHERE usage_event_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ocr_documents_tenant_usage_event
  ON ocr_documents (tenant_id, usage_event_key)
  WHERE usage_event_key IS NOT NULL;
