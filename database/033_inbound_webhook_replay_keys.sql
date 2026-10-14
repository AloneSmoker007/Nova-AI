-- Migration 033: retain a compact provider-message replay barrier.
-- Full inbox payloads and canonical messages have shorter privacy retention. This
-- tenant-scoped identifier ledger survives that retention so an old validly
-- signed Meta webhook cannot recreate an inbox row and trigger another reply.

CREATE TABLE IF NOT EXISTS inbound_webhook_replay_keys (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_message_id TEXT NOT NULL CHECK (length(whatsapp_message_id) BETWEEN 1 AND 255),
  phone_number_id TEXT NOT NULL CHECK (length(phone_number_id) BETWEEN 1 AND 255),
  first_received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, whatsapp_message_id)
);

CREATE INDEX IF NOT EXISTS idx_inbound_webhook_replay_keys_received
  ON inbound_webhook_replay_keys (tenant_id, first_received_at DESC);

-- Backfill the replay barrier before future cleanup can delete older message rows.
INSERT INTO inbound_webhook_replay_keys
  (tenant_id, whatsapp_message_id, phone_number_id, first_received_at)
SELECT m.tenant_id, m.whatsapp_message_id, n.phone_number_id, MIN(m.created_at)
FROM messages m
JOIN whatsapp_numbers n
  ON n.tenant_id=m.tenant_id AND n.id=m.whatsapp_number_id
WHERE m.whatsapp_message_id IS NOT NULL
GROUP BY m.tenant_id, m.whatsapp_message_id, n.phone_number_id
ON CONFLICT (tenant_id, whatsapp_message_id) DO NOTHING;

INSERT INTO inbound_webhook_replay_keys
  (tenant_id, whatsapp_message_id, phone_number_id, first_received_at)
SELECT w.tenant_id, w.whatsapp_message_id, w.phone_number_id, MIN(w.received_at)
FROM webhook_messages w
WHERE w.whatsapp_message_id IS NOT NULL
GROUP BY w.tenant_id, w.whatsapp_message_id, w.phone_number_id
ON CONFLICT (tenant_id, whatsapp_message_id) DO NOTHING;
