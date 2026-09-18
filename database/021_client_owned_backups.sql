-- Migration 021: client-owned encrypted backup storage

CREATE TABLE IF NOT EXISTS tenant_google_drive_connections (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  google_subject TEXT NOT NULL,
  google_email TEXT,
  refresh_token_encrypted TEXT NOT NULL,
  drive_folder_id TEXT,
  connected_by UUID,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, connected_by) REFERENCES users (tenant_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tenant_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  drive_file_id TEXT,
  drive_folder_id TEXT,
  filename TEXT NOT NULL,
  size_bytes BIGINT,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','UPLOADING','COMPLETED','FAILED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_backups_history ON tenant_backups (tenant_id, started_at DESC);
DROP TRIGGER IF EXISTS tenant_google_drive_connections_set_updated_at ON tenant_google_drive_connections;
CREATE TRIGGER tenant_google_drive_connections_set_updated_at BEFORE UPDATE ON tenant_google_drive_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
