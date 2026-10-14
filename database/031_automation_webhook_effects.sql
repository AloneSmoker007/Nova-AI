-- Migration 031: durable external-effect ledger for automation webhooks.
-- Database leases cannot prove whether a remote endpoint accepted an HTTP
-- request before a timeout/crash. Persist each run/step before sending so the
-- worker can skip completed effects and park ambiguous outcomes for review.

CREATE TABLE IF NOT EXISTS automation_webhook_effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  run_id UUID NOT NULL,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  endpoint_host TEXT NOT NULL CHECK (length(endpoint_host) BETWEEN 1 AND 253),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight', 'succeeded', 'unknown', 'retry_authorized')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  response_status INTEGER CHECK (response_status BETWEEN 100 AND 599),
  last_error_code TEXT,
  resolved_by UUID,
  resolution_reason TEXT CHECK (resolution_reason IS NULL OR length(resolution_reason) BETWEEN 1 AND 500),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_automation_webhook_effect_tenant_run_step
    UNIQUE (tenant_id, run_id, step_index),
  CONSTRAINT fk_automation_webhook_effect_run
    FOREIGN KEY (tenant_id, run_id)
    REFERENCES automation_runs (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_automation_webhook_effect_resolver
    FOREIGN KEY (tenant_id, resolved_by)
    REFERENCES users (tenant_id, id)
    ON DELETE SET NULL (resolved_by)
);

CREATE INDEX IF NOT EXISTS idx_automation_webhook_effect_review
  ON automation_webhook_effects (tenant_id, updated_at DESC)
  WHERE status = 'unknown';

DROP TRIGGER IF EXISTS automation_webhook_effects_set_updated_at ON automation_webhook_effects;
CREATE TRIGGER automation_webhook_effects_set_updated_at
BEFORE UPDATE ON automation_webhook_effects
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
