-- ============================================================
-- Migration 011: Durable Usage Metering + WhatsApp 24h Window
-- Operational conversation-window tracking and tenant-scoped limits.
-- This does not assume Meta billing semantics; it tracks Nova usage.
-- ============================================================

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS event_key TEXT;

UPDATE usage_events
SET event_key = id::text
WHERE event_key IS NULL;

ALTER TABLE usage_events
  ALTER COLUMN event_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_events_tenant_event_key
  ON usage_events (tenant_id, event_key);

CREATE TABLE IF NOT EXISTS tenant_usage_plans (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  monthly_conversation_limit INTEGER NOT NULL DEFAULT 1000 CHECK (monthly_conversation_limit >= 0),
  monthly_ai_message_limit INTEGER NOT NULL DEFAULT 5000 CHECK (monthly_ai_message_limit >= 0),
  monthly_media_limit INTEGER NOT NULL DEFAULT 1000 CHECK (monthly_media_limit >= 0),
  warning_percent INTEGER NOT NULL DEFAULT 80 CHECK (warning_percent BETWEEN 1 AND 100),
  hard_limit_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_expires_at TIMESTAMPTZ NOT NULL,
  source_message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_conversation_windows_tenant_window
    UNIQUE (tenant_id, conversation_id, window_started_at),
  CONSTRAINT fk_conversation_windows_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_conversation_windows_source_message
    FOREIGN KEY (tenant_id, source_message_id)
    REFERENCES messages (tenant_id, id)
    ON DELETE SET NULL,
  CONSTRAINT conversation_windows_times_valid
    CHECK (window_expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_conversation_windows_tenant_expiry
  ON conversation_windows (tenant_id, window_expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_windows_conversation
  ON conversation_windows (tenant_id, conversation_id, window_expires_at DESC);

DROP TRIGGER IF EXISTS tenant_usage_plans_set_updated_at ON tenant_usage_plans;
CREATE TRIGGER tenant_usage_plans_set_updated_at
BEFORE UPDATE ON tenant_usage_plans
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep the existing conversation columns useful for fast routing/UI.
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_free_until
  ON conversations (tenant_id, free_until DESC);
