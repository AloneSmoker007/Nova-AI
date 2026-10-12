-- Migration 025: keep payment webhook idempotency beyond detailed-event retention.
-- payment_webhook_events is intentionally purged after its configured retention
-- period; deleting those rows must not make an old signed provider event usable
-- again. This compact key table retains only the tenant/provider/event identity.
CREATE TABLE IF NOT EXISTS payment_webhook_event_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 2 AND 40),
  event_id TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_payment_webhook_event_keys_identity
    UNIQUE (tenant_id, provider, event_id)
);

-- Preserve every event already known before switching the handler to the
-- permanent key table. The backfill is idempotent and safe during deploys.
INSERT INTO payment_webhook_event_keys (tenant_id, provider, event_id, first_seen_at)
SELECT tenant_id, provider, event_id, received_at
FROM payment_webhook_events
ON CONFLICT (tenant_id, provider, event_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_payment_webhook_event_keys_first_seen
  ON payment_webhook_event_keys (first_seen_at);
