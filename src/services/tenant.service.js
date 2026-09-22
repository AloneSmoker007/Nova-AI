import { dbPool, isDatabaseConfigured } from "../config/database.js";

/**
 * Resolve the Nova-AI tenant from Meta's WhatsApp phone_number_id.
 *
 * The phone_number_id is the tenant routing key. No caller-supplied
 * tenant identifier is trusted for webhook processing.
 */
export async function resolveTenantByPhoneNumberId(phoneNumberId) {
  if (!isDatabaseConfigured() || !dbPool) {
    throw new Error("Database is not configured");
  }

  if (
    typeof phoneNumberId !== "string" ||
    !/^\d{5,30}$/.test(phoneNumberId)
  ) {
    return null;
  }

  const result = await dbPool.query(
    `
      SELECT
        wn.id AS whatsapp_number_id,
        wn.tenant_id,
        wn.phone_number_id,
        wn.access_token_encrypted,
        wn.display_name,
        wn.status AS whatsapp_status,
        t.name AS tenant_name,
        t.status AS tenant_status
      FROM whatsapp_numbers AS wn
      INNER JOIN tenants AS t
        ON t.id = wn.tenant_id
      WHERE wn.phone_number_id = $1
      LIMIT 1
    `,
    [phoneNumberId],
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  if (row.whatsapp_status !== "active" || row.tenant_status !== "active") {
    return null;
  }

  return {
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    whatsappNumberId: row.whatsapp_number_id,
    phoneNumberId: row.phone_number_id,
    accessTokenEncrypted: row.access_token_encrypted,
    displayName: row.display_name,
  };
}

export async function isTenantActive(tenantId) {
  if (!isDatabaseConfigured() || !dbPool) {
    return false;
  }

  if (!tenantId || typeof tenantId !== "string") {
    return false;
  }

  try {
    const result = await dbPool.query(
      `SELECT status FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );

    return result.rows[0]?.status === "active";
  } catch {
    return false;
  }
}

export async function isUserActive(userId, tenantId) {
  if (!isDatabaseConfigured() || !dbPool) {
    return false;
  }

  if (
    !userId ||
    typeof userId !== "string" ||
    !tenantId ||
    typeof tenantId !== "string"
  ) {
    return false;
  }

  try {
    const result = await dbPool.query(
      `SELECT status
       FROM users
       WHERE id = $1 AND tenant_id = $2
       LIMIT 1`,
      [userId, tenantId],
    );

    return result.rows[0]?.status === "active";
  } catch {
    return false;
  }
}
