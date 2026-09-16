-- ============================================================
-- Migration 004: Authentication
-- Adds users table with password hashing, JWT-compatible
-- roles, and tenant-scoped access.
--
-- Requires PostgreSQL for UUID generation and set_updated_at()
-- from migration 001.
-- ============================================================

-- ------------------------------------------------------------
-- SECTION 1 — Users Table
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent'
    CHECK (role IN ('owner', 'admin', 'agent')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Globally unique email: one email = one account across all tenants.
-- The UNIQUE index provides email lookup performance and duplicate
-- prevention without redundant indexes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
  ON users (email);

-- FK support index for tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_users_tenant_id
  ON users (tenant_id);

-- ------------------------------------------------------------
-- SECTION 2 — Updated-At Trigger
-- Uses DROP IF EXISTS + CREATE to match the idempotent pattern
-- established in migrations 001 and 003.
-- ------------------------------------------------------------

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
