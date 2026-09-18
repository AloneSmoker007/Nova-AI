-- Migration 021: client-owned Google Drive backup and restore metadata
CREATE TABLE IF NOT EXISTS google_drive_connections (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  refresh_token_encrypted TEXT NOT NULL,
  drive_root_folder_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_backup_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS google_drive_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_google_drive_oauth_states_expiry ON google_drive_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS tenant_backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'full' CHECK (kind IN ('full')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  drive_file_id TEXT,
  drive_file_name TEXT,
  snapshot_version TEXT NOT NULL DEFAULT 'v1',
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  sha256 TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenant_backups_tenant_created ON tenant_backups (tenant_id, started_at DESC);

ALTER TABLE tenant_backups ADD CONSTRAINT uq_tenant_backups_drive_file UNIQUE (tenant_id, drive_file_id);
