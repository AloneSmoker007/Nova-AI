-- Migration 024: fence automation workflow executors.
-- Every claim receives a fresh token and bounded lease so a stale executor
-- cannot overwrite the state written by a newer claim.
ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS executor_token UUID,
  ADD COLUMN IF NOT EXISTS executor_lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_automation_runs_executor_lease
  ON automation_runs (status, executor_lease_until)
  WHERE status = 'running';
