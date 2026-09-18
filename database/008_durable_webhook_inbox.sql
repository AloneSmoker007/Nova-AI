-- ============================================================
-- Migration 008: Durable Webhook Inbox
-- ============================================================

-- Ensure the composite foreign-key target exists even if an earlier
-- migration was deployed without the tenant-aware unique key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_numbers_tenant_id
  ON whatsapp_numbers (tenant_id, id);

CREATE TABLE webhook_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_number_id UUID NOT NULL,
  phone_number_id TEXT NOT NULL,
  whatsapp_message_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  profile_name TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (state IN ('RECEIVED', 'QUEUED', 'PROCESSING', 'RETRY_WAIT', 'COMPLETED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  last_error TEXT,
  generated_response TEXT,
  provider_message_id TEXT,
  queue_dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_webhook_messages_tenant_message
    UNIQUE (tenant_id, whatsapp_message_id),
  CONSTRAINT fk_webhook_messages_tenant_number
    FOREIGN KEY (tenant_id, whatsapp_number_id)
    REFERENCES whatsapp_numbers (tenant_id, id)
);

CREATE INDEX idx_webhook_messages_recovery
  ON webhook_messages (state, available_at);

CREATE INDEX idx_webhook_messages_expired_leases
  ON webhook_messages (lease_until)
  WHERE state = 'PROCESSING';

CREATE INDEX idx_webhook_messages_queue_dispatch
  ON webhook_messages (tenant_id, state, queue_dispatched_at);

DROP TRIGGER IF EXISTS webhook_messages_set_updated_at ON webhook_messages;
CREATE TRIGGER webhook_messages_set_updated_at
BEFORE UPDATE ON webhook_messages
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
