-- Migration 023: one durable AI signal per tenant/message.
-- Retries of the same inbound message must update/reuse its signal rather than
-- creating duplicate analytics rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_ai_signals_tenant_message
  ON conversation_ai_signals (tenant_id, message_id)
  WHERE message_id IS NOT NULL;
