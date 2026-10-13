-- Migration 026: distinguish safe pre-send recovery from ambiguous provider outcomes.
-- A request that has begun may already have been accepted by WhatsApp when a
-- worker crashes or times out. Preserve a durable marker so recovery does not
-- automatically submit the same customer message twice.
ALTER TABLE whatsapp_deliveries
  ADD COLUMN IF NOT EXISTS provider_request_started_at TIMESTAMPTZ;

-- Older SENDING rows predate the marker. Treat them conservatively as
-- potentially submitted rather than blindly resending during rollout.
UPDATE whatsapp_deliveries
SET provider_request_started_at = COALESCE(last_attempt_at, created_at)
WHERE state = 'SENDING'
  AND provider_message_id IS NULL
  AND provider_request_started_at IS NULL;

ALTER TABLE whatsapp_deliveries
  DROP CONSTRAINT IF EXISTS whatsapp_deliveries_state_check;

ALTER TABLE whatsapp_deliveries
  DROP CONSTRAINT IF EXISTS chk_whatsapp_deliveries_state;

ALTER TABLE whatsapp_deliveries
  ADD CONSTRAINT chk_whatsapp_deliveries_state
  CHECK (state IN ('PENDING', 'SENDING', 'UNKNOWN', 'SENT', 'DELIVERED', 'READ', 'FAILED'));

CREATE INDEX IF NOT EXISTS idx_whatsapp_deliveries_ambiguous_recovery
  ON whatsapp_deliveries (lease_until, last_attempt_at)
  WHERE state = 'SENDING'
    AND provider_message_id IS NULL
    AND provider_request_started_at IS NOT NULL;
