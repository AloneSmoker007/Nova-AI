import { dbPool, isDatabaseConfigured } from "../config/database.js";

const MAX_TEXT_LENGTH = 4000;
const MAX_LIST_ITEMS = 100;

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null;
}

function normalizeJson(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

export async function getBusinessBrain(tenantId) {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }

  const result = await dbPool.query(
    `
      SELECT
        business_name,
        category,
        description,
        products,
        faqs,
        hours,
        location,
        contact,
        ai_tone,
        ai_language,
        custom_instructions,
        rules
      FROM tenant_business_brain
      WHERE tenant_id = $1
      LIMIT 1
    `,
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
  };
}

export async function upsertBusinessBrain(tenantId, brain = {}) {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }

  const products = normalizeJson(brain.products, []);
  const faqs = normalizeJson(brain.faqs, []);
  const hours = normalizeJson(brain.hours, {});
  const rules = normalizeJson(brain.rules, []);

  if (!Array.isArray(products) || !Array.isArray(faqs) || !Array.isArray(rules)) {
    throw new Error("Business Brain lists must be arrays");
  }

  if (typeof hours !== "object" || Array.isArray(hours)) {
    throw new Error("Business Brain hours must be an object");
  }

  const result = await dbPool.query(
    `
      INSERT INTO tenant_business_brain (
        tenant_id, business_name, category, description, products, faqs,
        hours, location, contact, ai_tone, ai_language, custom_instructions, rules
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb)
      ON CONFLICT (tenant_id)
      DO UPDATE SET
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
        updated_at = NOW()
      RETURNING tenant_id
    `,
    [
      tenantId,
      normalizeText(brain.businessName),
      normalizeText(brain.category),
      normalizeText(brain.description),
      JSON.stringify(products.slice(0, MAX_LIST_ITEMS)),
      JSON.stringify(faqs.slice(0, MAX_LIST_ITEMS)),
      JSON.stringify(hours),
      normalizeText(brain.location),
      normalizeText(brain.contact),
      normalizeText(brain.aiTone),
      normalizeText(brain.aiLanguage),
      normalizeText(brain.customInstructions),
      JSON.stringify(rules.slice(0, MAX_LIST_ITEMS)),
    ],
  );

  return Boolean(result.rows[0]);
}
