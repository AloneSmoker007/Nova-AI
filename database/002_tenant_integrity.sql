-- ============================================================
-- Migration 002: Tenant Integrity
-- Enforces tenant isolation at the database level.
--
-- Requires PostgreSQL 15+ for column-list ON DELETE SET NULL
-- syntax used in Section 5.
-- ============================================================

-- ------------------------------------------------------------
-- SECTION 1 — Preflight Data Integrity Checks
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM conversations c
    JOIN whatsapp_numbers wn ON wn.id = c.whatsapp_number_id
    WHERE c.tenant_id IS DISTINCT FROM wn.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: conversations ↔ whatsapp_numbers tenant mismatch. '
      'Fix tenant_id on the conversations rows before running this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.tenant_id IS DISTINCT FROM ct.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: conversations ↔ contacts tenant mismatch. '
      'Fix tenant_id on the conversations rows before running this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.tenant_id IS DISTINCT FROM c.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: messages ↔ conversations tenant mismatch. '
      'Fix tenant_id on the messages rows before running this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM usage_events ue
    JOIN conversations c ON c.id = ue.conversation_id
    WHERE ue.tenant_id IS DISTINCT FROM c.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: usage_events ↔ conversations tenant mismatch. '
      'Fix tenant_id on the usage_events rows before running this migration.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM usage_events ue
    JOIN messages m ON m.id = ue.message_id
    WHERE ue.tenant_id IS DISTINCT FROM m.tenant_id
  ) THEN
    RAISE EXCEPTION
      'Preflight failed: usage_events ↔ messages tenant mismatch. '
      'Fix tenant_id on the usage_events rows before running this migration.';
  END IF;

  RAISE NOTICE 'Preflight passed: all cross-table tenant IDs are consistent.';
END;
$$;

-- ------------------------------------------------------------
-- SECTION 2 — Composite Unique Constraints for FK Targets
-- ------------------------------------------------------------

ALTER TABLE whatsapp_numbers
  ADD CONSTRAINT uq_whatsapp_numbers_tenant_id
  UNIQUE (tenant_id, id);

ALTER TABLE contacts
  ADD CONSTRAINT uq_contacts_tenant_id
  UNIQUE (tenant_id, id);

ALTER TABLE conversations
  ADD CONSTRAINT uq_conversations_tenant_id
  UNIQUE (tenant_id, id);

ALTER TABLE messages
  ADD CONSTRAINT uq_messages_tenant_id
  UNIQUE (tenant_id, id);

-- ------------------------------------------------------------
-- SECTION 3 — Drop Existing Non-Tenant-Aware Foreign Keys
-- ------------------------------------------------------------

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_whatsapp_number_id_fkey;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_contact_id_fkey;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_conversation_id_fkey;

ALTER TABLE usage_events
  DROP CONSTRAINT IF EXISTS usage_events_conversation_id_fkey;

ALTER TABLE usage_events
  DROP CONSTRAINT IF EXISTS usage_events_message_id_fkey;

-- ------------------------------------------------------------
-- SECTION 4 — Composite Tenant-Aware Foreign Keys
-- ------------------------------------------------------------

ALTER TABLE conversations
  ADD CONSTRAINT fk_conversations_whatsapp_number
  FOREIGN KEY (tenant_id, whatsapp_number_id)
  REFERENCES whatsapp_numbers (tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE conversations
  ADD CONSTRAINT fk_conversations_contact
  FOREIGN KEY (tenant_id, contact_id)
  REFERENCES contacts (tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE messages
  ADD CONSTRAINT fk_messages_conversation
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id)
  ON DELETE CASCADE;

-- ------------------------------------------------------------
-- SECTION 5 — usage_events Tenant-Aware FKs
--
-- PostgreSQL 15+ supports a column list on ON DELETE SET NULL.
-- Only the specified nullable FK column is cleared; tenant_id
-- remains intact and NOT NULL.
-- ------------------------------------------------------------

ALTER TABLE usage_events
  ADD CONSTRAINT fk_usage_events_conversation
  FOREIGN KEY (tenant_id, conversation_id)
  REFERENCES conversations (tenant_id, id)
  ON DELETE SET NULL (conversation_id);

ALTER TABLE usage_events
  ADD CONSTRAINT fk_usage_events_message
  FOREIGN KEY (tenant_id, message_id)
  REFERENCES messages (tenant_id, id)
  ON DELETE SET NULL (message_id);

-- ------------------------------------------------------------
-- SECTION 6 — Indexes for New Composite Foreign Keys
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_whatsapp_number
  ON conversations (tenant_id, whatsapp_number_id);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_contact
  ON conversations (tenant_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_messages_tenant_conversation
  ON messages (tenant_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_conversation
  ON usage_events (tenant_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_message
  ON usage_events (tenant_id, message_id);

-- ------------------------------------------------------------
-- SECTION 7 — Composite Index for Tenant Conversation Queries
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_status
  ON conversations (tenant_id, status);
