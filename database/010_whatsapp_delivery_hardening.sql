-- ============================================================
-- Migration 010: WhatsApp Delivery Hardening
-- Durable outbound delivery intent, provider correlation, status
-- reconciliation, and bounded recovery for ambiguous sends.
-- ============================================================

ALTER TABLE webhook_messages
  ADD CONSTRAINT uq_webhook_messages_tenant_id
  UNIQUE (tenant_id, id);

CREATE TABLE whatsapp_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inbox_message_id UUID NOT NULL,
  conversation_id UUID,
  recipient_wa_id TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery_key UUID NOT NULL DEFAULT gen_random_uuid(),
  provider_message_id TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  status_at TIMESTAMPTZ,
  error_code INTEGER,
  error_title TEXT,
  error_details TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_whatsapp_deliveries_tenant_inbox
    UNIQUE (tenant_id, inbox_message_id),

  CONSTRAINT uq_whatsapp_deliveries_delivery_key
    UNIQUE (delivery_key),

  CONSTRAINT uq_whatsapp_deliveries_tenant_provider
    UNIQUE (tenant_id, provider_message_id),

  CONSTRAINT fk_whatsapp_deliveries_inbox
    FOREIGN KEY (tenant_id, inbox_message_id)
    REFERENCES webhook_messages (tenant_id, id)
    ON DELETE CASCADE,

  CONSTRAINT fk_whatsapp_deliveries_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE SET NULL
);

CREATE INDEX idx_whatsapp_deliveries_recovery
  ON whatsapp_deliveries (state, last_attempt_at);

CREATE INDEX idx_whatsapp_deliveries_provider
  ON whatsapp_deliveries (tenant_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX idx_whatsapp_deliveries_status
  ON whatsapp_deliveries (tenant_id, state, status_at);

DROP TRIGGER IF EXISTS whatsapp_deliveries_set_updated_at ON whatsapp_deliveries;
CREATE TRIGGER whatsapp_deliveries_set_updated_at
BEFORE UPDATE ON whatsapp_deliveries
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_status_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_status_check
  CHECK (status IN ('received', 'processing', 'sent', 'delivered', 'read', 'failed'));
