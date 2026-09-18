import { dbPool, isDatabaseConfigured } from "../config/database.js";

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}

function validId(value) {
  return typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value);
}

function normalizeLimit(value) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 100) : 50;
}

function normalizeOffset(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 10000) : 0;
}

export async function listConversations(tenantId, { search = "", status = "", tag = "", limit = 50, offset = 0 } = {}) {
  assertDatabase();
  if (!validId(tenantId)) throw new Error("Invalid tenant ID");

  const params = [tenantId];
  const where = ["c.tenant_id = $1"];
  if (status) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  if (tag) {
    params.push(tag.trim().slice(0, 100));
    where.push(`EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.tenant_id = c.tenant_id AND ct.conversation_id = c.id AND ct.tag = $${params.length})`);
  }
  if (search.trim()) {
    params.push(`%${search.trim().slice(0, 200)}%`);
    where.push(`(co.wa_id ILIKE $${params.length} OR COALESCE(co.display_name, '') ILIKE $${params.length})`);
  }

  const limitValue = normalizeLimit(limit);
  const offsetValue = normalizeOffset(offset);
  params.push(limitValue, offsetValue);

  const result = await dbPool.query(
    `SELECT c.id, c.status, c.priority, c.unread_count, c.last_message_at,
            c.assigned_user_id, c.free_until,
            co.id AS contact_id, co.wa_id, co.display_name,
            wn.phone_number_id, wn.display_name AS whatsapp_display_name,
            COALESCE(array_agg(DISTINCT ct.tag) FILTER (WHERE ct.tag IS NOT NULL), '{}') AS tags
     FROM conversations c
     JOIN contacts co ON co.tenant_id = c.tenant_id AND co.id = c.contact_id
     JOIN whatsapp_numbers wn ON wn.tenant_id = c.tenant_id AND wn.id = c.whatsapp_number_id
     LEFT JOIN conversation_tags ct ON ct.tenant_id = c.tenant_id AND ct.conversation_id = c.id
     WHERE ${where.join(" AND ")}
     GROUP BY c.id, co.id, wn.id
     ORDER BY c.unread_count DESC, c.priority DESC, c.last_message_at DESC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return result.rows;
}

export async function getConversationMessages(tenantId, conversationId, { limit = 100, offset = 0 } = {}) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId)) throw new Error("Invalid conversation identifier");
  const limitValue = normalizeLimit(limit);
  const offsetValue = normalizeOffset(offset);

  const result = await dbPool.query(
    `SELECT id, whatsapp_message_id, direction, message_type, text, status, created_at
     FROM messages
     WHERE tenant_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [tenantId, conversationId, limitValue, offsetValue],
  );
  return result.rows;
}

export async function updateConversation(tenantId, conversationId, { status, priority, assignedUserId } = {}) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId)) throw new Error("Invalid conversation identifier");

  const fields = [];
  const params = [tenantId, conversationId];
  if (status !== undefined) {
    if (!["active", "paused", "human", "archived"].includes(status)) throw new Error("Invalid conversation status");
    params.push(status); fields.push(`status = $${params.length}`);
    if (status === "archived") fields.push("archived_at = NOW()");
    else fields.push("archived_at = NULL");
  }
  if (priority !== undefined) {
    const value = Number(priority);
    if (!Number.isInteger(value) || value < 0 || value > 5) throw new Error("Invalid priority");
    params.push(value); fields.push(`priority = $${params.length}`);
  }
  if (assignedUserId !== undefined) {
    if (assignedUserId !== null && !validId(assignedUserId)) throw new Error("Invalid assigned user");
    params.push(assignedUserId); fields.push(`assigned_user_id = $${params.length}`);
  }
  if (!fields.length) throw new Error("No conversation changes supplied");
  fields.push("updated_at = NOW()");

  const result = await dbPool.query(
    `UPDATE conversations SET ${fields.join(", ")}
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, status, priority, unread_count, assigned_user_id, archived_at`,
    params,
  );
  if (!result.rows[0]) return null;
  return result.rows[0];
}

export async function markConversationRead(tenantId, conversationId) {
  assertDatabase();
  const result = await dbPool.query(
    `UPDATE conversations SET unread_count = 0, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING id, unread_count`,
    [tenantId, conversationId],
  );
  return result.rows[0] || null;
}

export async function addConversationNote(tenantId, conversationId, authorUserId, body) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId) || !validId(authorUserId)) throw new Error("Invalid identifier");
  if (typeof body !== "string" || !body.trim() || body.length > 4000) throw new Error("Invalid note");

  const result = await dbPool.query(
    `INSERT INTO conversation_notes (tenant_id, conversation_id, author_user_id, body)
     SELECT $1, c.id, $3, $4
     FROM conversations c
     WHERE c.tenant_id = $1 AND c.id = $2
       AND EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = $1 AND u.id = $3 AND u.status = 'active')
     RETURNING id, conversation_id, author_user_id, body, created_at`,
    [tenantId, conversationId, authorUserId, body.trim()],
  );
  if (!result.rows[0]) throw new Error("Conversation or author not found");
  return result.rows[0];
}

export async function setConversationTags(tenantId, conversationId, tags = []) {
  assertDatabase();
  if (!validId(tenantId) || !validId(conversationId)) throw new Error("Invalid conversation identifier");
  if (!Array.isArray(tags) || tags.length > 50) throw new Error("Invalid tags");

  const normalized = [...new Set(tags.map((tag) => String(tag).trim().slice(0, 100)).filter(Boolean))];

  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, conversationId]);
    if (!exists.rowCount) throw new Error("Conversation not found");
    await client.query("DELETE FROM conversation_tags WHERE tenant_id = $1 AND conversation_id = $2", [tenantId, conversationId]);
    for (const tag of normalized) {
      await client.query(
        `INSERT INTO conversation_tags (tenant_id, conversation_id, tag)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [tenantId, conversationId, tag],
      );
    }
    await client.query("COMMIT");
    return normalized;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
