-- ============================================================
-- Migration 014: Advanced AI memory, intent and language state
-- Tenant-scoped long-term customer preferences and bounded AI signals.
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_ai_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL,
  memory_key TEXT NOT NULL,
  memory_value TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.500 CHECK (confidence BETWEEN 0 AND 1),
  source TEXT NOT NULL DEFAULT 'conversation',
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_contact_ai_memory UNIQUE (tenant_id, contact_id, memory_key),
  CONSTRAINT fk_contact_ai_memory_contact
    FOREIGN KEY (tenant_id, contact_id)
    REFERENCES contacts (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contact_ai_memory_lookup
  ON contact_ai_memory (tenant_id, contact_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_ai_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  message_id UUID,
  intent TEXT NOT NULL DEFAULT 'general',
  sentiment TEXT NOT NULL DEFAULT 'neutral',
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 5),
  detected_language TEXT NOT NULL DEFAULT 'unknown',
  preferred_language TEXT,
  negotiation_requested BOOLEAN NOT NULL DEFAULT FALSE,
  competitor_comparison_requested BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_conversation_ai_signals_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_conversation_ai_signals_message
    FOREIGN KEY (tenant_id, message_id)
    REFERENCES messages (tenant_id, id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_ai_signals_lookup
  ON conversation_ai_signals (tenant_id, conversation_id, created_at DESC);

DROP TRIGGER IF EXISTS contact_ai_memory_set_updated_at ON contact_ai_memory;
CREATE TRIGGER contact_ai_memory_set_updated_at
BEFORE UPDATE ON contact_ai_memory
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
