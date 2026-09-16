-- ============================================================
-- Migration 003: Tenant Business Brain
-- Stores tenant-specific AI instructions and business knowledge.
-- ============================================================

CREATE TABLE IF NOT EXISTS tenant_business_brain (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  business_name TEXT,
  category TEXT,
  description TEXT,
  products JSONB NOT NULL DEFAULT '[]'::jsonb,
  faqs JSONB NOT NULL DEFAULT '[]'::jsonb,
  hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  location TEXT,
  contact TEXT,
  ai_tone TEXT,
  ai_language TEXT,
  custom_instructions TEXT,
  rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_business_brain_products_array CHECK (jsonb_typeof(products) = 'array'),
  CONSTRAINT tenant_business_brain_faqs_array CHECK (jsonb_typeof(faqs) = 'array'),
  CONSTRAINT tenant_business_brain_hours_object CHECK (jsonb_typeof(hours) = 'object'),
  CONSTRAINT tenant_business_brain_rules_array CHECK (jsonb_typeof(rules) = 'array')
);

DROP TRIGGER IF EXISTS tenant_business_brain_set_updated_at ON tenant_business_brain;
CREATE TRIGGER tenant_business_brain_set_updated_at
BEFORE UPDATE ON tenant_business_brain
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
