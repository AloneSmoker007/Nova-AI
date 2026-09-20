-- ============================================================
-- Migration 016: Automation & Workflow Engine
-- Tenant-scoped no-code WHEN -> IF -> THEN workflows and durable runs.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  trigger_type TEXT NOT NULL
    CHECK (trigger_type IN ('manual', 'message_received', 'conversation_created', 'inactivity')),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_automation_workflows_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT fk_automation_workflows_creator
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES users (tenant_id, id)
    ON DELETE SET NULL (created_by)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_workflows_tenant_name
  ON automation_workflows (tenant_id, name);
CREATE INDEX IF NOT EXISTS idx_automation_workflows_active
  ON automation_workflows (tenant_id, status, trigger_type);

CREATE TABLE IF NOT EXISTS automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL,
  conversation_id UUID,
  contact_id UUID,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_step INTEGER NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_run_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_automation_runs_tenant_id
    UNIQUE (tenant_id, id),
  CONSTRAINT fk_automation_runs_workflow
    FOREIGN KEY (tenant_id, workflow_id)
    REFERENCES automation_workflows (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_automation_runs_conversation
    FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT fk_automation_runs_contact
    FOREIGN KEY (tenant_id, contact_id)
    REFERENCES contacts (tenant_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_due
  ON automation_runs (tenant_id, status, next_run_at, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_conversation
  ON automation_runs (tenant_id, conversation_id, created_at DESC);

DROP TRIGGER IF EXISTS automation_workflows_set_updated_at ON automation_workflows;
CREATE TRIGGER automation_workflows_set_updated_at
BEFORE UPDATE ON automation_workflows
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS automation_runs_set_updated_at ON automation_runs;
CREATE TRIGGER automation_runs_set_updated_at
BEFORE UPDATE ON automation_runs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
