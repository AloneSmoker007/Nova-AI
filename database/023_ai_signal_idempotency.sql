-- Migration 023: one durable AI signal per tenant/message.
-- Durable inbox retries re-run signal persistence; keep the newest existing
-- signal for each real message before enforcing the idempotency invariant.
WITH ranked_signals AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, message_id
      ORDER BY created_at DESC, id DESC
    ) AS duplicate_rank
  FROM conversation_ai_signals
  WHERE message_id IS NOT NULL
)
DELETE FROM conversation_ai_signals AS existing
USING ranked_signals AS duplicate
WHERE existing.id = duplicate.id
  AND duplicate.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_conversation_ai_signals_tenant_message
  ON conversation_ai_signals (tenant_id, message_id)
  WHERE message_id IS NOT NULL;
