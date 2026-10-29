-- Migration 030: retain a durable audit outcome for signed payment webhook events.
-- Invalid state transitions are acknowledged as rejected, not rolled back into
-- an endless provider retry loop. The compact event-key ledger remains the
-- authoritative replay barrier beyond detailed-event retention.

ALTER TABLE payment_webhook_events
  ADD COLUMN IF NOT EXISTS processing_result TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

UPDATE payment_webhook_events
SET processing_result = 'applied'
WHERE processed_at IS NOT NULL
  AND processing_result = 'received';

ALTER TABLE payment_webhook_events
  DROP CONSTRAINT IF EXISTS payment_webhook_events_processing_result_check;

ALTER TABLE payment_webhook_events
  ADD CONSTRAINT payment_webhook_events_processing_result_check
  CHECK (processing_result IN ('received', 'applied', 'rejected'));
