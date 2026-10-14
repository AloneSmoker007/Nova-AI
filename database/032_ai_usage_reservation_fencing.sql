-- Migration 032: fence AI quota reservations to the attempt that created them.
-- Successful AI operations retain a committed usage event. Failed in-flight
-- attempts may release only their own token, and expired reservations can be
-- reclaimed by a later retry without deleting another worker's reservation.

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
