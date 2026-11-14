-- Migration 036: permit the already-supported ai_diagnostic operation to use
-- the same fenced reservation lifecycle as the other billable Gemini event types.
-- Keep migration 032 immutable; deployed databases apply this forward-only repair.

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
      AND event_type IN ('ai_message', 'copilot_draft', 'ocr_document', 'ai_diagnostic')
    )
  );
