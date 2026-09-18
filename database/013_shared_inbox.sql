-- ============================================================
-- Migration 013: Shared Inbox & Conversation Management
-- Tenant-safe conversation search, status, assignment, tags and notes.
-- ============================================================

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_status_check;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('active', 'paused', 'human', 'archived'));

ALTER TABLE users
  ADD CONSTRAINT uq_users_tenant_id UNIQUE (tenant_id, id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS assigned_user_id UUID,
  ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 5),
  ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS fk_conversations_assigned_user;

ALTER TABLE conversations
  ADD CONSTRAINT fk_conversations_assigned_user
  FOREIGN KEY (tenant_id, assigned_user_id)
  REFERENCES users (tenant_id, id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_updated
  ON conversations (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_unread
  ON conversations (tenant_id, unread_count DESC, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_conversation_tags_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT uq_conversation_tags UNIQUE (tenant_id, conversation_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_conversation_tags_lookup
  ON conversation_tags (tenant_id, tag, conversation_id);

CREATE TABLE IF NOT EXISTS conversation_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  author_user_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_conversation_notes_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_conversation_notes_author
    FOREIGN KEY (tenant_id, author_user_id)
    REFERENCES users (tenant_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_lookup
  ON conversation_notes (tenant_id, conversation_id, created_at DESC);
