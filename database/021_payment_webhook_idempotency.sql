-- Migration 021: durable payment webhook event idempotency
-- Prevent replayed provider events from re-applying payment transitions.

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 2 AND 40),
  event_id TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','paid','failed','refunded','cancelled')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_tenant_received
  ON payment_webhook_events (tenant_id, received_at DESC);
