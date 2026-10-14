-- Migration 034: record provenance for conversation-derived customer memory.
-- WhatsApp deletion events use this source identifier to purge memories
-- derived from the deleted message without deleting manually curated memory.

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
