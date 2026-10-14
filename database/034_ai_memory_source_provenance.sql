-- Migration 034: track which source message produced each inferred memory.
-- A Meta deletion event can then remove derived memory and stale AI artifacts
-- without deleting separately curated/manual customer preferences.

ALTER TABLE contact_ai_memory
  ADD COLUMN IF NOT EXISTS source_message_id UUID;

ALTER TABLE contact_ai_memory
  DROP CONSTRAINT IF EXISTS fk_contact_ai_memory_source_message;

ALTER TABLE contact_ai_memory
  ADD CONSTRAINT fk_contact_ai_memory_source_message
  FOREIGN KEY (tenant_id, source_message_id)
  REFERENCES messages (tenant_id, id)
  ON DELETE SET NULL (source_message_id);

CREATE INDEX IF NOT EXISTS idx_contact_ai_memory_source_message
  ON contact_ai_memory (tenant_id, source_message_id)
  WHERE source_message_id IS NOT NULL;
