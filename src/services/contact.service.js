import { dbPool } from "../config/database.js";
export async function listContacts(tenantId, { search = "", limit = 50, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const term = typeof search === "string" ? search.trim() : "";
  const result = await dbPool.query(
    `SELECT c.id, c.wa_id, c.display_name, c.created_at, c.updated_at,
            COUNT(DISTINCT cv.id)::int AS conversation_count,
            MAX(cv.last_message_at) AS last_message_at
       FROM contacts c
       LEFT JOIN conversations cv ON cv.tenant_id = c.tenant_id AND cv.contact_id = c.id
      WHERE c.tenant_id = $1
        AND ($2 = '' OR c.display_name ILIKE '%' || $2 || '%' OR c.wa_id ILIKE '%' || $2 || '%')
      GROUP BY c.id
      ORDER BY COALESCE(MAX(cv.last_message_at), c.updated_at) DESC
      LIMIT $3 OFFSET $4`, [tenantId, term, safeLimit, safeOffset]);
  return result.rows;
}
