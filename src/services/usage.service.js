import { dbPool, isDatabaseConfigured } from "../config/database.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

function assertDatabase() {
  if (!isDatabaseConfigured() || !dbPool) throw new Error("Database is not configured");
}

function validTenantId(value) {
  return typeof value === "string" && value.trim() !== "";
}

export async function registerInboundUsage({
  tenantId,
  conversationId,
  messageId,
  whatsappMessageId,
  occurredAt = new Date(),
  eventType = "inbound_message",
}) {
  assertDatabase();
  if (!validTenantId(tenantId) || !validTenantId(conversationId) || !validTenantId(messageId)) {
    throw new Error("Missing usage identifiers");
  }

  const eventTime = new Date(occurredAt);
  if (Number.isNaN(eventTime.getTime())) throw new Error("Invalid usage timestamp");

  const eventKey = `${eventType}:${whatsappMessageId || messageId}`;
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN");

    const conversation = await client.query(
      `SELECT id, free_until
       FROM conversations
       WHERE tenant_id = $1 AND id = $2
       FOR UPDATE`,
      [tenantId, conversationId],
    );
    if (!conversation.rows[0]) throw new Error("Conversation not found");

    const existingEvent = await client.query(
      `SELECT id FROM usage_events
       WHERE tenant_id = $1 AND event_key = $2
       LIMIT 1`,
      [tenantId, eventKey],
    );

    if (existingEvent.rowCount > 0) {
      await client.query("COMMIT");
      return { duplicate: true, countedConversation: false, windowExpiresAt: conversation.rows[0].free_until };
    }

    const previousExpiry = conversation.rows[0].free_until
      ? new Date(conversation.rows[0].free_until)
      : null;
    const windowActive = previousExpiry && previousExpiry.getTime() > eventTime.getTime();
    const windowStartedAt = windowActive
      ? new Date(previousExpiry.getTime() - WINDOW_MS)
      : eventTime;
    const windowExpiresAt = new Date(windowStartedAt.getTime() + WINDOW_MS);

    let countedConversation = false;

    if (!windowActive) {
      const windowResult = await client.query(
        `INSERT INTO conversation_windows (
           tenant_id, conversation_id, window_started_at, window_expires_at, source_message_id
         )
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, conversation_id, window_started_at) DO NOTHING
         RETURNING id`,
        [tenantId, conversationId, windowStartedAt, windowExpiresAt, messageId],
      );
      countedConversation = windowResult.rowCount === 1;
    }

    await client.query(
      `INSERT INTO usage_events (
         tenant_id, conversation_id, message_id, event_type, event_key, units, created_at
       )
       VALUES ($1, $2, $3, $4, $5, 1, $6)
       ON CONFLICT (tenant_id, event_key) DO NOTHING`,
      [tenantId, conversationId, messageId, eventType, eventKey, eventTime],
    );

    await client.query(
      `UPDATE conversations
       SET conversation_started_at = COALESCE(conversation_started_at, $3),
           free_until = $4,
           last_message_at = GREATEST(COALESCE(last_message_at, $3), $3),
           updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, conversationId, windowStartedAt, windowExpiresAt],
    );

    await client.query("COMMIT");
    return { duplicate: false, countedConversation, windowStartedAt, windowExpiresAt };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getUsageSummary(tenantId, { monthStart = null } = {}) {
  assertDatabase();
  if (!validTenantId(tenantId)) throw new Error("Invalid tenant ID");

  const start = monthStart ? new Date(monthStart) : new Date();
  if (!monthStart) start.setUTCDate(1), start.setUTCHours(0, 0, 0, 0);
  if (Number.isNaN(start.getTime())) throw new Error("Invalid monthStart");

  const result = await dbPool.query(
    `SELECT
       COALESCE((SELECT COUNT(*) FROM conversation_windows cw
         WHERE cw.tenant_id = $1 AND cw.created_at >= $2), 0)::int AS conversations,
       COALESCE(SUM(CASE WHEN ue.event_type = 'ai_message' THEN ue.units ELSE 0 END), 0)::int AS ai_messages,
       COALESCE(SUM(CASE WHEN ue.event_type = 'media_message' THEN ue.units ELSE 0 END), 0)::int AS media_messages
     FROM usage_events ue
     WHERE ue.tenant_id = $1 AND ue.created_at >= $2`,
    [tenantId, start],
  );

  const plan = await dbPool.query(
    `SELECT monthly_conversation_limit, monthly_ai_message_limit,
            monthly_media_limit, warning_percent, hard_limit_enabled
     FROM tenant_usage_plans WHERE tenant_id = $1`,
    [tenantId],
  );

  const row = result.rows[0];
  const limits = plan.rows[0] || {
    monthly_conversation_limit: 1000,
    monthly_ai_message_limit: 5000,
    monthly_media_limit: 1000,
    warning_percent: 80,
    hard_limit_enabled: true,
  };

  return { periodStart: start, usage: {
    conversations: Number(row.conversations),
    aiMessages: Number(row.ai_messages),
    mediaMessages: Number(row.media_messages),
  }, limits };
}

export async function isUsageAllowed(tenantId, type = "conversations") {
  const summary = await getUsageSummary(tenantId);
  const key = type === "ai_messages" ? "aiMessages" : type === "media_messages" ? "mediaMessages" : "conversations";
  const limitKey = type === "ai_messages"
    ? "monthly_ai_message_limit"
    : type === "media_messages" ? "monthly_media_limit" : "monthly_conversation_limit";
  const used = summary.usage[key];
  const limit = Number(summary.limits[limitKey]);
  return {
    allowed: !summary.limits.hard_limit_enabled || used < limit,
    used,
    limit,
    percent: limit > 0 ? Math.round((used / limit) * 100) : 100,
    warning: limit > 0 && used >= Math.ceil(limit * (Number(summary.limits.warning_percent) / 100)),
  };
}
