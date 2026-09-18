-- ============================================================
-- Migration 015: Human Handoff & AI Co-Pilot
-- Tenant-safe AI pause, skill routing, round-robin assignment,
-- escalation summaries and durable co-pilot drafts.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_paused_by UUID,
  ADD COLUMN IF NOT EXISTS handoff_reason TEXT,
  ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS assigned_skill TEXT;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS fk_conversations_ai_paused_by;

ALTER TABLE conversations
  ADD CONSTRAINT fk_conversations_ai_paused_by
  FOREIGN KEY (tenant_id, ai_paused_by)
  REFERENCES users (tenant_id, id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_handoff_queue
  ON conversations (tenant_id, status, ai_paused, assigned_skill, updated_at DESC);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_round_robin
  ON users (tenant_id, status, last_assigned_at NULLS FIRST, id);

CREATE TABLE IF NOT EXISTS conversation_ai_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 8000),
  trigger TEXT NOT NULL DEFAULT 'handoff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_ai_summaries_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_summaries_lookup
  ON conversation_ai_summaries (tenant_id, conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_copilot_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  author_user_id UUID,
  draft TEXT NOT NULL CHECK (length(draft) BETWEEN 1 AND 8000),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_copilot_drafts_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_copilot_drafts_author
    FOREIGN KEY (tenant_id, author_user_id)
    REFERENCES users (tenant_id, id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_copilot_drafts_lookup
  ON ai_copilot_drafts (tenant_id, conversation_id, created_at DESC);

DROP TRIGGER IF EXISTS ai_copilot_drafts_set_updated_at ON ai_copilot_drafts;
CREATE TRIGGER ai_copilot_drafts_set_updated_at
BEFORE UPDATE ON ai_copilot_drafts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
