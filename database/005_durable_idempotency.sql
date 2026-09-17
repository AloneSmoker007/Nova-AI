CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing','completed','failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_tenant ON processed_messages (tenant_id);
CREATE INDEX IF NOT EXISTS idx_processed_messages_status_started
  ON processed_messages (status, started_at);
