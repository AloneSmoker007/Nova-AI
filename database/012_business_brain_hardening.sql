-- ============================================================
-- Migration 012: Business Brain Hardening
-- Adds structured AI persona, sales/discount guardrails and language
-- configuration while keeping every field tenant-scoped.
-- ============================================================

ALTER TABLE tenant_business_brain
  ADD COLUMN IF NOT EXISTS persona JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS sales_guardrails JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS language_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tenant_business_brain
  DROP CONSTRAINT IF EXISTS tenant_business_brain_persona_object,
  DROP CONSTRAINT IF EXISTS tenant_business_brain_sales_guardrails_object,
  DROP CONSTRAINT IF EXISTS tenant_business_brain_language_config_object;

ALTER TABLE tenant_business_brain
  ADD CONSTRAINT tenant_business_brain_persona_object
    CHECK (jsonb_typeof(persona) = 'object'),
  ADD CONSTRAINT tenant_business_brain_sales_guardrails_object
    CHECK (jsonb_typeof(sales_guardrails) = 'object'),
  ADD CONSTRAINT tenant_business_brain_language_config_object
    CHECK (jsonb_typeof(language_config) = 'object');
