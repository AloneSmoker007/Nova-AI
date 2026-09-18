import { dbPool, isDatabaseConfigured } from "../config/database.js";

const MAX_TEXT_LENGTH = 4000;
const MAX_LIST_ITEMS = 100;
const MAX_JSON_DEPTH = 5;

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}

function normalizeText(value, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizeJsonObject(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Business Brain configuration objects must be JSON objects");
  }
  return value;
}

function assertReasonableJson(value, depth = 0) {
  if (depth > MAX_JSON_DEPTH) throw new Error("Business Brain configuration is too deeply nested");
  if (value === null || typeof value !== "object") return;
  const values = Array.isArray(value) ? value : Object.values(value);
  if (values.length > MAX_LIST_ITEMS) throw new Error("Business Brain configuration contains too many items");
  for (const item of values) assertReasonableJson(item, depth + 1);
}

function normalizeBrain(brain = {}) {
  const products = Array.isArray(brain.products) ? brain.products.slice(0, MAX_LIST_ITEMS) : [];
  const faqs = Array.isArray(brain.faqs) ? brain.faqs.slice(0, MAX_LIST_ITEMS) : [];
  const rules = Array.isArray(brain.rules) ? brain.rules.slice(0, MAX_LIST_ITEMS) : [];
  const hours = normalizeJsonObject(brain.hours, {});
  const persona = normalizeJsonObject(brain.persona, {});
  const salesGuardrails = normalizeJsonObject(brain.salesGuardrails, {});
  const languageConfig = normalizeJsonObject(brain.languageConfig, {});

  for (const value of [products, faqs, rules, hours, persona, salesGuardrails, languageConfig]) {
    assertReasonableJson(value);
  }
  return { products, faqs, rules, hours, persona, salesGuardrails, languageConfig };
}

export async function getBusinessBrain(tenantId) {
  assertDatabase();
  if (!tenantId) throw new Error("Tenant ID is required");

  const result = await dbPool.query(
    `SELECT business_name, category, description, products, faqs, hours,
            location, contact, ai_tone, ai_language, custom_instructions, rules,
            persona, sales_guardrails, language_config
     FROM tenant_business_brain
     WHERE tenant_id = $1 LIMIT 1`,
    [tenantId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    businessName: row.business_name,
    category: row.category,
    description: row.description,
    products: Array.isArray(row.products) ? row.products.slice(0, MAX_LIST_ITEMS) : [],
    faqs: Array.isArray(row.faqs) ? row.faqs.slice(0, MAX_LIST_ITEMS) : [],
    hours: row.hours && typeof row.hours === "object" ? row.hours : {},
    location: row.location,
    contact: row.contact,
    aiTone: row.ai_tone,
    aiLanguage: row.ai_language,
    customInstructions: row.custom_instructions,
    rules: Array.isArray(row.rules) ? row.rules.slice(0, MAX_LIST_ITEMS) : [],
    persona: row.persona && typeof row.persona === "object" ? row.persona : {},
    salesGuardrails: row.sales_guardrails && typeof row.sales_guardrails === "object" ? row.sales_guardrails : {},
    languageConfig: row.language_config && typeof row.language_config === "object" ? row.language_config : {},
  };
}

export async function upsertBusinessBrain(tenantId, brain = {}) {
  assertDatabase();
  if (!tenantId) throw new Error("Tenant ID is required");

  const normalized = normalizeBrain(brain);

  const result = await dbPool.query(
    `INSERT INTO tenant_business_brain (
       tenant_id, business_name, category, description, products, faqs, hours,
       location, contact, ai_tone, ai_language, custom_instructions, rules,
       persona, sales_guardrails, language_config
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb,
             $14::jsonb, $15::jsonb, $16::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET
       business_name = EXCLUDED.business_name,
       category = EXCLUDED.category,
       description = EXCLUDED.description,
       products = EXCLUDED.products,
       faqs = EXCLUDED.faqs,
       hours = EXCLUDED.hours,
       location = EXCLUDED.location,
       contact = EXCLUDED.contact,
       ai_tone = EXCLUDED.ai_tone,
       ai_language = EXCLUDED.ai_language,
       custom_instructions = EXCLUDED.custom_instructions,
       rules = EXCLUDED.rules,
       persona = EXCLUDED.persona,
       sales_guardrails = EXCLUDED.sales_guardrails,
       language_config = EXCLUDED.language_config,
       updated_at = NOW()
     RETURNING tenant_id`,
    [
      tenantId,
      normalizeText(brain.businessName),
      normalizeText(brain.category),
      normalizeText(brain.description),
      JSON.stringify(normalized.products),
      JSON.stringify(normalized.faqs),
      JSON.stringify(normalized.hours),
      normalizeText(brain.location),
      normalizeText(brain.contact),
      normalizeText(brain.aiTone),
      normalizeText(brain.aiLanguage),
      normalizeText(brain.customInstructions),
      JSON.stringify(normalized.rules),
      JSON.stringify(normalized.persona),
      JSON.stringify(normalized.salesGuardrails),
      JSON.stringify(normalized.languageConfig),
    ],
  );

  return Boolean(result.rows[0]);
}
