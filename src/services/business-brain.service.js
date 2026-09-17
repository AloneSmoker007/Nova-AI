import Joi from "joi";
import { dbPool, isDatabaseConfigured } from "../config/database.js";
import logger from "../config/logger.js";

const MAX_TEXT_LENGTH = 4000;
const MAX_LIST_ITEMS = 100;

const businessBrainSchema = Joi.object({
  businessName: Joi.string().allow("", null).max(4000),
  category: Joi.string().allow("", null).max(4000),
  description: Joi.string().allow("", null).max(4000),
  location: Joi.string().allow("", null).max(4000),
  contact: Joi.string().allow("", null).max(4000),
  aiTone: Joi.string().allow("", null).max(200),
  aiLanguage: Joi.string().allow("", null).max(100),
  customInstructions: Joi.string().allow("", null).max(4000),
  products: Joi.array().max(MAX_LIST_ITEMS).items(
    Joi.alternatives().try(
      Joi.string().max(200),
      Joi.object({
        name: Joi.string().max(200),
        title: Joi.string().max(200),
        price: Joi.string().max(100),
        description: Joi.string().max(1000),
      }),
    ),
  ).default([]),
  faqs: Joi.array().max(MAX_LIST_ITEMS).items(
    Joi.alternatives().try(
      Joi.string().max(2000),
      Joi.object({
        question: Joi.string().max(500),
        q: Joi.string().max(500),
        answer: Joi.string().max(2000),
        a: Joi.string().max(2000),
      }),
    ),
  ).default([]),
  hours: Joi.object().pattern(
    /^[a-zA-Z0-9 _-]{1,30}$/,
    Joi.string().max(200),
  ).default({}),
  rules: Joi.array().max(MAX_LIST_ITEMS).items(
    Joi.alternatives().try(
      Joi.string().max(500),
      Joi.object({
        rule: Joi.string().max(500),
        text: Joi.string().max(500),
      }),
    ),
  ).default([]),
}).unknown(true);

export function validateBusinessBrain(input) {
  const { error, value } = businessBrainSchema.validate(input, { abortEarly: false });
  if (error) {
    throw new Error(`Invalid Business Brain input: ${error.message}`);
  }
  return value;
}

function normalizeText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT_LENGTH) : null;
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

  const validated = validateBusinessBrain(brain);

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
      normalizeText(validated.businessName),
      normalizeText(validated.category),
      normalizeText(validated.description),
      JSON.stringify(validated.products.slice(0, MAX_LIST_ITEMS)),
      JSON.stringify(validated.faqs.slice(0, MAX_LIST_ITEMS)),
      JSON.stringify(validated.hours),
      normalizeText(validated.location),
      normalizeText(validated.contact),
      normalizeText(validated.aiTone),
      normalizeText(validated.aiLanguage),
      normalizeText(validated.customInstructions),
      JSON.stringify(validated.rules.slice(0, MAX_LIST_ITEMS)),
    ],
  );

  logger.info({ tenantId }, "Upserted Business Brain successfully");
  return Boolean(result.rows[0]);
}
