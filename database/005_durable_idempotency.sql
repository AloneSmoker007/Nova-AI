-- Durable idempotency for message processing

CREATE TABLE processed_messages (
    message_id   TEXT PRIMARY KEY,
    tenant_id    UUID NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
    attempts     INT  NOT NULL DEFAULT 0,
    last_error   TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_processed_messages_tenant_id ON processed_messages (tenant_id);
CREATE INDEX idx_processed_messages_status_started ON processed_messages (status, started_at);