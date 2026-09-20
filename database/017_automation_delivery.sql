-- Migration 017: Automation outbound delivery integration
ALTER TABLE whatsapp_deliveries
  ALTER COLUMN inbox_message_id DROP NOT NULL;

ALTER TABLE whatsapp_deliveries
  ADD COLUMN IF NOT EXISTS automation_run_id UUID,
  ADD COLUMN IF NOT EXISTS automation_step INTEGER;

ALTER TABLE whatsapp_deliveries
  ADD CONSTRAINT fk_whatsapp_deliveries_automation_run
  FOREIGN KEY (tenant_id, automation_run_id)
  REFERENCES automation_runs (tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE whatsapp_deliveries
  ADD CONSTRAINT chk_whatsapp_deliveries_source
  CHECK (
    (inbox_message_id IS NOT NULL AND automation_run_id IS NULL)
    OR
    (inbox_message_id IS NULL AND automation_run_id IS NOT NULL)
  );

ALTER TABLE whatsapp_deliveries
  ADD CONSTRAINT chk_whatsapp_deliveries_automation_step
  CHECK (automation_run_id IS NULL OR (automation_step IS NOT NULL AND automation_step >= 0));

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_deliveries_tenant_automation_step
  ON whatsapp_deliveries (tenant_id, automation_run_id, automation_step)
  WHERE automation_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_automation_runs_dispatch
  ON automation_runs (status, next_run_at)
  WHERE status IN ('queued','waiting','running');

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS trigger_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_trigger_key
  ON automation_runs (tenant_id, workflow_id, trigger_key)
  WHERE trigger_key IS NOT NULL;
